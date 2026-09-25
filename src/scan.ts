import fastGlob from "fast-glob";
import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { extname, basename } from "node:path";
import { ProjectConfig } from "./config.js";
import { gitHashObject } from "./git.js";
import { endpointIdentity } from "./identity.js";
import {
  parseJavaFiles,
  buildClassTrees,
  collectToolReachableFiles,
  ClassTree,
  ObjectKind,
  ParsedDecl,
  ParsedToolClass,
} from "./classTree.js";
import { lintBundle, lintSources, lintToolClasses } from "./lint.js";

export type { ObjectKind } from "./classTree.js";

export interface DiscoveredClass {
  /** Stable identity. V1: relative file path. */
  classUniqueId: string;
  /** Top-level class name. */
  className: string;
  /**
   * Resolved address: the annotation's `end`, else `/<snake_case class name>` (FACTS:
   * `/facts/<snake_case>`). 3.0 has no default endpoint, so an end-less object never claims "/".
   * Null for a tool class — it has no address.
   */
  configEnd: string | null;
  /** Which 3.0 object annotation the class carries, or TOOL_CLASS for a `@Confiqure.Tool` class. */
  objectKind: ObjectKind | "TOOL_CLASS";
  /** The `@Confiqure.Identity` field of a List object, else null. */
  identityField: string | null;
  /** The `callback` of a `@Confiqure.Facts` class, else null. */
  callback: string | null;
  /** Path relative to project root. */
  filePath: string;
  /** Source language matching one of the config keys. */
  language: string;
  /** Git blob SHA computed via `git hash-object`. */
  gitSha: string;
  /**
   * Files transitively reachable from this annotated root via the field-type
   * graph — includes the root file itself. For Java this is populated from
   * the tree-sitter walk; for other languages it currently contains only the
   * root file (the legacy keyword-scan behavior).
   */
  relatedFiles: string[];
  /** Class names walked during reachability (for shell logging). */
  visitedClasses: string[];
}

/** The source file of a `@Confiqure.Tool` class. */
export interface ToolFile {
  filePath: string;
  gitSha: string;
}

export interface ScanResult {
  /**
   * Every pushable class: the object roots (one per 3.0 object annotation) AND the tool classes
   * (`objectKind` TOOL_CLASS). Both are diffed against the registry by classUniqueId + gitSha.
   */
  annotated: DiscoveredClass[];
  /** Source files of the `@Confiqure.Tool` classes. */
  toolFiles: ToolFile[];
  /**
   * Files containing a `@Confiqure.DefaultCallbackHook` method. Shipped in the
   * upload bundle so the Composer can discover the workspace's callback hook
   * path — even when the hook lives in a controller that is neither a
   * `@Confiqure` root nor a `@Confiqure.Tool` controller (which the scan would
   * otherwise never upload).
   */
  hookFiles: ToolFile[];
  /** Every `@Confiqure.Tool` class with its operations. */
  toolClasses: ParsedToolClass[];
  /** All scanned files keyed by relative path → content. */
  allFiles: Map<string, string>;
  /** Language with the most annotated roots. */
  primaryLanguage: string;
  /**
   * Union of every root's reachableFiles. Used by `push` as the manifest's
   * upload set so we don't ship unrelated files in scanPaths.
   */
  reachableFiles: Set<string>;
  /**
   * Files reachable from TOOL signatures (input DTO + return type graphs).
   * Without these the Composer can't derive a tool's input schema when its
   * DTO lives in a file no `@Confiqure` root references.
   */
  toolReachableFiles: Set<string>;
  /**
   * Annotation-3.0 errors (pre-3.0 forms, uncallable tool operations). Non-empty → `push` prints
   * them and stops before uploading.
   */
  errors: string[];
}

interface LangBucket {
  extensions: string[];
  tokenPattern: string;
  langKey: string;
}

