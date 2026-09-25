import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "web-tree-sitter";

/**
 * Tree-sitter-driven reachability for `@Confiqure`-rooted class graphs.
 *
 * The classic confiqure scan was "does this file contain `@Confiqure`?" — which
 * silently dropped every nested class the AI needs to understand. This module
 * parses each candidate source file into an AST, then walks the field-type
 * graph from each annotated root so we send the backend exactly the files that
 * matter (root + everything transitively referenced), not the whole scanPath.
 *
 * V1 supports Java. The factory wires `web-tree-sitter` + a bundled `.wasm`
 * grammar; adding Kotlin/Scala/etc. is a matter of registering another grammar
 * here and providing matching node-type extractors.
 */

const require = createRequire(import.meta.url);

type SyntaxNode = Parser.SyntaxNode;

function resolveGrammarWasm(grammarFile: string): string {
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  return join(dirname(pkgJson), "out", grammarFile);
}

let parserReady: Promise<void> | null = null;
let javaLanguage: Parser.Language | null = null;

async function ensureJavaParser(): Promise<Parser> {
  if (!parserReady) {
    parserReady = Parser.init();
  }
  await parserReady;
  if (!javaLanguage) {
    javaLanguage = await Parser.Language.load(resolveGrammarWasm("tree-sitter-java.wasm"));
  }
  const parser = new Parser();
  parser.setLanguage(javaLanguage);
  return parser;
}

export type DeclKind = "class" | "interface" | "enum" | "record";

/** The 3.0 object kinds (annotation 3.0.0): which `@Confiqure.<X>` a class carries. */
export type ObjectKind = "SETTING" | "LIST" | "USER_SETTING" | "USER_LIST" | "FACTS";

export interface ParsedField {
  name: string;
  /** Raw type expression, e.g. "List<Channel>". */
  typeText: string;
  /** Unwrapped type identifiers — includes wrapper + inner generic args. */
  typeNames: string[];
  /** Immediately-preceding block/line comment text, if any. */
  doc: string | null;
  /** True if `doc` contains an `@confiqure` tag. */
  hasConfiqureTag: boolean;
  /** Raw initializer expression (right of `=`), e.g. "FloorMethod.MARGIN_PERCENT"; null if none. */
  initializer: string | null;
  /** True if the field carries `@Confiqure.Identity` (3.0 — identifies a List record). */
  identity: boolean;
}

export interface ParsedDecl {
  kind: DeclKind;
  name: string;
  /** True when the type carries a 3.0 object annotation (`objectKind != null`) — an object root. */
  hasConfiqureAnnotation: boolean;
  /** The 3.0 object annotation on the type (`@Confiqure.Setting`, `.List`, `.User.Setting`, `.User.List`, `.Facts`), else null. */
  objectKind: ObjectKind | null;
  /** The object annotation's `end` argument, else null. */
  objectEnd: string | null;
  /** The `@Confiqure.Facts` `callback` argument, else null. */
  objectCallback: string | null;
  /** Name of the first field carrying `@Confiqure.Identity`, else null. */
  identityField: string | null;
  fields: ParsedField[];
  /**
   * Ancestor type names from `extends`/`implements` (#140). Superclass fields are part of the
   * config — a subclass endpoint inherits the base's core — so the reachability walk must follow
   * these exactly like field types (non-project ancestors fall away via the class index, same as
   * framework field types). Unwrapped identifiers, so `extends Base<Foo>` yields ["Base", "Foo"].
   */
  superTypes: string[];
  /**
   * The single `extends` superclass simple name (classes only; null for interfaces/records/no-extends).
   * Separate from {@link superTypes} — the push-lint warns when a `@Confiqure` root extends a base
   * whose source is absent from the bundle (inherited fields would be silently invisible, #140).
   */
  superclassName: string | null;
  /** Enum constants (kind === "enum" only) — closed-set values for typed schemas/scaffolds. */
  enumConstants: string[];
}

/**
 * Every enum declaration in a file, INCLUDING nested ones — flattened with the chain of enclosing
 * type names so a consumer can reason about Java scoping (an inner enum shadows a same-named
 * top-level twin). Separate from {@link ParsedDecl} (which holds only top-level types) so the
 * reachability walk is untouched. Powers the push-time lint for same-name/divergent enums.
 */
