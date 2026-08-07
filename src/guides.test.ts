import { describe, it, expect } from "vitest";
import { planGuideSync, normalizeGuidePath, guideSha, LocalGuide } from "./guides.js";
import { GuideRegistryItem } from "./api.js";

/**
 * #316 P2 — the guides delta. Getting this wrong is expensive in both
 * directions: over-uploading re-parses a whole docs tree on every push, and
 * over-retiring silently deletes the workspace's documentation.
 */

function local(path: string, sha: string): LocalGuide {
  return { path, sha, sizeBytes: 10, bytes: Buffer.from(sha) };
}

function remote(
  sourcePath: string,
  contentSha: string,
  status: GuideRegistryItem["status"] = "READY"
): GuideRegistryItem {
  return {
    docId: "d_" + sourcePath,
    sourcePath,
    filename: sourcePath.split("/").pop()!,
    contentSha,
    sizeBytes: 10,
    status,
    searchable: true,
    error: null,
    createdAt: "2026-08-01T00:00:00",
  };
}

describe("planGuideSync", () => {
  it("uploads new and changed files, leaves matching hashes alone", () => {
    const plan = planGuideSync(
      [
        local("docs/user-guides/setup.md", "sha-same"),
        local("docs/user-guides/restock.md", "sha-new"),
        local("docs/user-guides/brand-new.md", "sha-x"),
      ],
      [
        remote("docs/user-guides/setup.md", "sha-same"),
        remote("docs/user-guides/restock.md", "sha-old"),
      ]
    );

    expect(plan.unchanged.map((g) => g.path)).toEqual(["docs/user-guides/setup.md"]);
    expect(plan.upload.map((g) => g.path).sort()).toEqual([
      "docs/user-guides/brand-new.md",
      "docs/user-guides/restock.md",
    ]);
    expect(plan.retire).toEqual([]);
  });

  it("retires registry entries with no local file", () => {
    const plan = planGuideSync(
      [local("docs/user-guides/kept.md", "sha-1")],
      [remote("docs/user-guides/kept.md", "sha-1"), remote("docs/user-guides/deleted.md", "sha-2")]
    );

    expect(plan.retire).toEqual(["docs/user-guides/deleted.md"]);
    expect(plan.upload).toEqual([]);
  });

  it("ships the FULL local path list, not just the upload delta", () => {
    // `paths` is what the backend retires against. If it carried only the
    // changed files, editing one page would delete every other guide.
    const plan = planGuideSync(
      [
        local("docs/user-guides/a.md", "sha-a"),
        local("docs/user-guides/b.md", "sha-b-changed"),
      ],
      [remote("docs/user-guides/a.md", "sha-a"), remote("docs/user-guides/b.md", "sha-b")]
    );

    expect(plan.upload.map((g) => g.path)).toEqual(["docs/user-guides/b.md"]);
    expect(plan.paths).toEqual(["docs/user-guides/a.md", "docs/user-guides/b.md"]);
  });

  it("re-uploads a FAILED guide even when the hash is unchanged", () => {
    // The backend has no usable copy of that page — calling it "unchanged"
    // would leave it permanently broken.
    const plan = planGuideSync(
      [local("docs/user-guides/broken.md", "sha-1")],
      [remote("docs/user-guides/broken.md", "sha-1", "FAILED")]
    );

    expect(plan.upload.map((g) => g.path)).toEqual(["docs/user-guides/broken.md"]);
    expect(plan.unchanged).toEqual([]);
  });

  it("matches a registry path recorded with Windows separators", () => {
    const plan = planGuideSync(
      [local("docs/user-guides/setup.md", "sha-1")],
      [remote("docs\\user-guides\\setup.md", "sha-1")]
    );

    expect(plan.unchanged.map((g) => g.path)).toEqual(["docs/user-guides/setup.md"]);
    expect(plan.retire).toEqual([]);
  });

  it("carries locally-skipped files through to the caller", () => {
    const plan = planGuideSync([], [], [{ path: "docs/user-guides/huge.pdf", reason: "over the limit" }]);
    expect(plan.skipped).toEqual([{ path: "docs/user-guides/huge.pdf", reason: "over the limit" }]);
  });
});

describe("normalizeGuidePath", () => {
  it("normalizes separators, leading ./ and leading /", () => {
    expect(normalizeGuidePath("docs\\user-guides\\a.md")).toBe("docs/user-guides/a.md");
    expect(normalizeGuidePath("./docs/user-guides/a.md")).toBe("docs/user-guides/a.md");
    expect(normalizeGuidePath("/docs/user-guides/a.md")).toBe("docs/user-guides/a.md");
  });
});

describe("guideSha", () => {
  it("is content-addressed and stable", () => {
    expect(guideSha(Buffer.from("hello"))).toBe(guideSha(Buffer.from("hello")));
    expect(guideSha(Buffer.from("hello"))).not.toBe(guideSha(Buffer.from("hello ")));
  });
});