export async function scanProject(cwd: string, config: ProjectConfig): Promise<ScanResult> {
  const buckets: LangBucket[] = Object.entries(config.languages).map(([langKey, lang]) => ({
    extensions: lang.extensions,
    tokenPattern: lang.tokenPattern,
    langKey,
  }));

  const allExtensions = new Set<string>();
  buckets.forEach((b) => b.extensions.forEach((e) => allExtensions.add(e)));

  const patterns = config.scanPaths.flatMap((p) =>
    Array.from(allExtensions).map((ext) => `${p}/**/*${ext}`)
  );

  const ignorePatterns = config.ignore.map((d) => `**/${d}/**`);

  const globbed = await fastGlob(patterns, {
    cwd,
    ignore: ignorePatterns,
    absolute: false,
    onlyFiles: true,
    dot: false,
  });

  // #141: never scan test sources. Test classes are never config endpoints, yet they leaked into
  // the upload bundle (a `*Test` referencing `@Tool` tripped the tool-file substring check) and
  // then into every endpoint's nested map — ~25k tokens of noise per chat turn. Drop them here so
  // they never enter reachability, upload, or the nested map. Matches the Maven/Gradle `src/test/`
  // convention (not a bare `/test/`, which would wrongly catch a legitimate `test/` config domain).
  const files = globbed.filter((p) => !isTestPath(p));
  const droppedTests = globbed.length - files.length;
  if (droppedTests > 0) {
    console.log(chalk.dim(`Excluded ${droppedTests} test source${droppedTests === 1 ? "" : "s"} (src/test/) from the scan.`));
  }

  const allFiles = new Map<string, string>();
  const fileLanguage = new Map<string, string>();
  for (const filePath of files) {
    const content = await readFile(`${cwd}/${filePath}`, "utf8");
    allFiles.set(filePath, content);
    const ext = extname(filePath);
    const bucket = buckets.find((b) => b.extensions.includes(ext));
    if (bucket) fileLanguage.set(filePath, bucket.langKey);
  }

  // ── Java: tree-sitter reachability ────────────────────────────────────
  // For Java we parse every file and walk the field-type graph from each
  // `@Confiqure` root. The walk subsumes nested `@Confiqure` classes (e.g.
  // a `PushPreferences` field on `NotificationPreferences`) so they don't
  // show up as duplicate endpoints. For all other languages we fall back
  // to the original keyword scan — those grammars will be wired later.

  const javaTrees: ClassTree[] = [];
  const javaFiles = new Map<string, string>();
  for (const [p, content] of allFiles) {
    if (fileLanguage.get(p) === "java") javaFiles.set(p, content);
  }

  const annotated: DiscoveredClass[] = [];
  const toolFiles: ToolFile[] = [];
  const hookFiles: ToolFile[] = [];
  const toolClasses: ParsedToolClass[] = [];
  const reachableFiles = new Set<string>();
  const toolReachableFiles = new Set<string>();
  const declByName = new Map<string, ParsedDecl>();
  const errors = lintSources(
    Array.from(allFiles, ([filePath, source]) => ({ filePath, source })).filter((f) => fileLanguage.has(f.filePath))
  );

  // One tree-sitter pass serves endpoint reachability, tool detection, AND
  // tool-signature reachability (the input DTO graph the Composer needs to
  // derive a tool's input schema — previously never shipped unless an
  // endpoint happened to reference the same type).
  if (javaFiles.size > 0) {
    const parsed = await parseJavaFiles(javaFiles);
    const { trees } = buildClassTrees(parsed);
    javaTrees.push(...trees);
    for (const pf of parsed) {
      for (const d of pf.declarations) if (!declByName.has(d.name)) declByName.set(d.name, d);
      toolClasses.push(...pf.toolClasses);
      const src = allFiles.get(pf.filePath) ?? "";
      if (pf.toolClasses.length > 0) {
        const gitSha = await gitHashObject(pf.filePath, cwd).catch(() => "");
        toolFiles.push({ filePath: pf.filePath, gitSha });
        reachableFiles.add(pf.filePath);
      }
      // A @Confiqure.DefaultCallbackHook can live in any controller — detect it
      // independently of tools/roots so the hook file always reaches the Composer.
      if (fileHasCallbackHook(src)) {
        const gitSha = await gitHashObject(pf.filePath, cwd).catch(() => "");
        hookFiles.push({ filePath: pf.filePath, gitSha });
      }
    }
    for (const f of collectToolReachableFiles(parsed, toolClasses)) {
      toolReachableFiles.add(f);
    }
    // A tool class is pushed like an object: its identity covers the class file + every DTO its
    // operations reach, so a DTO edit re-versions the tool class.
    for (const tc of toolClasses) {
      const reach = Array.from(new Set([tc.sourceFile, ...collectToolReachableFiles(parsed, [tc])]));
      const fileShas = await Promise.all(
        reach.map(async (p) => ({ path: p, sha: await gitHashObject(p, cwd).catch(() => "") }))
      );
      annotated.push({
        classUniqueId: tc.classUniqueId,
        className: tc.className,
        configEnd: null,
        objectKind: "TOOL_CLASS",
        identityField: null,
        callback: null,
        filePath: tc.sourceFile,
        language: "java",
        gitSha: endpointIdentity(fileShas),
        relatedFiles: reach,
        visitedClasses: [tc.className],
      });
    }
    errors.push(...lintToolClasses(toolClasses));

    // Push-time lint (#83): warn on simple-name enum collisions / bad enum defaults the host can't
    // see but a name-based resolver trips over. Advisory only — never blocks the push.
    for (const warning of lintBundle(parsed)) {
      console.warn(chalk.yellow("⚠"), warning);
    }
  }

  for (const tree of javaTrees) {
    const content = allFiles.get(tree.rootFile) ?? "";
    const className = tree.rootClass;
    const decl = declByName.get(className);
    const ann = objectAnnotation(content);
    const objectKind = decl?.objectKind ?? ann?.kind;
    if (!objectKind) continue; // buildClassTrees roots only 3.0 objects; defensive
    const configEnd = resolveConfigEnd(decl?.objectEnd ?? ann?.end ?? null, objectKind, className);
    // #40: the endpoint identity must cover its FULL nested type graph (root + every reachable
    // DTO), not just the root file — otherwise a change confined to a nested DTO leaves the root
    // byte-identical, the diff reports UNCHANGED, and no new schema version is cut (host ⇄ confiqure
    // drift). Hash every reachable file's blob SHA; a single-file endpoint keeps its plain blob SHA
    // (endpointIdentity), so only endpoints that actually have nested types re-version once.
    const reach = Array.from(new Set<string>([tree.rootFile, ...tree.reachableFiles]));
    const fileShas = await Promise.all(
      reach.map(async (p) => ({ path: p, sha: await gitHashObject(p, cwd).catch(() => "") }))
    );
    const gitSha = endpointIdentity(fileShas);
    annotated.push({
      classUniqueId: tree.rootFile,
      className,
      configEnd,
      objectKind,
      identityField: decl?.identityField ?? null,
      callback: objectKind === "FACTS" ? decl?.objectCallback ?? ann?.callback ?? null : null,
      filePath: tree.rootFile,
      language: "java",
      gitSha,
      relatedFiles: Array.from(tree.reachableFiles),
      visitedClasses: tree.visitedClasses,
    });
    for (const f of tree.reachableFiles) reachableFiles.add(f);
  }

  // ── Non-Java: legacy keyword scan ─────────────────────────────────────
  for (const [filePath, content] of allFiles) {
    const langKey = fileLanguage.get(filePath);
    if (!langKey || langKey === "java") continue;
    const bucket = buckets.find((b) => b.langKey === langKey);
    if (!bucket || !content.includes(bucket.tokenPattern)) continue;
    const ann = objectAnnotation(content);
    if (!ann) continue; // no 3.0 object annotation (a pre-3.0 form is reported by lintSources)

    const ext = extname(filePath);
    const className = basename(filePath, ext);
    const configEnd = resolveConfigEnd(ann.end, ann.kind, className);
    const gitSha = await gitHashObject(filePath, cwd).catch(() => "");
    annotated.push({
      classUniqueId: filePath,
      className,
      configEnd,
      objectKind: ann.kind,
      identityField: identityFieldOf(content),
      callback: ann.callback,
      filePath,
      language: langKey,
      gitSha,
      relatedFiles: [filePath],
      visitedClasses: [className],
    });
    reachableFiles.add(filePath);
  }

  const langCounts = new Map<string, number>();
  for (const c of annotated) {
    langCounts.set(c.language, (langCounts.get(c.language) ?? 0) + 1);
  }
  let primaryLanguage = "java";
  let max = 0;
  for (const [lang, n] of langCounts) {
    if (n > max) {
      max = n;
      primaryLanguage = lang;
    }
  }

  // #316 — surface recognized user-facts contracts so the developer can see the declaration took
  // effect (and at which reserved address) instead of wondering why it isn't in the endpoint list.
  const factsClasses = annotated.filter((c) => c.objectKind === "FACTS");
  for (const f of factsClasses) {
    console.log(
      chalk.dim(`User-facts contract: ${f.className} → ${f.configEnd} (read-only, not a chat endpoint)`)
    );
  }
  if (factsClasses.length > 1) {
    console.warn(
      chalk.yellow("⚠"),
      `${factsClasses.length} classes declare \`@Confiqure.Facts\`, but a workspace has ONE user-facts ` +
        `contract — the most recently pushed one wins. Classes: ${factsClasses.map((c) => c.className).join(", ")}`
    );
  }

  // Two objects on one address: the backend keeps one per address, so the other would be
  // silently replaced. Warn (advisory, as before 3.0) so the developer gives each its own `end`.
  const byEnd = new Map<string, DiscoveredClass[]>();
  for (const c of annotated) if (c.configEnd) byEnd.set(c.configEnd, [...(byEnd.get(c.configEnd) ?? []), c]);
  for (const [end, list] of byEnd) {
    if (list.length > 1) {
      console.warn(
        chalk.yellow("⚠"),
        `${list.length} objects share the address "${end}", but the backend keeps one object per address. ` +
          `Give each its own \`end\`. Classes: ${list.map((c) => c.className).join(", ")}`
      );
    }
  }

  return { annotated, toolFiles, hookFiles, toolClasses, allFiles, primaryLanguage, reachableFiles, toolReachableFiles, errors };
}

