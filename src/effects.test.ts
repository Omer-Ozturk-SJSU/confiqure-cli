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

describe("operation effect — one declaration, one argument, confiqure's own types (CPMA 13644, Jarvis #115153)", () => {
  const OP = "public Ack openProductPage(@RequestBody Ref r) { return null; }";
  const src = (imports: string, annotations: string) =>
    `${imports}\n@ai.confiqure.Confiqure.Tool\npublic class PagesTool {\n${annotations}\n  ${OP}\n}`;
  const effect = async (code: string) => (await parse(code))[0].toolClasses[0].operations[0];

  const badShapes: [string, string][] = [
    ["an unknown key", "@Confiqure.Effect(kind = Confiqure.OperationEffect.PAGE_OPENING)"],
    ["value plus an unknown key", "@Confiqure.Effect(value = Confiqure.OperationEffect.PAGE_OPENING, reason = \"x\")"],
    ["value twice", "@Confiqure.Effect(value = Confiqure.OperationEffect.NONE, value = Confiqure.OperationEffect.PAGE_OPENING)"],
    ["positional plus value", "@Confiqure.Effect(Confiqure.OperationEffect.PAGE_OPENING, value = Confiqure.OperationEffect.NONE)"],
    ["an array", "@Confiqure.Effect({Confiqure.OperationEffect.PAGE_OPENING})"],
  ];
  for (const [label, annotation] of badShapes) {
    it(`${label} is unreadable, never the last value written`, async () => {
      const parsed = await parse(src("import ai.confiqure.Confiqure;", `  ${annotation}`));
      expect(parsed[0].toolClasses[0].operations[0].effect).toBeNull();
      expect(lintOperationEffects(parsed)).toHaveLength(1);
      expect(lintOperationEffects(parsed)[0]).toContain("is not a value confiqure can read");
    });
  }

  it("two @Confiqure.Effect on one method is an error, never a precedence", async () => {
    const parsed = await parse(src("import ai.confiqure.Confiqure;",
      "  @Confiqure.Effect(Confiqure.OperationEffect.NONE)\n  @ai.confiqure.Confiqure.Effect(ai.confiqure.Confiqure.OperationEffect.PAGE_OPENING)"));
    expect(parsed[0].toolClasses[0].operations[0].effect).toBeNull();
    expect(lintOperationEffects(parsed)).toEqual([
      "a/PagesTool.java:5: PagesTool.openProductPage() — @Confiqure.Effect appears 2 times. Declare it once, with one value.",
    ]);
  });

  it("a lookalike Effect never yields PAGE_OPENING: another package's Confiqure, a shadowing import, no import at all", async () => {
    const PAGE = "Confiqure.OperationEffect.PAGE_OPENING";
    for (const code of [
      src("import ai.confiqure.Confiqure;", `  @other.Confiqure.Effect(${PAGE})`),
      src("import com.other.Confiqure;", `  @Confiqure.Effect(${PAGE})`),
      src("", `  @Confiqure.Effect(${PAGE})`),
      src("import ai.confiqure.Confiqure;\nimport ai.confiqure.Confiqure.*;\nimport com.other.Effect;", `  @Effect(${PAGE})`),
    ]) {
      const parsed = await parse(code);
      expect(parsed[0].toolClasses[0].operations[0].effect, code).toBe("NONE");
      expect(lintOperationEffects(parsed), code).toEqual([]);
    }
  });

  it("an imported OperationEffect or constant shadowed by another type's import is unreadable", async () => {
    for (const [imports, value] of [
      ["import ai.confiqure.Confiqure;\nimport ai.confiqure.Confiqure.*;\nimport com.other.OperationEffect;", "OperationEffect.PAGE_OPENING"],
      ["import ai.confiqure.Confiqure;\nimport static ai.confiqure.Confiqure.OperationEffect.*;\nimport static com.other.Pages.PAGE_OPENING;", "PAGE_OPENING"],
      ["import com.other.Confiqure;\nimport ai.confiqure.Confiqure.Effect;", "Confiqure.OperationEffect.PAGE_OPENING"],
    ]) {
      expect((await effect(src(imports, `  @ai.confiqure.Confiqure.Effect(${value})`))).effect, imports).toBeNull();
    }
  });

  it("the official forms still read: fully qualified, the imported annotation, the on-demand import", async () => {
    for (const [imports, annotation] of [
      ["", "@ai.confiqure.Confiqure.Effect(ai.confiqure.Confiqure.OperationEffect.PAGE_OPENING)"],
      ["import ai.confiqure.Confiqure;\nimport ai.confiqure.Confiqure.Effect;", "@Effect(Confiqure.OperationEffect.PAGE_OPENING)"],
      ["import ai.confiqure.*;", "@Confiqure.Effect(Confiqure.OperationEffect.PAGE_OPENING)"],
    ]) {
      expect((await effect(src(imports, `  ${annotation}`))).effect, imports).toBe("PAGE_OPENING");
    }
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
