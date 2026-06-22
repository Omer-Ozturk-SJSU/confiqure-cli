import { describe, it, expect } from "vitest";
import { endpointIdentity } from "./identity.js";

describe("endpointIdentity (#40 — endpoint identity covers the full nested type graph)", () => {
  it("returns the plain blob SHA for a single-file endpoint (no churn for nested-less endpoints)", () => {
    const sha = "a".repeat(40);
    expect(endpointIdentity([{ path: "Supplier.java", sha }])).toBe(sha);
  });

  it("returns empty string for no files", () => {
    expect(endpointIdentity([])).toBe("");
  });

  it("CHANGES when a nested DTO's SHA changes even though the root is identical (the bug)", () => {
    const root = { path: "Supplier.java", sha: "r".repeat(40) };
    const before = endpointIdentity([root, { path: "SupplierSiteAnalysisDto.java", sha: "1".repeat(40) }]);
    const after = endpointIdentity([root, { path: "SupplierSiteAnalysisDto.java", sha: "2".repeat(40) }]);
    expect(after).not.toBe(before);
  });

  it("differs from the bare root SHA once a nested type is present (so it re-versions once on upgrade)", () => {
    const root = { path: "Supplier.java", sha: "r".repeat(40) };
    const composite = endpointIdentity([root, { path: "Dto.java", sha: "d".repeat(40) }]);
    expect(composite).not.toBe(root.sha);
  });

  it("is order-independent (paths sorted) and deterministic", () => {
    const a = { path: "A.java", sha: "1".repeat(40) };
    const b = { path: "B.java", sha: "2".repeat(40) };
    expect(endpointIdentity([a, b])).toBe(endpointIdentity([b, a]));
  });

  it("de-dups a file that surfaces twice in the graph", () => {
    const root = { path: "Supplier.java", sha: "r".repeat(40) };
    const dto = { path: "Dto.java", sha: "d".repeat(40) };
    expect(endpointIdentity([root, dto, dto])).toBe(endpointIdentity([root, dto]));
  });
});