/**
 * A Maven/Gradle test-source path (`.../src/test/...`). Normalizes Windows separators first.
 * Deliberately anchored to `src/test/` — a bare `/test/` segment would wrongly exclude a
 * legitimate config domain a host happens to call "test".
 */
export function isTestPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return norm.includes("/src/test/") || norm.startsWith("src/test/");
}

function fileHasCallbackHook(source: string): boolean {
  return source.includes("@Confiqure.DefaultCallbackHook") || source.includes("@DefaultCallbackHook");
}

const OBJECT_ANNOTATION = /@Confiqure\s*\.\s*(User\s*\.\s*)?(Setting|List|Facts)\b\s*(\(([^)]*)\))?/;

/**
 * The 3.0 object annotation in a source file (`@Confiqure.Setting/List`, `@Confiqure.User.Setting/List`,
 * `@Confiqure.Facts`) with its `end` / `callback` arguments. Null for anything else — including the
 * pre-3.0 `@Confiqure(...)` form, which `lintSources` rejects with a message.
 */
export function objectAnnotation(source: string): { kind: ObjectKind; end: string | null; callback: string | null } | null {
  const m = source.match(OBJECT_ANNOTATION);
  if (!m) return null;
  const user = !!m[1];
  const base = m[2];
  const args = m[4] ?? "";
  const str = (key: string) => args.match(new RegExp(`\\b${key}\\s*[:=]\\s*["']([^"']*)["']`))?.[1] ?? null;
  if (base === "Facts") return { kind: "FACTS", end: null, callback: str("callback") };
  const kind: ObjectKind = base === "Setting" ? (user ? "USER_SETTING" : "SETTING") : (user ? "USER_LIST" : "LIST");
  return { kind, end: str("end"), callback: null };
}

