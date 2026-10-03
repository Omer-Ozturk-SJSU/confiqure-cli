import { describe, it, expect } from "vitest";
import { parseJavaFiles } from "./classTree.js";
import { lintAnnotationLiterals } from "./lint.js";

// Row 9217: confiqure reads these annotation members only as a string literal or literals joined
// with +. Anything else reaches the engine as nothing (a blank confirm card, a gate switched off),
// or reaches the CLI as the constant's own name — so it fails the push, where the developer looks.
async function lint(files: Record<string, string>): Promise<string[]> {
  return lintAnnotationLiterals(await parseJavaFiles(new Map(Object.entries(files))));
}

const obj = (body: string) => `import ai.confiqure.Confiqure;
@Confiqure.Setting(end = "/s")
public class S {
${body}
}`;

describe("lintAnnotationLiterals — engine-read members", () => {
  it("Consent text as a constant: names file, line, field, member, and the blank confirm card", async () => {
    const errors = await lint({ "a/S.java": obj(`  @Confiqure.Consent(id = "terms", text = AutoCheckoutConsent.TEXT)\n  private Boolean accepted;`) });
    expect(errors).toEqual([
      "a/S.java:4: S.accepted — the text of @Confiqure.Consent is AutoCheckoutConsent.TEXT, not a string literal. " +
        "confiqure reads only a string literal (or literals joined with +), so the confirm card would show no terms. Write it inline.",
    ]);
  });

  it("Consent id as a constant drops the consent", async () => {
    const [e] = await lint({ "a/S.java": obj(`  @Confiqure.Consent(id = Ids.TERMS, text = "I agree")\n  private Boolean accepted;`) });
    expect(e).toContain("the id of @Confiqure.Consent is Ids.TERMS");
    expect(e).toContain("the consent would be dropped");
  });

  it("Gate and SectionGate: requires switches the gate off, message empties the refusal", async () => {
    const errors = await lint({
      "a/S.java": obj(
        `  @Confiqure.Gate(requires = Rules.ACCEPTED, message = "Accept first")\n  private String siteUrl;\n` +
          `  @Confiqure.SectionGate(requires = "accepted == true", message = Msgs.BILLING)\n  private Billing billing;`
      ),
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("S.siteUrl — the requires of @Confiqure.Gate is Rules.ACCEPTED");
    expect(errors[0]).toContain("the gate would be switched off");
    expect(errors[1]).toContain("S.billing — the message of @Confiqure.SectionGate is Msgs.BILLING");
    expect(errors[1]).toContain("a refusal would carry no reason");
  });

  it("ToolGate tool, requires and message, alone and inside ToolGates", async () => {
    const errors = await lint({
      "a/S.java": `import ai.confiqure.Confiqure;
@Confiqure.ToolGate(tool = Tools.ANALYSER, requires = "accepted == true", message = "Accept first")
@Confiqure.ToolGates({
  @Confiqure.ToolGate(tool = "LOGIN", requires = Rules.R, message = "m"),
  @Confiqure.ToolGate(tool = "OTHER", requires = "x == true", message = Msgs.M)
})
@Confiqure.Setting(end = "/s")
public class S { private String a; }`,
    });
    expect(errors.map((e) => e.replace(/ —.*? is /, " | ").split(", not")[0])).toEqual([
      "a/S.java:2: class S | Tools.ANALYSER",
      "a/S.java:4: class S | Rules.R",
      "a/S.java:5: class S | Msgs.M",
    ]);
    expect(errors[0]).toContain("the tool of @Confiqure.ToolGate");
  });

  it("a text block is refused (the engine reads it as nothing); a + join of literals passes", async () => {
    const errors = await lint({
      "a/S.java": obj(
        `  @Confiqure.Consent(id = "a", text = """\n      Long terms.\n      """)\n  private Boolean a;\n` +
          `  @Confiqure.Consent(id = "b", text = "Line one, " +\n      "line two.")\n  private Boolean b;`
      ),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("S.a — the text of @Confiqure.Consent is a text block (\"\"\")");
    expect(errors[0]).toContain("confiqure reads text blocks as nothing for now");
  });

  it("parentheses around a literal are not read by the engine either", async () => {
    const [e] = await lint({ "a/S.java": obj(`  @Confiqure.Consent(id = "a", text = "x" + ("y"))\n  private Boolean a;`) });
    expect(e).toContain(`the text of @Confiqure.Consent is "x" + ("y")`);
  });
});

describe("lintAnnotationLiterals — members the CLI itself reads", () => {
  it("Tool name, an object's end and a Facts callback as constants", async () => {
    const errors = await lint({
      "t/T.java": `import ai.confiqure.Confiqure;\n@Confiqure.Tool(name = Names.LISTINGS)\npublic class T { @PostMapping("/x") public Ack x(@RequestBody Q q) { return null; } }`,
      "o/O.java": `import ai.confiqure.Confiqure;\n@Confiqure.List(end = Ends.REPRICING)\npublic class O { private String a; }`,
      "f/F.java": `import ai.confiqure.Confiqure;\n@Confiqure.Facts(callback = Paths.FACTS)\npublic class F { private String a; }`,
    });
    expect(errors).toHaveLength(3);
    const byFile = Object.fromEntries(errors.map((e) => [e.split(":")[0], e]));
    expect(byFile["t/T.java"]).toContain("class T — the name of @Confiqure.Tool is Names.LISTINGS");
    expect(byFile["t/T.java"]).toContain("the push would use the constant's own name");
    expect(byFile["o/O.java"]).toContain("the end of @Confiqure.List is Ends.REPRICING");
    expect(byFile["f/F.java"]).toContain("the callback of @Confiqure.Facts is Paths.FACTS");
  });

  it("a Spring path constant on a tool class or its operation says so, instead of a wrong or missing URL", async () => {
    const errors = await lint({
      "t/T.java": `import ai.confiqure.Confiqure;
@Confiqure.Tool(name = "T")
@RequestMapping(Api.BASE)
public class T {
  @PostMapping(Paths.BY_TITLE) public Ack byTitle(@RequestBody Q q) { return null; }
  @PostMapping(value = {"/a", "/b"}) public Ack ok(@RequestBody Q q) { return null; }
  @PostMapping(path = "/c" + "/d") public Ack joined(@RequestBody Q q) { return null; }
}`,
    });
    expect(errors).toEqual([
      "t/T.java:3: class T — the path of @RequestMapping is Api.BASE, not a string literal. " +
        "confiqure reads only a string literal (or literals joined with +), so the operation URLs would be wrong. Write it inline.",
      "t/T.java:5: T.byTitle() — the path of @PostMapping is Paths.BY_TITLE, not a string literal. " +
        "confiqure reads only a string literal (or literals joined with +), so the operation URL would be wrong. Write it inline.",
    ]);
  });

  it("Spring mappings outside tool classes are not confiqure's business", async () => {
    expect(await lint({ "c/C.java": `@RestController @RequestMapping(Api.BASE) public class C { @PostMapping(Paths.X) public void x() {} }` })).toEqual([]);
  });

  it("all-literal sources produce nothing", async () => {
    expect(
      await lint({
        "a/S.java": obj(`  @Confiqure.Consent(id = "a", text = "I agree")\n  private Boolean a;\n  @Confiqure.Gate(requires = "a == true", message = "Agree first")\n  private String b;`),
      })
    ).toEqual([]);
  });
});
