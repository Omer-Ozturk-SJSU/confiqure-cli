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
  ParsedTool,
} from "./classTree.js";
import { lintBundle } from "./lint.js";

export interface DiscoveredClass {
  /** Stable identity. V1: relative file path. */
  classUniqueId: string;
  /** Top-level class name. */
  className: string;
  /** Resolved annotation `end`; a bare `@Confiqure` (no `end`) resolves to the default endpoint "/". */
  configEnd: string;
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

/** A controller file containing @Confiqure.Tool methods. */
export interface ToolFile {
  filePath: string;
  gitSha: string;
}

export interface ScanResult {
  /** Annotated root classes (one per `@Confiqure` endpoint). */
  annotated: DiscoveredClass[];
  /** Controller files with @Confiqure.Tool methods. */
  toolFiles: ToolFile[];
  /**
   * Files containing a `@Confiqure.DefaultCallbackHook` method. Shipped in the
   * upload bundle so the Composer can discover the workspace's callback hook
   * path — even when the hook lives in a controller that is neither a
   * `@Confiqure` root nor a `@Confiqure.Tool` controller (which the scan would
   * otherwise never upload).
   */
  hookFiles: ToolFile[];
  /** Every @Confiqure.Tool method discovered (server-side + frontend). */
  tools: ParsedTool[];
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

  const files = await fastGlob(patterns, {
    cwd,
    ignore: ignorePatterns,
    absolute: false,
    onlyFiles: true,
    dot: false,
  });

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
  const tools: ParsedTool[] = [];
  const reachableFiles = new Set<string>();
  const toolReachableFiles = new Set<string>();

  // One tree-sitter pass serves endpoint reachability, tool detection, AND
  // tool-signature reachability (the input DTO graph the Composer needs to
  // derive a tool's input schema — previously never shipped unless an
  // endpoint happened to reference the same type).
  if (javaFiles.size > 0) {
    const parsed = await parseJavaFiles(javaFiles);
    const { trees } = buildClassTrees(parsed);
    javaTrees.push(...trees);
    for (const pf of parsed) {
      tools.push(...pf.tools);
      const src = allFiles.get(pf.filePath) ?? "";
      if (fileHasConfiqureTool(pf.declarations, src)) {
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
    for (const f of collectToolReachableFiles(parsed, tools)) {
      toolReachableFiles.add(f);
    }

    // Push-time lint (#83): warn on simple-name enum collisions / bad enum defaults the host can't
    // see but a name-based resolver trips over. Advisory only — never blocks the push.
    for (const warning of lintBundle(parsed)) {
      console.warn(chalk.yellow("⚠"), warning);
    }
  }

  for (const tree of javaTrees) {
    const content = allFiles.get(tree.rootFile) ?? "";
    const className = tree.rootClass;
    const configEnd = extractEnd(content) ?? DEFAULT_ENDPOINT;
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

    const ext = extname(filePath);
    const className = basename(filePath, ext);
    const configEnd = extractEnd(content) ?? DEFAULT_ENDPOINT;
    const gitSha = await gitHashObject(filePath, cwd).catch(() => "");
    annotated.push({
      classUniqueId: filePath,
      className,
      configEnd,
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

  // A workspace can have only ONE default endpoint. A bare `@Confiqure` (no `end`) resolves
  // to "/", so two end-less classes would both claim it — warn so the developer adds an
  // explicit `end` to all but one (the backend keeps only one default endpoint regardless).
  const defaults = annotated.filter((c) => c.configEnd === DEFAULT_ENDPOINT);
  if (defaults.length > 1) {
    console.warn(
      chalk.yellow("⚠"),
      `${defaults.length} classes have no \`end\` and all resolve to the default endpoint "/", ` +
        `but a workspace can have only ONE default endpoint. Give all but one an explicit \`end\`. ` +
        `Classes: ${defaults.map((c) => c.className).join(", ")}`
    );
  }

  return { annotated, toolFiles, hookFiles, tools, allFiles, primaryLanguage, reachableFiles, toolReachableFiles };
}

function fileHasConfiqureTool(declarations: import("./classTree.js").ParsedDecl[], source: string): boolean {
  return source.includes("@Confiqure.Tool") || source.includes("@Tool");
}

function fileHasCallbackHook(source: string): boolean {
  return source.includes("@Confiqure.DefaultCallbackHook") || source.includes("@DefaultCallbackHook");
}

/**
 * The workspace DEFAULT endpoint address. Per the V2 architecture doc, a bare
 * `@Confiqure` (annotation present, no `end` value) IS the workspace's default
 * endpoint — reached at configEnd "/" — NOT a class-name-derived slug. So a class
 * with no parseable `end` resolves here, matching how the backend Composer composes it.
 */
const DEFAULT_ENDPOINT = "/";

function extractEnd(source: string): string | null {
  const m = source.match(/\b[Ee]nd\s*[:=]\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}
