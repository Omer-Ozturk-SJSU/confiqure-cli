import { describe, it, expect } from "vitest";
import { parseJavaFiles } from "./classTree.js";
import { lintCheckRefs } from "./lint.js";

// Annotation 3.1 host checks: the engine calls <Class>.validate / <Class>.verify through the pushed tool class's
// operation row, found by its tool name. Every way that route could fail to resolve fails the push instead.
async function lint(files: Record<string, string>): Promise<string[]> {
  return lintCheckRefs(await parseJavaFiles(new Map(Object.entries(files))));
}

const settings = (field: string) => `import ai.confiqure.Confiqure;
@Confiqure.Setting(end = "/catalog-settings")
public class CatalogSettings {
${field}
}`;

const CHECK = `import ai.confiqure.Confiqure;
import ai.confiqure.ConfiqureVerifier;
@Confiqure.Tool
@RestController
public class CatalogCheck implements ConfiqureVerifier<String> {
  @PostMapping("/checks/catalog")
  public Confiqure.Verdict<String> verify(@RequestBody Confiqure.Check<String> check) { return Confiqure.Verdict.ok(); }
}`;

const FORMAT = `import ai.confiqure.Confiqure;
import ai.confiqure.ConfiqureValidator;
@Confiqure.Tool
@RestController
public class SkuFormat implements ConfiqureValidator<String> {
  @PostMapping("/checks/sku-format")
  public Confiqure.Verdict<Void> validate(@RequestBody Confiqure.Check<String> check) { return Confiqure.Verdict.ok(); }
}`;

describe("lintCheckRefs — ValidatedBy / VerifiedBy name a pushed tool class the engine can call", () => {
  it("is silent on a verifier and a validator that resolve, on a field and on a request class, with message", async () => {
    const errors = await lint({
      "a/CatalogSettings.java": settings(
        `  @Confiqure.VerifiedBy(value = CatalogCheck.class, message = "No product has that code.")\n  private String productCode;\n` +
          `  @Confiqure.ValidatedBy(SkuFormat.class)\n  private String sku;`
      ),
      "a/PriceTool.java": `import ai.confiqure.Confiqure;
@Confiqure.Tool
public class PriceTool {
  @Confiqure.VerifiedBy(CatalogCheck.class)
  public static class PriceChange { public String sku; }
  @PostMapping("/price") public Ack setPrice(@RequestBody PriceChange c) { return null; }
}`,
      "a/CatalogCheck.java": CHECK,
      "a/SkuFormat.java": FORMAT,
    });
    expect(errors).toEqual([]);
  });

  it("the bare imported form resolves too", async () => {
    const errors = await lint({
      "a/CatalogSettings.java": `import ai.confiqure.Confiqure.VerifiedBy;
@ai.confiqure.Confiqure.Setting(end = "/s")
public class CatalogSettings {
  @VerifiedBy(CatalogCheck.class) private String productCode;
}`,
      "a/CatalogCheck.java": CHECK,
    });
    expect(errors).toEqual([]);
  });

  it("the pre-release string form names the class form", async () => {
    const errors = await lint({
      "a/CatalogSettings.java": settings(`  @Confiqure.VerifiedBy("CatalogCheck.verify")\n  private String productCode;`),
      "a/CatalogCheck.java": CHECK,
    });
    expect(errors).toEqual([
      'a/CatalogSettings.java:4: CatalogSettings.productCode — @Confiqure.VerifiedBy("CatalogCheck.verify") must name its check class, ' +
        "e.g. @Confiqure.VerifiedBy(CatalogCheck.class): a @Confiqure.Tool class implementing ConfiqureVerifier.",
    ]);
  });

  it("a class that is not a pushed tool class", async () => {
    const errors = await lint({ "a/CatalogSettings.java": settings(`  @Confiqure.ValidatedBy(SkuFormat.class)\n  private String sku;`) });
    expect(errors).toEqual([
      "a/CatalogSettings.java:4: CatalogSettings.sku — @Confiqure.ValidatedBy names SkuFormat, which is not a @Confiqure.Tool class in this push, " +
        "so the engine could not call SkuFormat.validate. Annotate it with @Confiqure.Tool and implement ConfiqureValidator.",
    ]);
  });

  it("two tool classes with the check's simple name", async () => {
    const errors = await lint({
      "a/CatalogSettings.java": settings(`  @Confiqure.VerifiedBy(CatalogCheck.class)\n  private String productCode;`),
      "a/CatalogCheck.java": CHECK,
      "b/CatalogCheck.java": CHECK,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("2 tool classes have that name (a/CatalogCheck.java, b/CatalogCheck.java)");
  });

  it("a tool name that differs from the class name", async () => {
    const errors = await lint({
      "a/CatalogSettings.java": settings(`  @Confiqure.VerifiedBy(CatalogCheck.class)\n  private String productCode;`),
      "a/CatalogCheck.java": CHECK.replace("@Confiqure.Tool\n", '@Confiqure.Tool(name = "Catalog")\n'),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('whose @Confiqure.Tool name is "Catalog"; the engine calls a check as CatalogCheck.verify');
  });

  it("a validator named where a verifier is expected has no verify operation", async () => {
    const errors = await lint({
      "a/CatalogSettings.java": settings(`  @Confiqure.VerifiedBy(SkuFormat.class)\n  private String sku;`),
      "a/SkuFormat.java": FORMAT,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("SkuFormat, which has no public verify operation: implement ConfiqureVerifier and map verify with @PostMapping.");
  });

  it("a check that cannot answer at once (Browser or Async)", async () => {
    for (const marker of ["Browser", "Async"]) {
      const errors = await lint({
        "a/CatalogSettings.java": settings(`  @Confiqure.VerifiedBy(CatalogCheck.class)\n  private String productCode;`),
        "a/CatalogCheck.java": CHECK.replace('  @PostMapping("/checks/catalog")', `  @Confiqure.${marker}\n  @PostMapping("/checks/catalog")`),
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`whose verify is @Confiqure.${marker}; a check must answer at once`);
    }
  });
});
