import type { EnumDecl, ParsedFile, ParsedToolClass } from "./classTree.js";

/** A public operation confiqure can't reach — no Spring mapping and not a browser operation — is an error. */
export function lintToolClasses(classes: ParsedToolClass[]): string[] {
  const out: string[] = [];
  for (const tc of classes) {
    for (const op of tc.operations) {
      if (!op.browser && !op.path) {
        out.push(`${tc.sourceFile}: operation \`${op.name}\` has no Spring mapping (@PostMapping/@GetMapping/…) and is not @Confiqure.Browser — confiqure cannot call it.`);
      }
    }
  }
  return out;
}

/**
 * Annotation 3.0 gate: the pre-3.0 forms are ERRORS, not warnings — `push` prints them and stops
 * before uploading. The class-level `@Confiqure(...)` / bare `@Confiqure` marker and a method-level
 * `@Confiqure.Tool` no longer compile against annotation 3.0.0, and the backend refuses an object
 * without a 3.0 kind; saying so here names the file and the replacement. Comments are stripped
 * first so a Javadoc that mentions the old form is not an error.
 */
export function lintSources(files: { filePath: string; source: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const src = stripComments(f.source);
    if (/@Confiqure\b(?!\s*\.)/.test(src)) {
      out.push(`${f.filePath}: \`@Confiqure(...)\` on a class is not supported since annotation 3.0 — use @Confiqure.Setting / @Confiqure.List / @Confiqure.User.Setting / @Confiqure.User.List (or @Confiqure.Facts).`);
    }
    if (hasMethodLevelTool(src)) {
      out.push(`${f.filePath}: \`@Confiqure.Tool\` on a method is not supported since annotation 3.0 — declare a tool CLASS (annotate the class) and make the method a public operation.`);
    }
  }
  return out;
}

/**
 * True when some `@Confiqure.Tool` annotates a method rather than a type: the declaration it heads
 * (the text up to the next `{` or `;`, after the annotation's own arguments) names no
 * class/interface/record/enum.
 */
function hasMethodLevelTool(src: string): boolean {
  const re = /@Confiqure\s*\.\s*Tool\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "(") i = skipBalanced(src, i);
    const end = src.slice(i).search(/[{;]/);
    const head = end < 0 ? src.slice(i) : src.slice(i, i + end);
    if (!/\b(class|interface|record|enum)\b/.test(head)) return true;
  }
  return false;
}

/** Index just past the parenthesized group opening at `open`. */
function skipBalanced(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i + 1;
  }
  return src.length;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"])\/\/[^\n]*/g, "$1");
}

/**
 * Push-time lint over the parsed Java bundle (issue #83). Two source smells that a tool resolving
 * a type by its SIMPLE NAME can't see through — and that bit confiqure's green-test in prod
 * (conv 101: a field's inner `FloorMethod` enum collided with a divergent top-level `FloorMethod`,
 * so a valid `MARGIN_PERCENT` was validated against the wrong constant set and rejected):
 *
 *   (a) two or more enums share a simple name but have DIFFERENT constant sets in one bundle;
 *   (b) a field default references an enum constant that isn't in the enum the field resolves to
 *       (resolved with Java scoping — a nested enum shadows a same-named top-level one).
 *
 * Returns human-readable warning lines (no styling); the caller prefixes/▲-colors them. These are
 * advisory — they never block a push. Java-only (the only language tree-sitter currently parses).
 */
export function lintBundle(parsed: ParsedFile[]): string[] {
  const warnings: string[] = [];
  const enums: (EnumDecl & { file: string })[] = parsed.flatMap((pf) =>
    pf.enums.map((e) => ({ ...e, file: pf.filePath }))
  );

  warnings.push(...divergentSameNameEnums(enums));
  warnings.push(...defaultsReferencingAbsentConstant(parsed, enums));
  warnings.push(...endpointExtendsMissingBase(parsed));
  return warnings;
}

/**
 * (#140) A `@Confiqure` endpoint that `extends` a base whose source isn't in this push. The scan
 * follows `extends`, but only into files it can see — a base outside the configured scanPaths is
 * silently dropped, so its inherited config fields never reach the chat model OR the save/complete
 * gates. Warn so the developer widens scanPaths rather than shipping a half-visible endpoint.
 */