export interface EnumDecl {
  name: string;
  constants: string[];
  /** Enclosing type names, outermost-first; empty for a top-level enum. */
  enclosingTypes: string[];
}

/** One public method of a tool class — one typed operation the chat can call (annotation 3.0). */
export interface ParsedOperation {
  /** Method name. */
  name: string;
  /** From the Spring mapping; null for a `@Confiqure.Browser` operation without one. */
  httpMethod: "POST" | "GET" | "PUT" | "DELETE" | "PATCH" | null;
  /** The Spring mapping annotation's simple name (`PostMapping`, `GetMapping`, …); null without one. */
  mapping: string | null;
  /** Class `@RequestMapping` path + method mapping path, joined; null without a mapping. */
  path: string | null;
  /** `@Confiqure.Browser` — runs in the page. */
  browser: boolean;
  /** `@Confiqure.Async` — the result is delivered later. */
  async: boolean;
  /** The `@RequestBody` param type, else the first param type. */
  inputType: string | null;
  /** Method return type as written (generics kept). */
  returnType: string | null;
  /** Preceding Javadoc/comment, if any. */
  doc: string | null;
}

/** A class annotated `@Confiqure.Tool` — its Javadoc is the business FLOW, its public methods the operations. */
export interface ParsedToolClass {
  /** `@Confiqure.Tool(name)`, else the class name. */
  name: string;
  className: string;
  /** File path — the same identity rule as objects. */
  classUniqueId: string;
  /** The class Javadoc = the FLOW the chat follows. */
  doc: string | null;
  operations: ParsedOperation[];
  sourceFile: string;
}

export interface ParsedFile {
  filePath: string;
  packageName: string | null;
  /** Import targets as written, without `import`/`static`/`;` (e.g. `a.b.Foo`, `a.b.*`). */
  imports: string[];
  /** Every type declared in the file, nested ones included (they shadow same-named types elsewhere). */
  typeNames: string[];
  declarations: ParsedDecl[];
  toolClasses: ParsedToolClass[];
  /** Every enum in the file, including nested ones, with their enclosing-type chain (lint input). */
  enums: EnumDecl[];
}

export interface ClassTree {
  rootFile: string;
  rootClass: string;
  /** Files reachable from this root, including the root file itself. */
  reachableFiles: Set<string>;
  /** Class names walked while building this tree (for logging). */
  visitedClasses: string[];
}

export interface BuildClassTreesResult {
  trees: ClassTree[];
}

/** Parse every Java file in `allFiles`. Non-Java files are skipped silently. */
export async function parseJavaFiles(allFiles: Map<string, string>): Promise<ParsedFile[]> {
  const javaPaths = Array.from(allFiles.keys()).filter((p) => p.endsWith(".java"));
  if (javaPaths.length === 0) return [];

  const parser = await ensureJavaParser();
  const result: ParsedFile[] = [];

  try {
    for (const filePath of javaPaths) {
      const source = allFiles.get(filePath);
      if (source == null) continue;
      const tree = parser.parse(source);
      if (!tree) continue;
      result.push(extractFile(filePath, tree.rootNode));
    }
  } finally {
    parser.delete();
  }
  return result;
}

/** Parse a single Java file from disk. */
export async function parseJavaFile(filePath: string): Promise<ParsedFile | null> {
  const parser = await ensureJavaParser();
  try {
    const source = await readFile(filePath, "utf8");
    const tree = parser.parse(source);
    if (!tree) return null;
    return extractFile(filePath, tree.rootNode);
  } finally {
    parser.delete();
  }
}

