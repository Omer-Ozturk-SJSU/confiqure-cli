import { describe, it, expect } from "vitest";
import { parseJavaFiles, buildClassTrees, collectToolReachableFiles } from "./classTree.js";
import { lintToolClasses } from "./lint.js";

/**
 * #140/#141 — the reachability closure of a `@Confiqure` endpoint must be the transitive
 * closure of its FIELD types AND its ancestor chain (`extends`/`implements`), and NOTHING
 * else (no controllers, no unrelated domains, no tests). These fixtures model the EaseList
 * discovery hierarchy in miniature: a base class carrying the core fields, a subclass
 * annotated as the endpoint, the DTOs both reference, plus decoy files (a tool controller
 * and a test) that must never enter the closure.
 */

// The annotated endpoint — its own fields are thin; the CORE lives on the base (#140).
const ASIN_DISCOVERY = `
package dtos.confiqure.restocker;
import ai.confiqure.Confiqure;
@Confiqure.List(end = "/asin-discovery")
public class AsinDiscovery extends Discovery {
    private OfferSpecifics offerSpecifics;
}`;

// The base class: the config core is declared here and inherited by every discovery endpoint.
const DISCOVERY_BASE = `
package dtos.confiqure.restocker;
public class Discovery {
    private String discoveryName;
    private Integer minSalesRank;
    private Integer maxSalesRank;
    private AmazonItemSpecifics itemSpecifics;
    private ItemCategorySpecifics categorySpecifics;
}`;

const AMAZON_ITEM_SPECIFICS = `
package dtos.confiqure.restocker;
public class AmazonItemSpecifics {
    private String asin;
    private Condition condition;
}`;

const ITEM_CATEGORY_SPECIFICS = `
package dtos.confiqure.restocker;
public class ItemCategorySpecifics {
    private String categoryId;
}`;

const OFFER_SPECIFICS = `
package dtos.confiqure.restocker;
public class OfferSpecifics {
    private Integer quantity;
}`;

const CONDITION_ENUM = `
package dtos.confiqure.restocker;
public enum Condition { NEW, USED, REFURBISHED }`;

// A decoy: a tool controller that references AsinDiscovery. Reachability is DIRECTIONAL
// (a DTO never references a controller), so this must NOT land in the endpoint's closure.
const CONTROLLER = `
package controllers;
import dtos.confiqure.restocker.AsinDiscovery;
public class ConfiqureController {
    private AsinDiscovery config;
}`;

const FIXTURE: Record<string, string> = {
  "src/main/java/dtos/confiqure/restocker/AsinDiscovery.java": ASIN_DISCOVERY,
  "src/main/java/dtos/confiqure/restocker/Discovery.java": DISCOVERY_BASE,
  "src/main/java/dtos/confiqure/restocker/AmazonItemSpecifics.java": AMAZON_ITEM_SPECIFICS,
  "src/main/java/dtos/confiqure/restocker/ItemCategorySpecifics.java": ITEM_CATEGORY_SPECIFICS,
  "src/main/java/dtos/confiqure/restocker/OfferSpecifics.java": OFFER_SPECIFICS,
  "src/main/java/dtos/confiqure/restocker/Condition.java": CONDITION_ENUM,
  "src/main/java/controllers/ConfiqureController.java": CONTROLLER,
};

async function reachOf(rootClass: string, files: Record<string, string>): Promise<Set<string>> {
  const parsed = await parseJavaFiles(new Map(Object.entries(files)));
  const { trees } = buildClassTrees(parsed);
  const tree = trees.find((t) => t.rootClass === rootClass);
  if (!tree) throw new Error(`no tree for ${rootClass}`);
  return tree.reachableFiles;
}

describe("buildClassTrees — #140 follow `extends`", () => {
  it("pulls the superclass source into the endpoint closure", async () => {
    const reach = await reachOf("AsinDiscovery", FIXTURE);
    expect(reach).toContain("src/main/java/dtos/confiqure/restocker/Discovery.java");
  });

  it("pulls the superclass's referenced types (transitively) into the closure", async () => {
    const reach = await reachOf("AsinDiscovery", FIXTURE);
    // itemSpecifics / categorySpecifics are declared on the BASE — invisible before the fix.
    expect(reach).toContain("src/main/java/dtos/confiqure/restocker/AmazonItemSpecifics.java");
    expect(reach).toContain("src/main/java/dtos/confiqure/restocker/ItemCategorySpecifics.java");
    // and an enum referenced two hops deep (base field → DTO field → enum).
    expect(reach).toContain("src/main/java/dtos/confiqure/restocker/Condition.java");
  });

  it("still includes the endpoint's own root + own field types", async () => {
    const reach = await reachOf("AsinDiscovery", FIXTURE);
    expect(reach).toContain("src/main/java/dtos/confiqure/restocker/AsinDiscovery.java");
    expect(reach).toContain("src/main/java/dtos/confiqure/restocker/OfferSpecifics.java");
  });
});

