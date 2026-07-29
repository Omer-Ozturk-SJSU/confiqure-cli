import { describe, it, expect } from "vitest";
import { confiqureArgs, isFactsClass, factsEndpoint, isTestPath } from "./scan.js";

describe("isFactsClass (#316 — the user-facts contract must be recognized, and nothing else)", () => {
  it("recognizes the fully-qualified Java form", () => {
    const src = `@Confiqure(type = Confiqure.Type.FACTS, callback = "/api/confiqure/user-facts")
public class SellerFacts { private String x; }`;
    expect(isFactsClass(src)).toBe(true);
  });

  it("recognizes Type.FACTS and a static-imported bare FACTS", () => {
    expect(isFactsClass(`@Confiqure(type = Type.FACTS, callback = "/f") class A {}`)).toBe(true);
    expect(isFactsClass(`@Confiqure(type = FACTS, callback = "/f") class A {}`)).toBe(true);
  });

  it("recognizes the quoted form the non-Java annotation sources use", () => {
    expect(isFactsClass(`@Confiqure(type: "facts", callback: "/f")\nclass A {}`)).toBe(true);
  });

  it("is FALSE for ordinary SINGLE/MULTI endpoints and the bare marker", () => {
    expect(isFactsClass(`@Confiqure(end = "/suppliers", type = Confiqure.Type.MULTI) class A {}`)).toBe(false);
    expect(isFactsClass(`@Confiqure(end = "/x") class A {}`)).toBe(false);
    expect(isFactsClass(`@Confiqure\npublic class A {}`)).toBe(false);
    expect(isFactsClass(`public class A {}`)).toBe(false);
  });

  it("does NOT mistake a field assignment in the class body for a declaration", () => {
    const src = `@Confiqure(end = "/suppliers")
public class Supplier {
  private String type;
  void set() { this.type = FACTS_CONSTANT; }
}`;
    expect(isFactsClass(src)).toBe(false);
  });

  it("does NOT match member annotations (@Confiqure.Tool / @Confiqure.Gate)", () => {
    const src = `public class Ctl {
  @Confiqure.Tool(name = "x")
  public String go() { return null; }
}`;
    expect(confiqureArgs(src)).toBeNull();
    expect(isFactsClass(src)).toBe(false);
  });

  it("keeps balanced parens so an array argument doesn't truncate the args", () => {
    const src = `@Confiqure(tools = {"A", "B"}, type = Confiqure.Type.FACTS, callback = "/f") class A {}`;
    expect(isFactsClass(src)).toBe(true);
  });
});

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
