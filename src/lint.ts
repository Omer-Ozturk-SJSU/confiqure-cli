import type { EnumDecl, ParsedFile } from "./classTree.js";

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
  return warnings;
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
