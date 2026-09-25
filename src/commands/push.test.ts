import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scopeToFile, buildManifest } from "./push.js";
import { scanProject } from "../scan.js";
import { loadConfig } from "../config.js";
import type { ScanResult, DiscoveredClass } from "../scan.js";

async function scanFixture(dir: string): Promise<ScanResult> {
  const cwd = fileURLToPath(new URL(`../../${dir}`, import.meta.url));
  return scanProject(cwd, await loadConfig(cwd));
}

// #120: DTOs never reference controllers (reachability is directional), so a
// @Confiqure.Tool controller — and anything only reachable from a tool's
// input/return DTOs — lives OUTSIDE any endpoint root's relatedFiles. Tool
// discovery is workspace-level, not per-endpoint: a `--file` scoped push must
// still ship every tool the full-tree scan already found, even though the
// selected DTO never touches the controller file.
const root = (className: string, filePath: string): DiscoveredClass =>
  ({
    classUniqueId: filePath,
    className,
    configEnd: "/" + className,
    objectKind: "SETTING",
    identityField: null,
    callback: null,
    filePath,
    language: "java",
    gitSha: "sha-" + className,
    relatedFiles: [filePath],
    visitedClasses: [className],
  }) as DiscoveredClass;

function fixtureScan(): ScanResult {
  return {
    annotated: [root("Supplier", "src/dto/Supplier.java"), root("Other", "src/dto/Other.java")],
    toolFiles: [{ filePath: "src/controller/SupplierController.java", gitSha: "sha-controller" }],
    hookFiles: [{ filePath: "src/hooks/CallbackHook.java", gitSha: "sha-hook" }],
    toolClasses: [
      {
        name: "SupplierTool",
        className: "SupplierTool",
        classUniqueId: "src/controller/SupplierController.java",
        doc: null,
        sourceFile: "src/controller/SupplierController.java",
        operations: [
          { name: "lookupPrice", httpMethod: "POST", path: "/api/price", browser: false, async: false, inputType: "ToolInput", returnType: "ToolOutput", doc: null },
        ],
      },
    ],
    allFiles: new Map(),
    primaryLanguage: "java",
    reachableFiles: new Set(["src/dto/Supplier.java", "src/dto/Other.java"]),
    toolReachableFiles: new Set(["src/dto/ToolInput.java"]),
    errors: [],
  };
}

describe("scopeToFile (#120 — --file must not drop the workspace-level tool sweep)", () => {
  it("keeps toolFiles/toolClasses/toolReachableFiles/hookFiles from the full-tree scan", () => {
    const scan = fixtureScan();
    scopeToFile(scan, "Supplier.java");

    expect(scan.toolFiles).toEqual([
      { filePath: "src/controller/SupplierController.java", gitSha: "sha-controller" },
    ]);
    expect(scan.toolClasses.map((t) => t.name)).toEqual(["SupplierTool"]);
    expect(scan.toolReachableFiles).toEqual(new Set(["src/dto/ToolInput.java"]));
    expect(scan.hookFiles).toEqual([{ filePath: "src/hooks/CallbackHook.java", gitSha: "sha-hook" }]);
  });

  it("still narrows annotated/reachableFiles to the targeted root (class scoping unchanged)", () => {
    const scan = fixtureScan();
    scopeToFile(scan, "Supplier.java");

    expect(scan.annotated.map((c) => c.className)).toEqual(["Supplier"]);
    expect(scan.reachableFiles).toEqual(new Set(["src/dto/Supplier.java"]));
  });
});

describe("buildManifest (CLI 1.0 — tool classes ship with their DTOs)", () => {
  it("bundles a tool class, its DTO files, and sends objectKind/identityField per change", async () => {
    const manifest = buildManifest(await scanFixture("fixtures/three-zero")); // ListingRepricing (List), ListingsTool, TitleQuery, Listing
    const change = manifest.changes.find((c) => c.classUniqueId.endsWith("ListingRepricing.java"))!;
    expect(change.objectKind).toBe("LIST");
    expect(change.identityField).toBe("listingSku");
    expect(manifest.toolClasses![0].name).toBe("ListingsTool");
    expect(manifest.toolClasses![0].operations[0]).toMatchObject({ name: "byTitle", httpMethod: "POST", path: "/api/confiqure/listings/by-title" });
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(["src/ListingsTool.java", "src/TitleQuery.java", "src/Listing.java"]));
    expect(manifest.files.map((f) => f.path)).not.toContain("src/Unrelated.java");
    expect((manifest as unknown as Record<string, unknown>).tools).toBeUndefined();
  });

  it("a tool class is a change of its own (TOOL_CLASS); an unchanged one ships nothing", async () => {
    const scan = await scanFixture("fixtures/three-zero");
    const all = buildManifest(scan);
    const tc = all.changes.find((c) => c.classUniqueId === "src/ListingsTool.java")!;
    expect(tc).toMatchObject({ objectKind: "TOOL_CLASS", configEnd: null, className: "ListingsTool" });
    expect(tc.relatedFiles!.sort()).toEqual(["src/Listing.java", "src/ListingsTool.java", "src/TitleQuery.java"]);

    const objectOnly = buildManifest(scan, { changes: all.changes.filter((c) => c.objectKind !== "TOOL_CLASS") });
    expect(objectOnly.toolClasses).toBeUndefined();
    expect(objectOnly.files.map((f) => f.path)).toEqual(["src/ListingRepricing.java"]);
  });
});

describe("buildManifest 1.0.1 — two SalesSummary classes in different packages both ship (row 4747)", () => {
  it("the tool's record and the object's part are both in the manifest files", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cq-101-"));
    try {
      const put = async (p: string, src: string) => {
        await mkdir(join(dir, p, ".."), { recursive: true });
        await writeFile(join(dir, p), src);
      };
      await put("src/c/d/SalesSummary.java", `package c.d;\npublic class SalesSummary { private Integer units; }`);
      await put("src/c/d/Stock.java", `package c.d;\nimport ai.confiqure.Confiqure;\n@Confiqure.Setting(end = "/stock")\npublic class Stock { private SalesSummary summary; }`);
      await put("src/a/b/SalesSummary.java", `package a.b;\npublic record SalesSummary(boolean ok, String message) {}`);
      await put("src/t/SalesTool.java", `package t;\nimport ai.confiqure.Confiqure;\nimport a.b.SalesSummary;\n@Confiqure.Tool(name = "SalesTool")\n@RequestMapping("/api")\npublic class SalesTool {\n  @PostMapping("/s") public ResponseEntity<SalesSummary> s(@RequestBody Q q) { return null; }\n}`);
      const cwd = dir;
      const scan = await scanProject(cwd, { ...(await loadConfig(cwd)), scanPaths: ["src"], guides: [] });
      const manifest = buildManifest(scan);
      const paths = manifest.files.map((f) => f.path);
      expect(paths).toEqual(expect.arrayContaining(["src/a/b/SalesSummary.java", "src/c/d/SalesSummary.java"]));
      const tool = manifest.changes.find((c) => c.objectKind === "TOOL_CLASS")!;
      expect(tool.relatedFiles!.sort()).toEqual(["src/a/b/SalesSummary.java", "src/t/SalesTool.java"]);
      const stock = manifest.changes.find((c) => c.className === "Stock")!;
      expect(stock.relatedFiles!.sort()).toEqual(["src/c/d/SalesSummary.java", "src/c/d/Stock.java"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