function extractFile(filePath: string, root: SyntaxNode): ParsedFile {
  let packageName: string | null = null;
  const declarations: ParsedDecl[] = [];
  const toolClasses: ParsedToolClass[] = [];
  const imports = root.namedChildren
    .filter((c): c is SyntaxNode => !!c && c.type === "import_declaration")
    .map((c) => c.text.replace(/^import\s+(static\s+)?|\s*;$/g, "").replace(/\s+/g, ""));

  let pendingDoc: string | null = null;
  for (const child of root.namedChildren) {
    if (!child) continue;
    if (child.type === "block_comment" || child.type === "line_comment") {
      pendingDoc = pendingDoc ? `${pendingDoc}\n${child.text}` : child.text;
      continue;
    }
    if (child.type === "package_declaration") {
      packageName = extractPackageName(child);
    } else if (isTypeDeclaration(child.type)) {
      const decl = extractDeclaration(child, imports);
      if (decl) declarations.push(decl);
      const tc = extractToolClass(child, pendingDoc, filePath, imports);
      if (tc) toolClasses.push(tc);
    }
    pendingDoc = null;
  }

  // Separate pass for the full enum graph (nested enums too) — purely additive, does not touch
  // declarations/tools above, so the reachability walk is unchanged.
  const enums: EnumDecl[] = [];
  collectEnums(root, [], enums);

  const typeNames: string[] = [];
  collectTypeNames(root, typeNames);
  return { filePath, packageName, imports, typeNames, declarations, toolClasses, enums };
}

/**
 * Walk a node's type-declaration descendants, recording every enum (top-level or nested) with the
 * chain of enclosing type names. Recurses only through type bodies — enums can't be declared
 * outside a type — so each enum is recorded exactly once.
 */
function collectEnums(node: SyntaxNode, enclosing: string[], out: EnumDecl[]): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "enum_declaration") {
      const name = child.childForFieldName("name")?.text ?? "";
      const body = child.childForFieldName("body");
      out.push({ name, constants: extractEnumConstants(body), enclosingTypes: [...enclosing] });
      if (body) collectEnums(body, [...enclosing, name], out); // enums may nest further types
    } else if (
      child.type === "class_declaration" ||
      child.type === "interface_declaration" ||
      child.type === "record_declaration"
    ) {
      const name = child.childForFieldName("name")?.text ?? "";
      const body = child.childForFieldName("body");
      if (body) collectEnums(body, [...enclosing, name], out);
    }
  }
}

function collectTypeNames(node: SyntaxNode, out: string[]): void {
  for (const child of node.namedChildren) {
    if (!child || !isTypeDeclaration(child.type)) continue;
    out.push(child.childForFieldName("name")?.text ?? "");
    const body = child.childForFieldName("body");
    if (body) collectTypeNames(body, out);
  }
}

/** Closed value set of an enum body (the `enum_constant` names), ignoring any method members. */
function extractEnumConstants(body: SyntaxNode | null): string[] {
  if (!body) return [];
  const constants: string[] = [];
  const walk = (n: SyntaxNode) => {
    for (const child of n.namedChildren) {
      if (!child) continue;
      if (child.type === "enum_constant") {
        const nameNode = child.childForFieldName("name");
        if (nameNode) constants.push(nameNode.text);
      } else if (child.type !== "enum_body_declarations") {
        walk(child);
      }
    }
  };
  walk(body);
  return constants;
}

/**
 * A `@Confiqure.Tool` class → its operations. Every public method is one operation; its URL comes
 * from Spring (`@RequestMapping` on the class + `@Post/Get/Put/Delete/RequestMapping` on the method).
 * A public method with neither a mapping nor `@Confiqure.Browser` is kept (lintToolClasses reports it).
 */