describe("buildClassTrees — #141 no kitchen-sink", () => {
  it("excludes a controller that references the endpoint (reachability is directional)", async () => {
    const reach = await reachOf("AsinDiscovery", FIXTURE);
    expect(reach).not.toContain("src/main/java/controllers/ConfiqureController.java");
  });

  it("closure is EXACTLY the field+ancestor transitive set, nothing more", async () => {
    const reach = await reachOf("AsinDiscovery", FIXTURE);
    expect([...reach].sort()).toEqual([
      "src/main/java/dtos/confiqure/restocker/AmazonItemSpecifics.java",
      "src/main/java/dtos/confiqure/restocker/AsinDiscovery.java",
      "src/main/java/dtos/confiqure/restocker/Condition.java",
      "src/main/java/dtos/confiqure/restocker/Discovery.java",
      "src/main/java/dtos/confiqure/restocker/ItemCategorySpecifics.java",
      "src/main/java/dtos/confiqure/restocker/OfferSpecifics.java",
    ]);
  });
});

describe("buildClassTrees — #140 interface `extends`/`implements`", () => {
  it("includes an implemented interface's source and follows the interface `extends` chain", async () => {
    const files = {
      "Root.java": `@ai.confiqure.Confiqure.Setting
        public class Root implements Auditable {
          private String name;
        }`,
      "Auditable.java": `public interface Auditable extends Timestamped { void audit(); }`,
      "Timestamped.java": `public interface Timestamped { long ts(); }`,
    };
    const reach = await reachOf("Root", files);
    // The contract sources ship so the model sees what the endpoint promises to implement...
    expect(reach).toContain("Auditable.java");
    expect(reach).toContain("Timestamped.java");
  });

  it("does NOT pull in a type referenced only by an interface METHOD signature (avoids #141 bloat)", async () => {
    const files = {
      "Root.java": `@ai.confiqure.Confiqure.Setting
        public class Root implements HasAudit { private String name; }`,
      "HasAudit.java": `public interface HasAudit { AuditReport getReport(Controller c); }`,
      "AuditReport.java": `public class AuditReport { private String s; }`,
      "Controller.java": `public class Controller { private String s; }`,
    };
    const reach = await reachOf("Root", files);
    expect(reach).toContain("HasAudit.java"); // the ancestor source itself ships
    // ...but method params/returns are NOT config state — walking them would drag controllers back in.
    expect(reach).not.toContain("AuditReport.java");
    expect(reach).not.toContain("Controller.java");
  });
});

describe("collectToolReachableFiles — tool-class DTOs ship with their ancestors and generics", () => {
  it("walks an operation's input DTO ancestor chain and unwraps a generic return type", async () => {
    const files = {
      "ToolCtl.java": `@ai.confiqure.Confiqure.Tool(name = "ToolCtl")
        @RequestMapping("/api")
        public class ToolCtl {
          @PostMapping("/run")
          public List<Result> run(@org.springframework.web.bind.annotation.RequestBody CreateReq req) { return null; }
        }`,
      "CreateReq.java": `public class CreateReq extends BaseReq { private String extra; }`,
      "BaseReq.java": `public class BaseReq { private Payload payload; }`,
      "Payload.java": `public class Payload { private String data; }`,
      "Result.java": `public class Result { private String r; }`,
      "Unrelated.java": `public class Unrelated { private String u; }`,
    };
    const parsed = await parseJavaFiles(new Map(Object.entries(files)));
    const toolClasses = parsed.flatMap((p) => p.toolClasses);
    const reach = collectToolReachableFiles(parsed, toolClasses);
    expect([...reach].sort()).toEqual(["BaseReq.java", "CreateReq.java", "Payload.java", "Result.java"]);
  });
});