/** The field carrying `@Confiqure.Identity` (source-level; Java roots use the tree-sitter parse). */
export function identityFieldOf(source: string): string | null {
  const m = source.match(/@Confiqure\s*\.\s*Identity\b\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:private|protected|public|final|static|transient|val|var)\s+)*(?:[\w<>\[\],.?]+\s+)?(\w+)\s*[:=;]/);
  return m ? m[1] : null;
}

function snakeCase(className: string): string {
  return className
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * The reserved address of a FACTS class. A facts DTO is NOT a chat endpoint and normally carries no
 * `end`, and an end-less class otherwise resolves to `"/"` — the workspace's DEFAULT endpoint. So
 * without its own address a pushed facts contract would silently REPLACE the router. `/facts/<snake
 * case class name>` is deterministic, collision-free with real endpoints, and self-describing in
 * logs. An explicitly declared `end` still wins (the developer asked for it).
 */
export function factsEndpoint(className: string): string {
  return `/facts/${snakeCase(className) || "user_facts"}`;
}

/** Resolved address for one object: declared `end` → FACTS reserved address → `/<snake_case class name>`. */
function resolveConfigEnd(end: string | null, kind: ObjectKind, className: string): string {
  if (end) return end;
  return kind === "FACTS" ? factsEndpoint(className) : `/${snakeCase(className) || "object"}`;
}