function extractToolClass(typeNode: SyntaxNode, doc: string | null, filePath: string, imports: string[]): ParsedToolClass | null {
  if (typeNode.type !== "class_declaration") return null;
  const ann = findConfiqureAnnotation(typeNode, "Tool", imports);
  if (!ann) return null;
  const className = typeNode.childForFieldName("name")?.text ?? "";
  const name = annotationStringArg(ann, "name") ?? singleStringArg(ann) ?? className;
  const basePath = mappingPath(findAnnotation(typeNode, "RequestMapping")) ?? "";

  const operations: ParsedOperation[] = [];
  const body = typeNode.childForFieldName("body");
  let pendingDoc: string | null = null;
  for (const m of body?.namedChildren ?? []) {
    if (!m) continue;
    if (m.type === "block_comment" || m.type === "line_comment") {
      pendingDoc = pendingDoc ? `${pendingDoc}\n${m.text}` : m.text;
      continue;
    }
    if (m.type === "method_declaration" && isPublic(m)) {
      // Every Spring mapping is read so lintToolClasses can name a non-POST one (3.0: POST only).
      const mapping = (["PostMapping", "GetMapping", "PutMapping", "DeleteMapping", "PatchMapping", "RequestMapping"] as const)
        .map((n) => ({ n, a: findAnnotation(m, n) }))
        .find((x) => x.a !== null);
      let httpMethod: ParsedOperation["httpMethod"] = null;
      let path: string | null = null;
      if (mapping) {
        httpMethod =
          mapping.n === "RequestMapping"
            ? requestMethodOf(mapping.a!)
            : (mapping.n.replace("Mapping", "").toUpperCase() as ParsedOperation["httpMethod"]);
        path = joinPath(basePath, mappingPath(mapping.a) ?? "");
      }
      operations.push({
        name: m.childForFieldName("name")?.text ?? "",
        httpMethod,
        mapping: mapping?.n ?? null,
        path,
        browser: findConfiqureAnnotation(m, "Browser", imports) !== null,
        async: findConfiqureAnnotation(m, "Async", imports) !== null,
        inputType: extractInputType(m),
        returnType: m.childForFieldName("type")?.text ?? null,
        doc: pendingDoc,
      });
    }
    pendingDoc = null;
  }
  return { name, className, classUniqueId: filePath, doc, operations, sourceFile: filePath };
}

function isPublic(method: SyntaxNode): boolean {
  return method.children.some((c) => c?.type === "modifiers" && /(^|\s)public(\s|$)/.test(c.text));
}

/**
 * `@Confiqure.<simple>` on a node — qualified (`Confiqure.Async`, `ai.confiqure….Confiqure.Async`),
 * or bare (`@Async`) only when the file imports Confiqure's (`…Confiqure.Async` / `…Confiqure.*`):
 * a bare `@Async` is otherwise Spring's.
 */
function findConfiqureAnnotation(node: SyntaxNode, simple: string, imports: string[]): SyntaxNode | null {
  for (const ann of annotationsOf(node)) {
    if (confiqureName(ann.childForFieldName("name")?.text ?? "", imports) === simple) return ann;
  }
  return null;
}

/**
 * An annotation name as a member of `ai.confiqure.Confiqure` (`User.Setting`, `Identity`, …), or
 * null. Qualified (`Confiqure.X`, `ai.confiqure.Confiqure.X`) always counts; a bare `X` / `User.X`
 * only when the file imports `ai.confiqure.Confiqure.X` (or `.User`, or `.*`) — so `java.util.List`
 * or Spring's `@Async` never do.
 */
function confiqureName(name: string, imports: string[]): string | null {
  const q = name.match(/(?:^|\.)Confiqure\.(.+)$/);
  if (q) return q[1];
  const first = name.split(".")[0];
  return imports.some((i) => i === `ai.confiqure.Confiqure.${first}` || i === "ai.confiqure.Confiqure.*") ? name : null;
}

/** An annotation whose simple name is `simple` (e.g. Spring's `PostMapping`, qualified or not). */
function findAnnotation(node: SyntaxNode, simple: string): SyntaxNode | null {
  for (const ann of annotationsOf(node)) {
    if (lastSegment(ann.childForFieldName("name")?.text ?? "") === simple) return ann;
  }
  return null;
}

/** A mapping's path: `value=` / `path=` / the single positional value (first string of an array). */
function mappingPath(ann: SyntaxNode | null): string | null {
  if (!ann) return null;
  const raw = annotationRawArg(ann, "value") ?? annotationRawArg(ann, "path") ?? positionalArg(ann);
  return raw ? (raw.match(/"([^"]*)"/)?.[1] ?? null) : null;
}

/** `@RequestMapping(method = RequestMethod.GET)` → GET; no `method` → POST. */
function requestMethodOf(ann: SyntaxNode): ParsedOperation["httpMethod"] {
  const raw = annotationRawArg(ann, "method");
  const m = raw?.match(/\b(POST|GET|PUT|DELETE|PATCH)\b/);
  return m ? (m[1] as ParsedOperation["httpMethod"]) : "POST";
}

