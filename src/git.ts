import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

export interface GitStatus {
  branch: string;
  isDirty: boolean;
  aheadOfUpstream: boolean;
  upstreamConfigured: boolean;
}

export interface DirtyFile {
  /** Two-char porcelain status code, e.g. " M", "??", "MM". */
  status: string;
  /** Relative path from the repo root. */
  path: string;
}

export async function gitHashObject(filePath: string, cwd: string): Promise<string> {
  // hash-object computes the git blob SHA without needing the file to be staged.
  const { stdout } = await exec(`git hash-object "${filePath}"`, { cwd });
  return stdout.trim();
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  let branch = "(detached)";
  try {
    const { stdout } = await exec("git rev-parse --abbrev-ref HEAD", { cwd });
    branch = stdout.trim();
  } catch {
    /* ignore */
  }
  let upstreamConfigured = false;
  let aheadOfUpstream = false;
  try {
    const { stdout } = await exec(
      "git rev-list --left-right --count HEAD...@{upstream}",
      { cwd }
    );
    upstreamConfigured = true;
    const parts = stdout.trim().split(/\s+/);
    aheadOfUpstream = parseInt(parts[0] ?? "0", 10) > 0;
  } catch {
    upstreamConfigured = false;
  }
  let isDirty = false;
  try {
    const { stdout } = await exec("git status --porcelain", { cwd });
    isDirty = stdout.trim().length > 0;
  } catch {
    /* ignore */
  }
  return { branch, isDirty, aheadOfUpstream, upstreamConfigured };
}

export async function gitHeadSha(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git rev-parse HEAD", { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function gitRef(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git symbolic-ref HEAD", { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Return the subset of dirty files (modified, added, untracked) whose path
 * falls under one of the given scan-path prefixes. Used by `confiqure push`
 * to gate uploads on a clean working tree for confiqure-relevant files only.
 *
 * <p>Paths outside `scanPaths` are intentionally ignored — confiqure doesn't
 * care if `README.md` or `infra/` is dirty.
 */
export async function gitDirtyInScanPaths(
  cwd: string,
  scanPaths: string[]
): Promise<DirtyFile[]> {
  let stdout = "";
  try {
    const res = await exec("git status --porcelain", { cwd });
    stdout = res.stdout;
  } catch {
    return [];
  }
  const normalizedScanPaths = scanPaths.map((p) => p.replace(/\\/g, "/").replace(/\/+$/, "") + "/");
  const dirty: DirtyFile[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    // Porcelain v1 format: XY␣PATH (X = index status, Y = worktree status).
    const status = rawLine.slice(0, 2);
    let path = rawLine.slice(3);
    // Renames look like "R  old -> new" — keep the new path.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    const normalized = path.replace(/\\/g, "/");
    if (normalizedScanPaths.some((prefix) => normalized.startsWith(prefix))) {
      dirty.push({ status, path: normalized });
    }
  }
  return dirty;
}
