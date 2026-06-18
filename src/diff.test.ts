import { describe, it, expect } from "vitest";
import { diffAgainstRegistry } from "./diff.js";
import type { DiscoveredClass } from "./scan.js";
import type { RegistryItem } from "./api.js";

// Minimal fixtures — only the fields diffAgainstRegistry reads.
const local = (id: string, sha: string): DiscoveredClass =>
  ({
    classUniqueId: id,
    className: id,
    configEnd: "/" + id,
    filePath: `src/${id}.java`,
    gitSha: sha,
    relatedFiles: [`src/${id}.java`],
  }) as DiscoveredClass;

const reg = (id: string, ver: string): RegistryItem =>
  ({
    classUniqueId: id,
    className: id,
    configEnd: "/" + id,
    filePath: `src/${id}.java`,
    gitVersion: ver,
  }) as RegistryItem;

const deletedIds = (changes: { op: string; classUniqueId: string }[]) =>
  changes.filter((c) => c.op === "DELETED").map((c) => c.classUniqueId);

describe("diffAgainstRegistry — deletions are a full-sync concept", () => {
  it("FULL sync: a registry root absent from local is marked DELETED", () => {
    const d = diffAgainstRegistry([local("A", "s1")], [reg("A", "s1"), reg("B", "s2")]);
    expect(deletedIds(d.changes)).toEqual(["B"]);
  });

  // The data-loss regression guard: a selective (--file) push narrows `local` to the
  // targeted root, and must NEVER delete the non-targeted roots it simply didn't scan.
  it("SELECTIVE ({deletes:false}): never deletes non-targeted roots", () => {
    const d = diffAgainstRegistry([local("A", "s1")], [reg("A", "s1"), reg("B", "s2"), reg("C", "s3")], {
      deletes: false,
    });
    expect(deletedIds(d.changes)).toEqual([]);
    // targeted root is unchanged → no spurious changes at all
    expect(d.changes).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("SELECTIVE: still reports ADDED/CHANGED for the targeted root", () => {
    const changedTarget = diffAgainstRegistry([local("A", "newsha")], [reg("A", "oldsha"), reg("B", "s2")], {
      deletes: false,
    });
    expect(changedTarget.changes.map((c) => c.op)).toEqual(["CHANGED"]);
    expect(changedTarget.changes[0]!.classUniqueId).toBe("A");

    const addedTarget = diffAgainstRegistry([local("NEW", "s9")], [reg("B", "s2")], { deletes: false });
    expect(addedTarget.changes.map((c) => c.op)).toEqual(["ADDED"]);
    expect(addedTarget.changes[0]!.classUniqueId).toBe("NEW");
  });
});
