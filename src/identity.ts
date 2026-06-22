import { createHash } from "node:crypto";

/**
 * Stable content identity for an endpoint over its FULL reachable source set (#40).
 *
 * An endpoint's identity must cover its whole nested type graph, not just the annotated root file.
 * Otherwise a change confined to a nested DTO — e.g. `SupplierSiteAnalysisDto` referenced as
 * `siteAnalysis` on `Supplier` — leaves `Supplier.java` byte-identical, the diff reports the
 * endpoint UNCHANGED, and no new revision / schema version is created. The host then deserializes
 * against the new DTO while confiqure still serves the old schema (silent drift; `convertValue`
 * starts throwing on the changed fields). Hashing the whole reachable set makes ANY nested change
 * flip the identity, so the endpoint re-versions on the next push.
 *
 * A single-file endpoint keeps its plain git blob SHA, so endpoints with no nested types do NOT
 * re-version when this lands — only graphs (the broken case) get a composite SHA and re-version
 * once on upgrade. The composite is order-independent (paths are sorted) and deterministic.
 *
 * Split out as a pure function (no git / fs) so it is unit-testable; the caller in `scan.ts`
 * supplies each reachable file's git blob SHA.
 */
export function endpointIdentity(fileShas: Array<{ path: string; sha: string }>): string {
  // De-dup by path (a graph can surface the same file twice), then sort for stable output.
  const unique = new Map<string, string>();
  for (const { path, sha } of fileShas) unique.set(path, sha);
  const sorted = Array.from(unique, ([path, sha]) => ({ path, sha })).sort((a, b) =>
    a.path.localeCompare(b.path)
  );
  if (sorted.length === 0) return "";
  if (sorted.length === 1) return sorted[0]!.sha; // single file → plain blob SHA (no churn)
  return createHash("sha256")
    .update(sorted.map((f) => `${f.path}:${f.sha}`).join("\n"))
    .digest("hex");
}
