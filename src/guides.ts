import fastGlob from "fast-glob";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ProjectConfig } from "./config.js";
import { GuideRegistryItem } from "./api.js";

/**
 * User-guides sync (#316 P2). The dev marks folders in `confiqure.config.json`
 * (`"guides": ["docs/user-guides"]`); `confiqure push` hashes what is in the
 * tree, ships only what changed, and tells the backend the FULL local path list
 * so a page deleted in git is retired server-side.
 *
 * Git IS the version control — this mirrors it. There is no guide-authoring UI,
 * no revisions of our own: a guide's identity is its repo-relative path and its
 * version is its content hash.
 */

/** File types a guides folder syncs. Anything else in the folder is ignored, not an error. */
export const GUIDE_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
] as const;

/** Refused locally with a named reason rather than shipped and rejected server-side. */
export const MAX_GUIDE_BYTES = 10 * 1024 * 1024;

export interface LocalGuide {
  /** Repo-relative, forward slashes — the sync identity, matched against the registry. */
  path: string;
  /** SHA-256 of the file's bytes. */
  sha: string;
  sizeBytes: number;
  bytes: Buffer;
}

export interface GuideSyncPlan {
  /** New or changed — these are uploaded. */
  upload: LocalGuide[];
  /** Same path, same hash — already on the backend, not re-sent. */
  unchanged: LocalGuide[];
  /** Registry paths with no local file — the backend retires these. */
  retire: string[];
  /** Every local guide path; drives retirement server-side. */
  paths: string[];
  /** Locally skipped files, with the reason (oversize). */
  skipped: Array<{ path: string; reason: string }>;
}

/** Repo-relative, forward slashes, no leading "./" — must match the backend's normalizer. */
export function normalizeGuidePath(path: string): string {
  let p = path.replace(/\\/g, "/").trim();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

export function guideSha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Read every guide file under the configured folders.
 *
 * Hashing is SHA-256 of the bytes rather than `git hash-object`: a guides folder
 * is a whole directory tree (a hundred screenshots is normal), and one git
 * subprocess per file is slow enough on Windows to be felt on every push. The
 * hash only has to answer "did this file change", which a content hash does
 * exactly — and it works for a guide that isn't committed yet.
 */
export async function scanGuides(
  cwd: string,
  config: ProjectConfig
): Promise<{ guides: LocalGuide[]; skipped: Array<{ path: string; reason: string }> }> {
  const folders = config.guides ?? [];
  if (folders.length === 0) return { guides: [], skipped: [] };

  const patterns = folders.flatMap((folder) => {
    const base = folder.replace(/\\/g, "/").replace(/\/+$/, "");
    return GUIDE_EXTENSIONS.map((ext) => `${base}/**/*${ext}`);
  });
  const matched = await fastGlob(patterns, {
    cwd,
    ignore: config.ignore.map((d) => `**/${d}/**`),
    absolute: false,
    onlyFiles: true,
    dot: false,
    caseSensitiveMatch: false,
  });

  const guides: LocalGuide[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const rel of matched.sort()) {
    const path = normalizeGuidePath(rel);
    const bytes = await readFile(`${cwd}/${rel}`);
    if (bytes.length === 0) {
      skipped.push({ path, reason: "empty file" });
      continue;
    }
    if (bytes.length > MAX_GUIDE_BYTES) {
      skipped.push({
        path,
        reason: `${(bytes.length / 1024 / 1024).toFixed(1)} MB — over the 10 MB guide limit`,
      });
      continue;
    }
    guides.push({ path, sha: guideSha(bytes), sizeBytes: bytes.length, bytes });
  }
  return { guides, skipped };
}

/**
 * Join the local scan against the backend's guide registry. Pure — this is the
 * decision the push acts on, and the one worth testing on its own.
 *
 * A registry entry whose ingest FAILED is re-uploaded even when the hash matches:
 * the backend has no usable copy of that page, so "unchanged" would leave it
 * permanently broken.
 */
export function planGuideSync(
  local: LocalGuide[],
  registry: GuideRegistryItem[],
  skipped: Array<{ path: string; reason: string }> = []
): GuideSyncPlan {
  const remote = new Map<string, GuideRegistryItem>();
  for (const item of registry) {
    if (item.sourcePath) remote.set(normalizeGuidePath(item.sourcePath), item);
  }

  const upload: LocalGuide[] = [];
  const unchanged: LocalGuide[] = [];
  const localPaths = new Set<string>();
  for (const guide of local) {
    localPaths.add(guide.path);
    const known = remote.get(guide.path);
    if (known && known.contentSha === guide.sha && known.status !== "FAILED") {
      unchanged.push(guide);
    } else {
      upload.push(guide);
    }
  }

  const retire: string[] = [];
  for (const path of remote.keys()) {
    if (!localPaths.has(path)) retire.push(path);
  }
  retire.sort();

  return { upload, unchanged, retire, paths: Array.from(localPaths).sort(), skipped };
}