function joinPath(a: string, b: string): string {
  return (a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")).replace(/\/+$/, "") || "/";
}

/** The single positional (key-less) argument's raw text, e.g. `"/x"` in `@PostMapping("/x")`. */
function positionalArg(ann: SyntaxNode): string | null {
  const args = ann.childForFieldName("arguments");
  if (!args) return null;
  const first = args.namedChildren.find((c) => c && c.type !== "element_value_pair" && !c.type.endsWith("comment"));
  return first?.text ?? null;
}

/** A positional string argument, quotes stripped (`@Confiqure.Tool("X")`). */
function singleStringArg(ann: SyntaxNode): string | null {
  const raw = positionalArg(ann);
  return raw ? (raw.match(/^"([^"]*)"$/)?.[1] ?? null) : null;
}

/** Value of a string-literal annotation arg, quotes stripped; null if absent. */
function annotationStringArg(ann: SyntaxNode, key: string): string | null {
  const raw = annotationRawArg(ann, key);
  if (raw == null) return null;
  return raw.replace(/^"|"$/g, "");
}

/** Raw text of an annotation arg's value; null if absent. */
function annotationRawArg(ann: SyntaxNode, key: string): string | null {
  const args = ann.childForFieldName("arguments");
  if (!args) return null;
  for (const pair of args.namedChildren) {
    if (!pair || pair.type !== "element_value_pair") continue;
    const k = pair.childForFieldName("key");
    if (k && k.text === key) {
      return pair.childForFieldName("value")?.text ?? null;
    }
  }
  return null;
}

/** The input DTO type: the `@RequestBody` param's type, else the first param's type. */
function extractInputType(method: SyntaxNode): string | null {
  const params = method.childForFieldName("parameters");
  if (!params) return null;
  let firstType: string | null = null;
  for (const param of params.namedChildren) {
    if (!param || param.type !== "formal_parameter") continue;
    const typeText = param.childForFieldName("type")?.text ?? null;
    if (firstType == null) firstType = typeText;
    // Prefer a @RequestBody-annotated param.
    for (const c of param.children) {
      if (!c || c.type !== "modifiers") continue;
      for (const mod of c.namedChildren) {
        if (!mod) continue;
        if (mod.type !== "annotation" && mod.type !== "marker_annotation") continue;
        const annName = mod.childForFieldName("name");
        if (annName && lastSegment(annName.text) === "RequestBody") return typeText;
      }
    }
  }
  return firstType;
}

function isTypeDeclaration(type: string): boolean {
  return (
    type === "class_declaration" ||
    type === "interface_declaration" ||
    type === "enum_declaration" ||
    type === "record_declaration"
  );
}

function extractPackageName(node: SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "scoped_identifier" || child.type === "identifier") {
      return child.text;
    }
  }
  return null;
}

function extractDeclaration(node: SyntaxNode, imports: string[] = []): ParsedDecl | null {
  const kind: DeclKind =
    node.type === "class_declaration"
      ? "class"
      : node.type === "interface_declaration"
        ? "interface"
        : node.type === "enum_declaration"
          ? "enum"
          : "record";

  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const name = nameNode.text;

  const objectAnn = declarationObjectAnnotation(node, imports);
  const objectKind = objectAnn?.kind ?? null;
  const hasConfiqureAnnotation = objectKind !== null;
  const superTypes = extractSuperTypes(node);
  const superclassName = extractSuperclassName(node);

  const body = node.childForFieldName("body");
  const fields: ParsedField[] = [];
  const enumConstants: string[] = [];
  if (body && (kind === "class" || kind === "record")) {
    let pendingDoc: string | null = null;
    for (const child of body.namedChildren) {
      if (!child) continue;
      if (child.type === "block_comment" || child.type === "line_comment") {
        pendingDoc = pendingDoc ? `${pendingDoc}\n${child.text}` : child.text;
        continue;
      }
      if (child.type === "field_declaration") {
        const extracted = extractFields(child, pendingDoc, imports);
        fields.push(...extracted);
      }
      pendingDoc = null;
    }
  }
  if (kind === "record") {
    // A record's state is its components (`record R(Period period, List<Figure> figures)`), not
    // field declarations — read them as fields so the walk follows their types.
    for (const param of node.childForFieldName("parameters")?.namedChildren ?? []) {
      if (!param || param.type !== "formal_parameter") continue;
      const typeNode = param.childForFieldName("type");
      const nameNode = param.childForFieldName("name");
      if (!typeNode || !nameNode) continue;
      fields.push({
        name: nameNode.text,
        typeText: typeNode.text,
        typeNames: collectTypeIdentifiers(typeNode),
        doc: null,
        hasConfiqureTag: false,
        initializer: null,
        identity: annotationsOf(param).some(
          (a) => confiqureName(a.childForFieldName("name")?.text ?? "", imports) === "Identity"
        ),
      });
    }
  }
  if (body && kind === "enum") {
    // Closed value set for downstream schema/scaffold generation (real enums, not bare strings).
    enumConstants.push(...extractEnumConstants(body));
  }

  const identityField = fields.find((f) => f.identity)?.name ?? null;
  const objectEnd = objectAnn && objectKind !== "FACTS" ? annotationStringArg(objectAnn.node, "end") : null;
  const objectCallback = objectKind === "FACTS" ? annotationStringArg(objectAnn!.node, "callback") : null;
  return { kind, name, hasConfiqureAnnotation, objectKind, objectEnd, objectCallback, identityField, fields, superTypes, superclassName, enumConstants };
}