describe("buildClassTrees — 3.0 object roots", () => {
  it("roots only 3.0 object annotations and carries kind + identity field", async () => {
    const files = {
      "L.java": `@Confiqure.List(end = "/l")\npublic class L { @Confiqure.Identity private String sku; private Part p; }`,
      "S.java": `@ai.confiqure.Confiqure.User.Setting\npublic class S { private String a; }`,
      "F.java": `@Confiqure.Facts(callback = "/f")\npublic class F { private String a; }`,
      "Part.java": `public class Part { private String x; }`,
      "Old.java": `@Confiqure(end = "/old")\npublic class Old { private String a; }`,
      "T.java": `@Confiqure.Tool(name = "T")\npublic class T { }`,
    };
    const parsed = await parseJavaFiles(new Map(Object.entries(files)));
    const { trees } = buildClassTrees(parsed);
    expect(trees.map((t) => t.rootClass).sort()).toEqual(["F", "L", "S"]);
    const decls = new Map(parsed.flatMap((p) => p.declarations).map((d) => [d.name, d]));
    expect(decls.get("L")!.objectKind).toBe("LIST");
    expect(decls.get("L")!.identityField).toBe("sku");
    expect(decls.get("S")!.objectKind).toBe("USER_SETTING");
    expect(decls.get("F")!.objectKind).toBe("FACTS");
    expect(decls.get("Part")!.objectKind).toBeNull();
    expect(decls.get("Old")!.objectKind).toBeNull();
  });
});

async function parseOne(filePath: string, src: string) {
  const [pf] = await parseJavaFiles(new Map([[filePath, src]]));
  return pf;
}

describe("tool classes (3.0)", () => {
  it("parses a tool class with Spring mappings, @Browser and @Async", async () => {
    const src = `
    /** FLOW: find, then change. */
    @Confiqure.Tool(name = "ListingsTool")
    @RestController
    @RequestMapping("/api/confiqure/listings")
    public class ListingsTool {
      @PostMapping("/by-title") public List<Listing> byTitle(@RequestBody TitleQuery q) { return null; }
      @Confiqure.Browser public Ack openProduct360(@RequestBody SkuRef ref) { return null; }
      @Confiqure.Async @PostMapping("/analyze") public ResponseEntity<Void> analyze(@RequestBody SkuRef ref) { return null; }
      private String helper() { return ""; }
    }`;
    const pf = await parseOne("a/ListingsTool.java", src);
    expect(pf.toolClasses).toHaveLength(1);
    const tc = pf.toolClasses[0];
    expect(tc.name).toBe("ListingsTool");
    expect(tc.className).toBe("ListingsTool");
    expect(tc.classUniqueId).toBe("a/ListingsTool.java");
    expect(tc.doc).toContain("FLOW: find, then change.");
    expect(tc.operations.map((o) => o.name)).toEqual(["byTitle", "openProduct360", "analyze"]);
    expect(tc.operations[0]).toMatchObject({ httpMethod: "POST", path: "/api/confiqure/listings/by-title", inputType: "TitleQuery", returnType: "List<Listing>", browser: false, async: false });
    expect(tc.operations[1]).toMatchObject({ browser: true, httpMethod: null, path: null, inputType: "SkuRef", returnType: "Ack" });
    expect(tc.operations[2]).toMatchObject({ async: true, httpMethod: "POST", path: "/api/confiqure/listings/analyze" });
  });

  it("reads every Spring mapping form: Get/Put/Delete, value=/path=, RequestMapping(method), no class base", async () => {
    const src = `
    @Confiqure.Tool
    public class Misc {
      /** Reads one. */
      @GetMapping(value = "/one") public Item one(@RequestParam String id) { return null; }
      @PutMapping(path = "items/") public Ack put(@RequestBody Item i) { return null; }
      @DeleteMapping({"/items/del"}) public Ack del(@RequestBody Ref r) { return null; }
      @RequestMapping(value = "/rm", method = RequestMethod.GET) public Ack rm() { return null; }
      @RequestMapping("/rm-default") public Ack rmDefault(@RequestBody Ref r) { return null; }
    }`;
    const tc = (await parseOne("b/Misc.java", src)).toolClasses[0];
    expect(tc.name).toBe("Misc");
    expect(tc.doc).toBeNull();
    const byName = new Map(tc.operations.map((o) => [o.name, o]));
    expect(byName.get("one")).toMatchObject({ httpMethod: "GET", path: "/one", inputType: "String", doc: "/** Reads one. */" });
    expect(byName.get("put")).toMatchObject({ httpMethod: "PUT", path: "/items" });
    expect(byName.get("del")).toMatchObject({ httpMethod: "DELETE", path: "/items/del" });
    expect(byName.get("rm")).toMatchObject({ httpMethod: "GET", path: "/rm", inputType: null });
    expect(byName.get("rmDefault")).toMatchObject({ httpMethod: "POST", path: "/rm-default" });
  });

  it("a bare @Async is Spring's unless the file imports Confiqure's", async () => {
    const spring = await parseOne("c/S.java", `@Confiqure.Tool public class S { @Async @PostMapping("/x") public Ack x(@RequestBody Q q) { return null; } }`);
    expect(spring.toolClasses[0].operations[0].async).toBe(false);
    const ours = await parseOne("c/O.java", `import ai.confiqure.Confiqure.Async;\n@Confiqure.Tool public class O { @Async @PostMapping("/x") public Ack x(@RequestBody Q q) { return null; } }`);
    expect(ours.toolClasses[0].operations[0].async).toBe(true);
  });

  it("a class without @Confiqure.Tool is not a tool class", async () => {
    const pf = await parseOne("d/C.java", `@RestController public class C { @PostMapping("/x") public Ack x() { return null; } }`);
    expect(pf.toolClasses).toEqual([]);
  });

  it("lint: a public operation with neither a mapping nor @Browser is an error", () => {
    const errors = lintToolClasses([{ name: "T", className: "T", classUniqueId: "a/T.java", doc: "x", sourceFile: "a/T.java",
      operations: [{ name: "orphan", httpMethod: null, path: null, browser: false, async: false, inputType: "Q", returnType: "R", doc: null }] }]);
    expect(errors).toEqual(["a/T.java: operation `orphan` has no @PostMapping and is not @Confiqure.Browser — confiqure cannot call it."]);
  });
});

