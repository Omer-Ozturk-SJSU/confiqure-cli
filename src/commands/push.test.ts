import { describe, it, expect } from "vitest";
import { scopeToFile } from "./push.js";
import type { ScanResult, DiscoveredClass } from "../scan.js";

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
    tools: [
      {
        name: "lookupPrice",
        serverSide: true,
        async: false,
        inputType: "ToolInput",
        returnType: "ToolOutput",
        doc: null,
        sourceFile: "src/controller/SupplierController.java",
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
  it("keeps toolFiles/tools/toolReachableFiles/hookFiles from the full-tree scan", () => {
    const scan = fixtureScan();
    scopeToFile(scan, "Supplier.java");

    expect(scan.toolFiles).toEqual([
      { filePath: "src/controller/SupplierController.java", gitSha: "sha-controller" },
    ]);
    expect(scan.tools.map((t) => t.name)).toEqual(["lookupPrice"]);
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
