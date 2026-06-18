import { DiscoveredClass } from "./scan.js";
import { RegistryItem } from "./api.js";

export type ChangeOp = "ADDED" | "CHANGED" | "RENAMED" | "DELETED";

export interface ChangeEntry {
  op: ChangeOp;
  classUniqueId: string;
  className: string;
  configEnd: string;
  filePath: string;
  previousFilePath?: string;
  previousClassUniqueId?: string;
  gitSha: string;
}

export interface DiffResult {
  changes: ChangeEntry[];
  unchanged: number;
}

/**
 * Compute the change-file by joining the local scan against the backend
 * registry on {@code classUniqueId}.
 *
 * V1 rules:
 *   - Local annotated file not in registry → ADDED.
 *   - Matching classUniqueId, different gitSha → CHANGED.
 *   - Matching classUniqueId, same gitSha → unchanged (skipped).
 *   - Registry entry with no local match → DELETED — but ONLY on a full sync.
 *     A selective push (--file) narrows `local` to the targeted root(s), so
 *     "absent locally" there does NOT mean "removed from source"; callers pass
 *     {deletes:false} to keep selective pushes additive/update-only.
 *   - RENAMED detection deferred (treated as DELETED + ADDED).
 */
export function diffAgainstRegistry(
  local: DiscoveredClass[],
  registry: RegistryItem[],
  opts: { deletes?: boolean } = {}
): DiffResult {
  const byClassId = new Map(registry.map((r) => [r.classUniqueId, r]));
  const changes: ChangeEntry[] = [];
  let unchanged = 0;
  const seen = new Set<string>();

  for (const cls of local) {
    seen.add(cls.classUniqueId);
    const existing = byClassId.get(cls.classUniqueId);
    if (!existing) {
      changes.push({
        op: "ADDED",
        classUniqueId: cls.classUniqueId,
        className: cls.className,
        configEnd: cls.configEnd,
        filePath: cls.filePath,
        gitSha: cls.gitSha,
      });
    } else if (existing.gitVersion !== cls.gitSha) {
      changes.push({
        op: "CHANGED",
        classUniqueId: cls.classUniqueId,
        className: cls.className,
        configEnd: cls.configEnd,
        filePath: cls.filePath,
        gitSha: cls.gitSha,
      });
    } else {
      unchanged++;
    }
  }

  // Deletions are a FULL-SYNC concept (a registry root no longer present in source).
  // Skipped when {deletes:false} — a selective (--file) push must never delete the
  // non-targeted roots it simply didn't scan.
  if (opts.deletes !== false) {
    for (const r of registry) {
      if (!seen.has(r.classUniqueId)) {
        changes.push({
          op: "DELETED",
          classUniqueId: r.classUniqueId,
          className: r.className,
          configEnd: r.configEnd,
          filePath: r.filePath ?? r.classUniqueId,
          gitSha: r.gitVersion,
        });
      }
    }
  }

  return { changes, unchanged };
}

export interface RenderDiffOptions {
  /** All scanned source-file paths — used to compute the "context files" set. */
  allScannedPaths: string[];
  /** Paths of files that were detected as annotated, regardless of diff op. */
  annotatedPaths: string[];
  /** Max context files to list inline before collapsing to "+ N more". */
  contextListLimit?: number;
}

export function renderDiff(diff: DiffResult, opts: RenderDiffOptions): string {
  const lines: string[] = [];
  const limit = opts.contextListLimit ?? 6;

  // --- Annotated classes section ---
  lines.push(
    diff.changes.length === 0
      ? `Annotated classes: no changes (${diff.unchanged} unchanged)`
      : `Annotated classes (${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}, ${diff.unchanged} unchanged):`
  );
  const opOrder: ChangeOp[] = ["ADDED", "CHANGED", "RENAMED", "DELETED"];
  for (const op of opOrder) {
    const rows = diff.changes.filter((c) => c.op === op);
    for (const r of rows) {
      const sha = r.gitSha ? r.gitSha.slice(0, 7) : "       ";
      const tail = op === "DELETED" ? `(was: ${r.filePath})` : `${r.filePath}  ${sha}`;
      lines.push(`  ${op.padEnd(8)} ${r.className.padEnd(28)} ${tail}`);
    }
  }

  // --- Context files section ---
  const annotatedSet = new Set(opts.annotatedPaths.map(normalize));
  const contextFiles = opts.allScannedPaths
    .map(normalize)
    .filter((p) => !annotatedSet.has(p))
    .sort();

  lines.push("");
  if (contextFiles.length === 0) {
    lines.push("Context files: (none)");
  } else {
    lines.push(`Context files: ${contextFiles.length} source file${contextFiles.length === 1 ? "" : "s"} reachable from a root (uploaded for AI parsing)`);
    const shown = contextFiles.slice(0, limit);
    for (const p of shown) lines.push(`  ${p}`);
    if (contextFiles.length > limit) {
      lines.push(`  … +${contextFiles.length - limit} more`);
    }
  }

  return lines.join("\n");
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}
