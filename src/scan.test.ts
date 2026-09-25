import { describe, it, expect } from "vitest";
import { factsEndpoint, isTestPath, objectAnnotation, identityFieldOf } from "./scan.js";

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