/**
 * The single `extends` superclass's simple name from the {@code superclass} clause (the first type
 * identifier, so {@code extends Base<Foo>} → "Base"). Null when there's no {@code extends} (records,
 * interfaces, and classes with only {@code implements}). Powers the missing-base push-lint (#140).
 */
function extractSuperclassName(node: SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (child && child.type === "superclass") {
      const ids = collectTypeIdentifiers(child);
      return ids.length > 0 ? ids[0] : null;
    }
  }
  return null;
}

/**
 * Ancestor type identifiers declared on a type: the `extends` superclass and every
 * `implements`/`extends` interface (#140). Grammar-version-resilient — we match the wrapper
 * nodes tree-sitter-java uses for the clause (`superclass`, `super_interfaces` on classes/records;
 * `extends_interfaces` on interfaces) and reuse {@link collectTypeIdentifiers} to unwrap generics.
 */
function extractSuperTypes(node: SyntaxNode): string[] {
  const out = new Set<string>();
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (
      child.type === "superclass" ||
      child.type === "super_interfaces" ||
      child.type === "extends_interfaces"
    ) {
      for (const t of collectTypeIdentifiers(child)) out.add(t);
    }
  }
  return [...out];
}

/**
 * The 3.0 object annotation on a type declaration. Matches `Confiqure.Setting`, `Confiqure.List`,
 * `Confiqure.User.Setting`, `Confiqure.User.List`, `Confiqure.Facts` — bare or fully qualified. The
 * `Confiqure.` qualifier is required so `java.util.List`-style names can never root a class. The
 * pre-3.0 `@Confiqure(...)` form roots nothing; `lintSources` rejects it with a message instead.
 */
function declarationObjectAnnotation(node: SyntaxNode, imports: string[]): { kind: ObjectKind; node: SyntaxNode } | null {
  for (const ann of annotationsOf(node)) {
    const n = confiqureName(ann.childForFieldName("name")?.text ?? "", imports);
    if (n === "Facts") return { kind: "FACTS", node: ann };
    if (n === "Setting") return { kind: "SETTING", node: ann };
    if (n === "List") return { kind: "LIST", node: ann };
    if (n === "User.Setting") return { kind: "USER_SETTING", node: ann };
    if (n === "User.List") return { kind: "USER_LIST", node: ann };
  }
  return null;
}

/** The annotation nodes on a declaration's (type, method, field, parameter) modifiers. */
function annotationsOf(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (const child of node.children) {
    if (!child || child.type !== "modifiers") continue;
    for (const mod of child.namedChildren) {
      if (mod && (mod.type === "annotation" || mod.type === "marker_annotation")) out.push(mod);
    }
  }
  return out;
}

