import { describe, it, expect } from "vitest";
import { parseJavaFiles } from "./classTree.js";
import { lintBundle } from "./lint.js";

async function lint(files: Record<string, string>): Promise<string[]> {
  const parsed = await parseJavaFiles(new Map(Object.entries(files)));
  return lintBundle(parsed);
}

// The conv-101 shape: a field binds to an INNER FloorMethod, but a divergent TOP-LEVEL FloorMethod
// ships in the same bundle — the collision that made the green-test reject a valid MARGIN_PERCENT.
const AMZ_REPRICER = `
package v2.ai.easelist.dtos.repricer;
public class AmzRepricerConfig {
    private FloorMethod floorMethod = FloorMethod.MARGIN_PERCENT;
    public enum FloorMethod { MARGIN_PERCENT, ROI_PERCENT, FIXED_PROFIT }
}`;
const TOP_LEVEL_FLOOR = `
package v2.ai.easelist.dtos.repricer;
public enum FloorMethod { TARGET_MARGIN, TARGET_ROI, FIXED_PROFIT, BREAKEVEN_LIQUIDATE }`;

describe("lintBundle (#83 — simple-name enum collisions + bad enum defaults)", () => {
  it("flags two same-named enums with divergent constants", async () => {
    const warnings = await lint({
      "AmzRepricerConfig.java": AMZ_REPRICER,
      "FloorMethod.java": TOP_LEVEL_FLOOR,
    });
    expect(warnings.some((w) => w.includes("enums named 'FloorMethod'") && w.includes("different constants")))
      .toBe(true);
  });

  it("does NOT flag the field default that is valid for the resolved INNER enum (scope-aware)", async () => {
    const warnings = await lint({
      "AmzRepricerConfig.java": AMZ_REPRICER,
      "FloorMethod.java": TOP_LEVEL_FLOOR,
    });
    // MARGIN_PERCENT is a real constant of the inner FloorMethod the field uses — no (b) warning.
    expect(warnings.some((w) => w.includes("floorMethod defaults to"))).toBe(false);
  });

  it("flags a default referencing a constant absent from the resolved enum", async () => {
    const badDefault = `
      public class Cfg {
          private FloorMethod floorMethod = FloorMethod.TARGET_MARGIN;
          public enum FloorMethod { MARGIN_PERCENT, ROI_PERCENT, FIXED_PROFIT }
      }`;
    const warnings = await lint({ "Cfg.java": badDefault });
    expect(warnings.some((w) =>
      w.includes("Cfg.floorMethod defaults to FloorMethod.TARGET_MARGIN") &&
      w.includes("not a constant"))).toBe(true);
  });

  it("is silent on a clean bundle (one enum, valid default)", async () => {
    const clean = `
      public class Paint {
          private Color color = Color.RED;
          public enum Color { RED, GREEN, BLUE }
      }`;
    expect(await lint({ "Paint.java": clean })).toEqual([]);
  });

  it("does not flag identical same-named enums (copies, not a divergence)", async () => {
    const copyA = `public enum Mode { FAST, SLOW }`;
    const copyB = `public enum Mode { FAST, SLOW }`;
    const warnings = await lint({ "a/Mode.java": copyA, "b/Mode.java": copyB });
    expect(warnings.some((w) => w.includes("enums named 'Mode'"))).toBe(false);
  });

  it("ignores non-enum field initializers (no false positive on a static constant)", async () => {
    const src = `
      public class Cfg {
          private int limit = Limits.MAX;
          private String name = "default";
      }`;
    expect(await lint({ "Cfg.java": src })).toEqual([]);
  });
});

describe("lintBundle (#140 — @Confiqure root extends a base absent from the push)", () => {
  it("warns when the base class source isn't in the bundle", async () => {
    const warnings = await lint({
      "AsinDiscovery.java": `@ai.confiqure.annotation.Confiqure
        public class AsinDiscovery extends Discovery { private String extra; }`,
      // Discovery.java is intentionally NOT in the bundle (out of scanPaths).
    });
    expect(warnings.some((w) =>
      w.includes("AsinDiscovery extends Discovery") && w.includes("isn't in this push"))).toBe(true);
  });

  it("is silent when the base IS in the bundle", async () => {
    const warnings = await lint({
      "AsinDiscovery.java": `@ai.confiqure.annotation.Confiqure
        public class AsinDiscovery extends Discovery { private String extra; }`,
      "Discovery.java": `public class Discovery { private Integer minSalesRank; }`,
    });
    expect(warnings.some((w) => w.includes("isn't in this push"))).toBe(false);
  });

  it("does not warn for a non-@Confiqure class extending an absent base", async () => {
    const warnings = await lint({
      "Helper.java": `public class Helper extends SomeLibraryBase { private String x; }`,
    });
    expect(warnings.some((w) => w.includes("isn't in this push"))).toBe(false);
  });

  it("does not warn on `implements` (only `extends` carries invisible instance fields)", async () => {
    const warnings = await lint({
      "Root.java": `@ai.confiqure.annotation.Confiqure
        public class Root implements java.io.Serializable { private String x; }`,
    });
    expect(warnings.some((w) => w.includes("isn't in this push"))).toBe(false);
  });
});
