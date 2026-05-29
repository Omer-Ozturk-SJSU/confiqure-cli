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
}

export interface ParsedDecl {
  kind: DeclKind;
  name: string;
  hasConfiqureAnnotation: boolean;
  fields: ParsedField[];
}

/** A `@Confiqure.Tool`-annotated method discovered during the scan. */
export interface ParsedTool {
  /** Tool name (from `name=` arg, else the method name). */
  name: string;
  /** From the `serverSide` arg; defaults to true. */
  serverSide: boolean;
  /** The `@RequestBody` param type (or first param type) — the input DTO. */
  inputType: string | null;
  /** Method return type. */
  returnType: string | null;
  /** Preceding Javadoc/comment, if any. */
  doc: string | null;
  /** File the tool was declared in. */
  sourceFile: string;
}

export interface ParsedFile {
  filePath: string;
  packageName: string | null;
  declarations: ParsedDecl[];
  tools: ParsedTool[];
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
  const tools: ParsedTool[] = [];

  for (const child of root.namedChildren) {
    if (!child) continue;
    if (child.type === "package_declaration") {
      packageName = extractPackageName(child);
    } else if (isTypeDeclaration(child.type)) {
      const decl = extractDeclaration(child);
      if (decl) declarations.push(decl);
      tools.push(...extractToolMethods(child, filePath));
    }
  }

  return { filePath, packageName, declarations, tools };
}

/** Scan a type declaration's body for `@Confiqure.Tool`-annotated methods. */
function extractToolMethods(typeNode: SyntaxNode, filePath: string): ParsedTool[] {
  const body = typeNode.childForFieldName("body");
  if (!body) return [];
  const out: ParsedTool[] = [];
  let pendingDoc: string | null = null;
  for (const child of body.namedChildren) {
    if (!child) continue;
    if (child.type === "block_comment" || child.type === "line_comment") {
      pendingDoc = pendingDoc ? `${pendingDoc}\n${child.text}` : child.text;
      continue;
    }
    if (child.type === "method_declaration") {
      const tool = extractToolFromMethod(child, pendingDoc, filePath);
      if (tool) out.push(tool);
    }
    pendingDoc = null;
  }
  return out;
}

function extractToolFromMethod(method: SyntaxNode, doc: string | null, filePath: string): ParsedTool | null {
  const ann = findToolAnnotation(method);
  if (!ann) return null;

  const methodName = method.childForFieldName("name")?.text ?? "";
  const nameArg = annotationStringArg(ann, "name");
  const name = nameArg && nameArg.length > 0 ? nameArg : methodName;

  const serverSideRaw = annotationRawArg(ann, "serverSide");
  const serverSide = serverSideRaw == null ? true : serverSideRaw.trim() === "true";

  const returnType = method.childForFieldName("type")?.text ?? null;
  const inputType = extractInputType(method);

  return { name, serverSide, inputType, returnType, doc, sourceFile: filePath };
}

/** Find an `@Confiqure.Tool` / `@Tool` annotation on a method's modifiers. */
function findToolAnnotation(method: SyntaxNode): SyntaxNode | null {
  for (const child of method.children) {
    if (!child || child.type !== "modifiers") continue;
    for (const mod of child.namedChildren) {
      if (!mod) continue;
      if (mod.type !== "annotation" && mod.type !== "marker_annotation") continue;
      const annName = mod.childForFieldName("name");
      if (annName && lastSegment(annName.text) === "Tool") return mod;
    }
  }
  return null;
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

function extractDeclaration(node: SyntaxNode): ParsedDecl | null {
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

  const hasConfiqureAnnotation = declarationHasConfiqure(node);

  const body = node.childForFieldName("body");
  const fields: ParsedField[] = [];
  if (body && (kind === "class" || kind === "record")) {
    let pendingDoc: string | null = null;
    for (const child of body.namedChildren) {
      if (!child) continue;
      if (child.type === "block_comment" || child.type === "line_comment") {
        pendingDoc = pendingDoc ? `${pendingDoc}\n${child.text}` : child.text;
        continue;
      }
      if (child.type === "field_declaration") {
        const extracted = extractFields(child, pendingDoc);
        fields.push(...extracted);
      }
      pendingDoc = null;
    }
  }

  return { kind, name, hasConfiqureAnnotation, fields };
}

function declarationHasConfiqure(node: SyntaxNode): boolean {
  for (const child of node.children) {
    if (!child) continue;
    if (child.type !== "modifiers") continue;
    for (const mod of child.namedChildren) {
      if (!mod) continue;
      if (mod.type !== "marker_annotation" && mod.type !== "annotation") continue;
      const annName = mod.childForFieldName("name");
      if (!annName) continue;
      const simple = lastSegment(annName.text);
      if (simple === "Confiqure") return true;
    }
  }
  return false;
}

function lastSegment(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function extractFields(fieldDecl: SyntaxNode, doc: string | null): ParsedField[] {
  const typeNode = fieldDecl.childForFieldName("type");
  if (!typeNode) return [];
  const typeText = typeNode.text;
  const typeNames = collectTypeIdentifiers(typeNode);

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
    } else if (n.type === "scoped_type_identifier") {
      out.push(lastSegment(n.text));
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
  const classNameToDecl = new Map<string, { file: string; decl: ParsedDecl }>();
  for (const pf of parsed) {
    for (const decl of pf.declarations) {
      if (!classNameToDecl.has(decl.name)) {
        classNameToDecl.set(decl.name, { file: pf.filePath, decl });
      }
    }
  }

  const rootCandidates: { file: string; decl: ParsedDecl }[] = [];
  for (const pf of parsed) {
    for (const decl of pf.declarations) {
      if (decl.hasConfiqureAnnotation) rootCandidates.push({ file: pf.filePath, decl });
    }
  }

  const trees: ClassTree[] = rootCandidates.map(({ file, decl }) => {
    const reachableFiles = new Set<string>();
    const visitedClasses: string[] = [];
    const stack: string[] = [decl.name];

    while (stack.length > 0) {
      const className = stack.pop()!;
      const found = classNameToDecl.get(className);
      if (!found) continue;
      if (reachableFiles.has(found.file)) continue;
      reachableFiles.add(found.file);
      visitedClasses.push(className);
      if (found.decl.kind === "class" || found.decl.kind === "record") {
        for (const field of found.decl.fields) {
          for (const t of field.typeNames) stack.push(t);
        }
      }
    }

    return {
      rootFile: file,
      rootClass: decl.name,
      reachableFiles,
      visitedClasses,
    };
  });

  return { trees };
}