function lastSegment(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function extractFields(fieldDecl: SyntaxNode, doc: string | null, imports: string[]): ParsedField[] {
  const typeNode = fieldDecl.childForFieldName("type");
  if (!typeNode) return [];
  const typeText = typeNode.text;
  const typeNames = collectTypeIdentifiers(typeNode);

  const identity = annotationsOf(fieldDecl).some(
    (a) => confiqureName(a.childForFieldName("name")?.text ?? "", imports) === "Identity"
  );
  const out: ParsedField[] = [];
  for (const child of fieldDecl.namedChildren) {
    if (!child) continue;
    if (child.type !== "variable_declarator") continue;
    const nameNode = child.childForFieldName("name");
    if (!nameNode) continue;
    out.push({
      name: nameNode.text,
      typeText,
      typeNames,
      doc,
      hasConfiqureTag: doc != null && /@confiqure\b/i.test(doc),
      initializer: child.childForFieldName("value")?.text ?? null,
      identity,
    });
  }
  return out;
}

/**
 * Walk a `type` subtree and return every type identifier we see — the wrapper
 * type plus every generic argument. E.g. `Map<String, List<Channel>>` →
 * ["Map", "String", "List", "Channel"]. The resolver later filters these
 * against the in-project class index, so non-project types (String, etc.)
 * fall away naturally.
 */
function collectTypeIdentifiers(node: SyntaxNode): string[] {
  const out: string[] = [];
  const visit = (n: SyntaxNode | null): void => {
    if (!n) return;
    if (n.type === "type_identifier") {
      out.push(n.text);
      return;
    }
    if (n.type === "scoped_type_identifier") {
      // Keep the qualifier (`a.b.Foo`, `Outer.Inner`) — resolution needs it; its segments aren't types.
      out.push(n.text.replace(/\s+/g, ""));
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(node);
  return out;
}

/**
 * From the set of parsed files, build one ClassTree per `@Confiqure` root.
 *
 * Every class annotated with `@Confiqure` becomes its own tree (its own
 * endpoint). When a root's field-type graph happens to walk into another
 * root, the second root's file still ends up in the first root's
 * reachableFiles — that's intentional, since the AI needs the full type
 * context to generate a coherent playbook — but the second root ALSO gets
 * its own tree. Overlapping reachable sets are fine: the manifest dedupes
 * via Set semantics at upload time.
 *
 * (Earlier versions of this code subsumed annotated children under their
 * parent root. That was wrong — a developer who writes `@Confiqure` on a
 * class means "this is an endpoint," full stop. If they wanted it as a
 * sub-block of the parent, they wouldn't have annotated it.)
 */
export function buildClassTrees(parsed: ParsedFile[]): BuildClassTreesResult {
  const index = buildTypeIndex(parsed);
  const trees: ClassTree[] = [];
  for (const pf of parsed) {
    for (const decl of pf.declarations) {
      if (!decl.hasConfiqureAnnotation) continue;
      const reachableFiles = new Set<string>();
      const visitedClasses: string[] = [];
      walkTypes(index, [{ file: pf, decl }], reachableFiles, visitedClasses);
      trees.push({ rootFile: pf.filePath, rootClass: decl.name, reachableFiles, visitedClasses });
    }
  }
  return { trees };
}

/** One top-level type of the project, keyed by its file. */
interface TypeEntry {
  file: ParsedFile;
  decl: ParsedDecl;
}

interface TypeIndex {
  /** `package.Name` (or `Name` in the default package) → the type(s); more than one only when two files repeat a name in one package. */
  byFqcn: Map<string, TypeEntry[]>;
  /** Simple name → EVERY type with that name (never first-wins). */
  bySimple: Map<string, TypeEntry[]>;
}

function buildTypeIndex(parsed: ParsedFile[]): TypeIndex {
  const byFqcn = new Map<string, TypeEntry[]>();
  const bySimple = new Map<string, TypeEntry[]>();
  for (const file of parsed) {
    for (const decl of file.declarations) {
      const entry = { file, decl };
      const fqcn = file.packageName ? `${file.packageName}.${decl.name}` : decl.name;
      byFqcn.set(fqcn, [...(byFqcn.get(fqcn) ?? []), entry]);
      bySimple.set(decl.name, [...(bySimple.get(decl.name) ?? []), entry]);
    }
  }
  return { byFqcn, bySimple };
}

/** The longest dotted prefix of `name` that is a project type (`a.b.Outer.Inner` → `a.b.Outer`). */
function byQualifiedPrefix(index: TypeIndex, name: string): TypeEntry[] {
  const parts = name.split(".");
  for (let n = parts.length; n > 0; n--) {
    const hit = index.byFqcn.get(parts.slice(0, n).join("."));
    if (hit) return hit;
  }
  return [];
}

/**
 * Resolve a type reference the way javac does, from the file that names it: a type the file
 * declares (nested included) → a single-type import → the file's own package → on-demand (`.*`)
 * imports. Qualified names resolve by package. Resolution is by PATH, never by simple name, so a
 * same-named class elsewhere can't shadow the right one. A reference nothing decides (default
 * package, unresolved wildcard) ships EVERY project type of that simple name — over-shipping a DTO
 * costs bytes; dropping one made the engine check replies against the wrong class.
 */
function resolveType(index: TypeIndex, ref: string, from: ParsedFile): TypeEntry[] {
  let simple = ref;
  if (ref.includes(".")) {
    const qualified = byQualifiedPrefix(index, ref);
    if (qualified.length > 0) return qualified;
    simple = ref.split(".")[0]; // `Outer.Inner` → resolve `Outer`
  }
  if (from.typeNames.includes(simple)) {
    const own = from.declarations.find((d) => d.name === simple) ?? from.declarations[0];
    return own ? [{ file: from, decl: own }] : [];
  }
  for (const imp of from.imports) {
    if (imp.endsWith(".*")) continue;
    if (imp === simple || imp.endsWith(`.${simple}`)) {
      return byQualifiedPrefix(index, imp); // empty: imported from a library → not a project type
    }
  }
  const samePackage = index.byFqcn.get(from.packageName ? `${from.packageName}.${simple}` : simple);
  if (samePackage) return samePackage;
  const onDemand = from.imports
    .filter((i) => i.endsWith(".*"))
    .flatMap((i) => byQualifiedPrefix(index, `${i.slice(0, -2)}.${simple}`))
    .filter((e) => e.decl.name === simple);
  if (onDemand.length > 0) return onDemand;
  return index.bySimple.get(simple) ?? [];
}

/**
 * Transitive closure over field / record-component / ancestor types, each resolved from the file
 * that names it. Files are the unit: a file reached once is walked once.
 */
function walkTypes(index: TypeIndex, start: TypeEntry[], reachable: Set<string>, visitedClasses: string[]): void {
  const stack = [...start];
  while (stack.length > 0) {
    const { file, decl } = stack.pop()!;
    if (reachable.has(file.filePath)) continue;
    reachable.add(file.filePath);
    visitedClasses.push(decl.name);
    // Ancestors first (#140): a subclass inherits the base's fields, so the base source AND its
    // referenced types must ship. Walked for every kind (interfaces extend interfaces; records implement).
    const refs = [...decl.superTypes];
    if (decl.kind === "class" || decl.kind === "record") {
      for (const field of decl.fields) refs.push(...field.typeNames);
    }
    for (const ref of refs) stack.push(...resolveType(index, ref, file));
  }
}

/**
 * Files reachable from TOOL signatures: each tool-class operation's input
 * DTO + return type, walked through the same field-type graph as object
 * roots. Without this, a tool input DTO living in its own file ships ONLY if
 * some `@Confiqure` endpoint happens to reference it — and the Composer can't
 * derive the tool's input schema from source it never received.
 */
export function collectToolReachableFiles(
  parsed: ParsedFile[],
  toolClasses: ParsedToolClass[],
): Set<string> {
  const index = buildTypeIndex(parsed);
  const byPath = new Map(parsed.map((pf) => [pf.filePath, pf]));
  const start: TypeEntry[] = [];
  for (const tc of toolClasses) {
    const from = byPath.get(tc.sourceFile);
    if (!from) continue;
    for (const op of tc.operations) {
      // Every (possibly qualified) name in the signature — `ResponseEntity<SalesSummary>`,
      // `Optional<Q>`, `Mono<Set<T>>`, `Beta[]` — resolved from the tool class's own file. Wrappers
      // (ResponseEntity, Optional, CompletableFuture, Mono, List, Set) are not project types and fall away.
      for (const t of [op.inputType, op.returnType]) {
        for (const ref of t?.match(/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g) ?? []) {
          start.push(...resolveType(index, ref.replace(/\s+/g, ""), from));
        }
      }
    }
  }
  const reachable = new Set<string>();
  walkTypes(index, start, reachable, []);
  return reachable;
}