describe("3.0 review fixes", () => {
  it("POST-only: a tool-class operation with Get/Put/Delete/Patch mapping is an error", async () => {
    const src = `@Confiqure.Tool(name = "Shop")
    @RequestMapping("/api")
    public class ShopTool {
      @PostMapping("/ok") public Ack ok(@RequestBody Q q) { return null; }
      @GetMapping("/g") public Ack g() { return null; }
      @PutMapping("/p") public Ack p(@RequestBody Q q) { return null; }
      @DeleteMapping("/d") public Ack d(@RequestBody Q q) { return null; }
      @PatchMapping("/pa") public Ack pa(@RequestBody Q q) { return null; }
      @RequestMapping(value = "/rm", method = RequestMethod.GET) public Ack rm() { return null; }
      @RequestMapping("/rm-plain") public Ack rmPlain(@RequestBody Q q) { return null; }
    }`;
    const tc = (await parseOne("s/ShopTool.java", src)).toolClasses[0];
    expect(lintToolClasses([tc])).toEqual([
      "s/ShopTool.java: 3.0 operations use @PostMapping; Shop.g declares @GetMapping.",
      "s/ShopTool.java: 3.0 operations use @PostMapping; Shop.p declares @PutMapping.",
      "s/ShopTool.java: 3.0 operations use @PostMapping; Shop.d declares @DeleteMapping.",
      "s/ShopTool.java: 3.0 operations use @PostMapping; Shop.pa declares @PatchMapping.",
      "s/ShopTool.java: 3.0 operations use @PostMapping; Shop.rm declares @RequestMapping(method = GET).",
      "s/ShopTool.java: 3.0 operations use @PostMapping; Shop.rmPlain declares @RequestMapping.",
    ]);
  });

  it("bare @Setting/@List/@User.Setting/@Identity count when imported from ai.confiqure.Confiqure", async () => {
    const files = {
      "A.java": `import ai.confiqure.Confiqure.List;\nimport ai.confiqure.Confiqure.Identity;\n@List(end = "/a")\npublic class A { @Identity private String sku; }`,
      "B.java": `import ai.confiqure.Confiqure.*;\n@Setting\npublic class B { private String x; }`,
      "C.java": `import ai.confiqure.Confiqure.User;\n@User.Setting(end = "/c")\npublic class C { private String x; }`,
      "D.java": `import java.util.List;\n@List\npublic class D { private String x; }`,
      "E.java": `import ai.confiqure.Confiqure.Facts;\n@Facts(callback = "/f")\npublic class E { private String x; }`,
    };
    const parsed = await parseJavaFiles(new Map(Object.entries(files)));
    const decls = new Map(parsed.flatMap((p) => p.declarations).map((d) => [d.name, d]));
    expect(decls.get("A")).toMatchObject({ objectKind: "LIST", identityField: "sku", objectEnd: "/a" });
    expect(decls.get("B")).toMatchObject({ objectKind: "SETTING", objectEnd: null });
    expect(decls.get("C")).toMatchObject({ objectKind: "USER_SETTING", objectEnd: "/c" });
    expect(decls.get("D")!.objectKind).toBeNull();
    expect(decls.get("E")).toMatchObject({ objectKind: "FACTS", objectCallback: "/f" });
  });
});