function endpointExtendsMissingBase(parsed: ParsedFile[]): string[] {
  const known = new Set<string>();
  for (const pf of parsed) for (const d of pf.declarations) known.add(d.name);
  const out: string[] = [];
  for (const pf of parsed) {
    for (const d of pf.declarations) {
      if (!d.hasConfiqureAnnotation || !d.superclassName) continue;
      if (known.has(d.superclassName)) continue;
      out.push(
        `@Confiqure object ${d.name} extends ${d.superclassName}, but ${d.superclassName}'s source ` +
          `isn't in this push — its inherited fields will be invisible to the chat and the ` +
          `save/complete gates. Make sure ${d.superclassName} is under a scanPath.`
      );
    }
  }
  return out;
}

/** (a) Same simple name, different constants — the simple-name collision that breaks resolution. */
function divergentSameNameEnums(enums: (EnumDecl & { file: string })[]): string[] {
  const out: string[] = [];
  const byName = new Map<string, (EnumDecl & { file: string })[]>();
  for (const e of enums) {
    const list = byName.get(e.name) ?? [];
    list.push(e);
    byName.set(e.name, list);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const signatures = new Set(list.map((e) => signature(e.constants)));
    if (signatures.size <= 1) continue; // identical copies aren't a divergence
    const variants = list.map((e) => `${label(e)} {${e.constants.join(", ")}}`).join("  vs  ");
    out.push(
      `Two or more enums named '${name}' have different constants in this bundle: ${variants}. ` +
        `A type resolved by simple name can bind the wrong one — consolidate to a single canonical ` +
        `'${name}', or rename the divergent one.`
    );
  }
  return out;
}

/** (b) A field default whose referenced constant isn't in the enum the field actually resolves to. */
function defaultsReferencingAbsentConstant(
  parsed: ParsedFile[],
  enums: (EnumDecl & { file: string })[]
): string[] {
  const out: string[] = [];
  const byName = new Map<string, (EnumDecl & { file: string })[]>();
  for (const e of enums) {
    const list = byName.get(e.name) ?? [];
    list.push(e);
    byName.set(e.name, list);
  }

  for (const pf of parsed) {
    for (const decl of pf.declarations) {
      if (decl.kind !== "class" && decl.kind !== "record") continue;
      for (const field of decl.fields) {
        const ref = parseConstantRef(field.initializer, field.typeNames[0] ?? field.typeText);
        if (!ref) continue;
        const candidates = byName.get(ref.enumName);
        if (!candidates || candidates.length === 0) continue; // not a (known) enum default — skip

        const resolved = resolveEnum(candidates, decl.name);
        if (!resolved) continue; // genuinely ambiguous — (a) already flags the duplicate
        if (resolved.constants.includes(ref.constant)) continue; // valid

        out.push(
          `${decl.name}.${field.name} defaults to ${ref.enumName}.${ref.constant}, but ${ref.constant} ` +
            `is not a constant of the resolved enum ${label(resolved)} {${resolved.constants.join(", ")}}.`
        );
      }
    }
  }
  return out;
}

/**
 * Resolve a same-name enum set against a field's enclosing class, mirroring Java scoping: an enum
 * declared inside that class wins; otherwise a unique top-level enum; otherwise (still ambiguous)
 * null so we don't guess.
 */
function resolveEnum(
  candidates: (EnumDecl & { file: string })[],
  enclosingClass: string
): (EnumDecl & { file: string }) | null {
  const scoped = candidates.filter((c) => c.enclosingTypes.includes(enclosingClass));
  if (scoped.length === 1) return scoped[0];
  if (scoped.length > 1) return null;
  const topLevel = candidates.filter((c) => c.enclosingTypes.length === 0);
  if (topLevel.length === 1) return topLevel[0];
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Read an enum-constant reference from a field initializer. Handles the qualified form
 * `Enum.CONSTANT` and a bare `CONSTANT` (static import / same-enum), the latter only when the
 * field's declared type names the enum. Anything else (method calls, `new`, expressions) → null.
 */
function parseConstantRef(
  initializer: string | null,
  fieldType: string
): { enumName: string; constant: string } | null {
  if (!initializer) return null;
  const init = initializer.trim();
  const qualified = init.match(/^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)$/);
  if (qualified) return { enumName: qualified[1], constant: qualified[2] };
  const bare = init.match(/^([A-Z][A-Z0-9_]*)$/); // SCREAMING_CASE → plausibly an enum constant
  if (bare && /^[A-Za-z_]\w*$/.test(fieldType)) return { enumName: fieldType, constant: bare[1] };
  return null;
}

function signature(constants: string[]): string {
  return [...new Set(constants)].sort().join(",");
}

/** Qualified label for an enum declaration: `Outer.Name` when nested, else `Name (file)`. */
function label(e: EnumDecl & { file: string }): string {
  return e.enclosingTypes.length > 0 ? `${e.enclosingTypes.join(".")}.${e.name}` : `${e.name} (${e.file})`;
}
