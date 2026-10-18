import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJavaFiles } from "./classTree.js";
import { lintOperationEffects } from "./lint.js";
import { scanProject } from "./scan.js";
import { buildManifest } from "./commands/push.js";
import { DEFAULT_CONFIG } from "./config.js";

// Annotation 3.2: @Confiqure.Effect(OperationEffect) per operation. Absent → NONE; a declared value is read only in a
// form Java resolves to Confiqure.OperationEffect; anything else stops the push, never a silent NONE.
const tool = (imports: string, method: string) => `import ai.confiqure.Confiqure;
${imports}
@Confiqure.Tool
public class PagesTool {
${method}
  @PostMapping("/plain") public Ack plain(@RequestBody Ref r) { return null; }
}`;
const op = (annotation: string) =>
  `  @Confiqure.Browser\n  ${annotation}\n  public Ack openProductPage(@RequestBody Ref r) { return null; }`;

async function parse(src: string) {
  return parseJavaFiles(new Map([["a/PagesTool.java", src]]));
}
async function effectsOf(src: string) {
  const [pf] = await parse(src);
  return Object.fromEntries(pf.toolClasses[0].operations.map((o) => [o.name, o.effect]));
}

describe("operation effect — parse", () => {
  it("an operation without @Confiqure.Effect is NONE", async () => {
    expect(await effectsOf(tool("", op("")))).toEqual({ openProductPage: "NONE", plain: "NONE" });
  });

  const readable: [string, string, string][] = [
    ["qualified", "", "@Confiqure.Effect(Confiqure.OperationEffect.PAGE_OPENING)"],
    ["fully qualified", "", "@Confiqure.Effect(ai.confiqure.Confiqure.OperationEffect.PAGE_OPENING)"],
    ["value =", "", "@Confiqure.Effect(value = Confiqure.OperationEffect.PAGE_OPENING)"],
    ["imported enum", "import ai.confiqure.Confiqure.OperationEffect;", "@Confiqure.Effect(OperationEffect.PAGE_OPENING)"],
    ["Confiqure.* import", "import ai.confiqure.Confiqure.*;", "@Effect(OperationEffect.PAGE_OPENING)"],
    ["static import", "import static ai.confiqure.Confiqure.OperationEffect.PAGE_OPENING;", "@Confiqure.Effect(PAGE_OPENING)"],
    ["static wildcard", "import static ai.confiqure.Confiqure.OperationEffect.*;", "@Confiqure.Effect(PAGE_OPENING)"],
    ["bare imported annotation", "import ai.confiqure.Confiqure.Effect;", "@Effect(Confiqure.OperationEffect.PAGE_OPENING)"],
  ];
  for (const [label, imports, annotation] of readable) {
    it(`reads PAGE_OPENING written ${label}`, async () => {
      expect(await effectsOf(tool(imports, op(annotation)))).toEqual({ openProductPage: "PAGE_OPENING", plain: "NONE" });
    });
  }

  it("an explicit NONE is NONE, and Browser stays Browser", async () => {
    const [pf] = await parse(tool("", op("@Confiqure.Effect(Confiqure.OperationEffect.NONE)")));
    expect(pf.toolClasses[0].operations[0]).toMatchObject({ name: "openProductPage", browser: true, async: false, effect: "NONE" });
  });
});

describe("lintOperationEffects — an effect the push cannot read stops it", () => {
  const unreadable: [string, string, string, string][] = [
    ["a bare constant without its static import", "", "@Confiqure.Effect(PAGE_OPENING)", "@Confiqure.Effect(PAGE_OPENING)"],
    ["OperationEffect without its import", "", "@Confiqure.Effect(OperationEffect.PAGE_OPENING)", "@Confiqure.Effect(OperationEffect.PAGE_OPENING)"],
    ["another type's constant", "", "@Confiqure.Effect(MyEffects.PAGE_OPENING)", "@Confiqure.Effect(MyEffects.PAGE_OPENING)"],
    ["an unknown constant", "", "@Confiqure.Effect(Confiqure.OperationEffect.NAVIGATION)", "@Confiqure.Effect(Confiqure.OperationEffect.NAVIGATION)"],
    ["no value", "", "@Confiqure.Effect", "@Confiqure.Effect with no value"],
  ];
  for (const [label, imports, annotation, shown] of unreadable) {
    it(label, async () => {
      const parsed = await parse(tool(imports, op(annotation)));
      expect(parsed[0].toolClasses[0].operations[0].effect).toBeNull();
      expect(lintOperationEffects(parsed)).toEqual([
        `a/PagesTool.java:6: PagesTool.openProductPage() — ${shown} is not a value confiqure can read. ` +
          "Write Confiqure.OperationEffect.PAGE_OPENING or Confiqure.OperationEffect.NONE (or import ai.confiqure.Confiqure.OperationEffect).",
      ]);
    });
  }

  it("an effect anywhere but a public tool-class operation", async () => {
    const parsed = await parseJavaFiles(new Map([
      ["a/PagesTool.java", tool("", "  @Confiqure.Effect(Confiqure.OperationEffect.PAGE_OPENING)\n  private Ack hidden(Ref r) { return null; }")],
      ["a/Helper.java", "import ai.confiqure.Confiqure;\npublic class Helper {\n  @Confiqure.Effect(Confiqure.OperationEffect.PAGE_OPENING)\n  public void open() {}\n}"],
    ]));
    expect(lintOperationEffects(parsed)).toEqual([
      "a/PagesTool.java:5: PagesTool.hidden() — @Confiqure.Effect is read only on a public operation of a @Confiqure.Tool class; here confiqure would never see it.",
      "a/Helper.java:3: Helper.open() — @Confiqure.Effect is read only on a public operation of a @Confiqure.Tool class; here confiqure would never see it.",
    ]);
  });

  it("is silent on readable effects", async () => {
    expect(lintOperationEffects(await parse(tool("", op("@Confiqure.Effect(Confiqure.OperationEffect.PAGE_OPENING)"))))).toEqual([]);
  });
});

describe("scan and manifest — the effect rides on every operation", () => {
  it("an unreadable effect is a scan error; a readable one is in the manifest beside NONE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cq-effect-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/PagesTool.java"), tool("", op("@Confiqure.Effect(PAGE_OPENING)")));
    const bad = await scanProject(dir, { ...DEFAULT_CONFIG, scanPaths: ["src"] });
    await writeFile(join(dir, "src/PagesTool.java"), tool("", op("@Confiqure.Effect(Confiqure.OperationEffect.PAGE_OPENING)")));
    const good = await scanProject(dir, { ...DEFAULT_CONFIG, scanPaths: ["src"] });
    await rm(dir, { recursive: true, force: true });
    expect(bad.errors, bad.errors.join("\n")).toHaveLength(1);
    expect(bad.errors[0]).toContain("PagesTool.openProductPage() — @Confiqure.Effect(PAGE_OPENING) is not a value confiqure can read");
    expect(good.errors).toEqual([]);
    const ops = buildManifest(good).toolClasses![0].operations;
    expect(ops.map((o) => [o.name, o.browser, o.effect])).toEqual([
      ["openProductPage", true, "PAGE_OPENING"],
      ["plain", false, "NONE"],
    ]);
  });
});
