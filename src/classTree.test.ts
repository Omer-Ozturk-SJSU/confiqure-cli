import { describe, it, expect } from "vitest";
import { parseJavaFiles, buildClassTrees, collectToolReachableFiles } from "./classTree.js";

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
import ai.confiqure.annotation.Confiqure;
@Confiqure(end = "/asin-discovery")
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
      "Root.java": `@ai.confiqure.annotation.Confiqure
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
      "Root.java": `@ai.confiqure.annotation.Confiqure
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

describe("collectToolReachableFiles — #140 follow `extends` from tool DTOs", () => {
  it("walks a tool input DTO's ancestor chain", async () => {
    const files = {
      "ToolCtl.java": `public class ToolCtl {
          @ai.confiqure.annotation.Confiqure.Tool
          public String run(@org.springframework.web.bind.annotation.RequestBody CreateReq req) { return ""; }
        }`,
      "CreateReq.java": `public class CreateReq extends BaseReq { private String extra; }`,
      "BaseReq.java": `public class BaseReq { private Payload payload; }`,
      "Payload.java": `public class Payload { private String data; }`,
    };
    const parsed = await parseJavaFiles(new Map(Object.entries(files)));
    const tools = parsed.flatMap((p) => p.tools);
    const reach = collectToolReachableFiles(parsed, tools);
    expect(reach).toContain("CreateReq.java");
    expect(reach).toContain("BaseReq.java");
    expect(reach).toContain("Payload.java");
  });
});
