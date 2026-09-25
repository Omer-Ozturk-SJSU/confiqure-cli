import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsEndpoint, isTestPath, objectAnnotation, identityFieldOf, scanProject } from "./scan.js";
import { DEFAULT_CONFIG } from "./config.js";

describe("factsEndpoint (#316 — a facts class must never claim the default endpoint)", () => {
  it("derives a reserved snake_case address from the class name", () => {
    expect(factsEndpoint("SellerFacts")).toBe("/facts/seller_facts");
    expect(factsEndpoint("UserFacts")).toBe("/facts/user_facts");
    expect(factsEndpoint("ABCFacts")).toBe("/facts/abcfacts");
  });

  it("never returns the default endpoint '/' — the bug this exists to prevent", () => {
    for (const name of ["SellerFacts", "", "___", "X"]) {
      expect(factsEndpoint(name)).not.toBe("/");
      expect(factsEndpoint(name).startsWith("/facts/")).toBe(true);
    }
  });
});

describe("isTestPath (regression guard kept alongside the new scan helpers)", () => {
  it("excludes maven/gradle test sources but not a 'test' config domain", () => {
    expect(isTestPath("src/test/java/A.java")).toBe(true);
    expect(isTestPath("backend\\src\\test\\java\\A.java")).toBe(true);
    expect(isTestPath("src/main/java/test/Domain.java")).toBe(false);
  });
});

describe("3.0 vocabulary", () => {
  it("reads @Confiqure.List(end)", () => {
    const src = `@Confiqure.List(end = "/listing-repricing")\npublic class ListingRepricing { @Confiqure.Identity private String listingSku; }`;
    expect(objectAnnotation(src)).toEqual({ kind: "LIST", end: "/listing-repricing", callback: null });
    expect(identityFieldOf(src)).toBe("listingSku");
  });
  it("reads @Confiqure.User.Setting with no end", () => {
    expect(objectAnnotation(`@Confiqure.User.Setting\nclass MyPrefs {}`)).toEqual({ kind: "USER_SETTING", end: null, callback: null });
  });
  it("reads @Confiqure.Setting and @Confiqure.User.List", () => {
    expect(objectAnnotation(`@Confiqure.Setting(end = "/prefs")\nclass P {}`)).toEqual({ kind: "SETTING", end: "/prefs", callback: null });
    expect(objectAnnotation(`@Confiqure.User.List(end = "/mine")\nclass M {}`)).toEqual({ kind: "USER_LIST", end: "/mine", callback: null });
  });
  it("reads @Confiqure.Facts(callback)", () => {
    expect(objectAnnotation(`@Confiqure.Facts(callback = "/api/confiqure/user-facts")\nclass SellerFacts {}`))
      .toEqual({ kind: "FACTS", end: null, callback: "/api/confiqure/user-facts" });
  });
  it("returns null for the old class form (rejected by lint, not scanned)", () => {
    expect(objectAnnotation(`@Confiqure(end = "/x", type = Confiqure.Type.MULTI)\nclass X {}`)).toBeNull();
  });
  it("identityFieldOf is null when no field carries @Confiqure.Identity", () => {
    expect(identityFieldOf(`@Confiqure.List(end = "/x")\nclass X { private String a; }`)).toBeNull();
  });
});

describe("scanProject — two objects on one address (review finding 2)", () => {
  it("is a warning, not a push-blocking error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cq-dup-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/A.java"), `@Confiqure.Setting(end = "/same")\npublic class A { private String a; }`);
    await writeFile(join(dir, "src/B.java"), `@Confiqure.Setting(end = "/same")\npublic class B { private String b; }`);
    const scan = await scanProject(dir, { ...DEFAULT_CONFIG, scanPaths: ["src"] });
    await rm(dir, { recursive: true, force: true });
    expect(scan.annotated.map((c) => c.configEnd)).toEqual(["/same", "/same"]);
    expect(scan.errors).toEqual([]);
  });
  it("takes end from a bare imported annotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cq-bare-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/A.java"), `import ai.confiqure.Confiqure.List;\n@List(end = "/bare")\npublic class A { private String a; }`);
    const scan = await scanProject(dir, { ...DEFAULT_CONFIG, scanPaths: ["src"] });
    await rm(dir, { recursive: true, force: true });
    expect(scan.annotated.map((c) => [c.configEnd, c.objectKind])).toEqual([["/bare", "LIST"]]);
  });
});

describe("scanProject 1.0.1 — same-named objects in different packages keep their own kind and end", () => {
  it("reads each object's annotation from its own file", async () => {
    const { rm } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "cq-same-"));
    try {
      await mkdir(join(dir, "src/a"), { recursive: true });
      await mkdir(join(dir, "src/b"), { recursive: true });
      await writeFile(join(dir, "src/a/Prefs.java"), `package a;\n@Confiqure.Setting(end = "/a-prefs")\npublic class Prefs { private String x; }`);
      await writeFile(join(dir, "src/b/Prefs.java"), `package b;\n@Confiqure.List(end = "/b-prefs")\npublic class Prefs { @Confiqure.Identity private String sku; }`);
      const scan = await scanProject(dir, { ...DEFAULT_CONFIG, scanPaths: ["src"] });
      const got = scan.annotated.map((c) => [c.filePath, c.objectKind, c.configEnd, c.identityField]).sort();
      expect(got).toEqual([
        ["src/a/Prefs.java", "SETTING", "/a-prefs", null],
        ["src/b/Prefs.java", "LIST", "/b-prefs", "sku"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
