import { Command } from "commander";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { requireCredentials } from "../credentials.js";
import { loadConfig } from "../config.js";
import { scanProject, ScanResult, DiscoveredClass, ToolFile } from "../scan.js";
import { ChangeEntry, DiffResult, diffAgainstRegistry, renderDiff } from "../diff.js";
import {
  getRegistry,
  postUpload,
  getPushStatus,
  promote,
  sandboxWorkspaceKey,
  Manifest,
  ManifestFileEntry,
  UploadStatusItem,
  ApiError,
} from "../api.js";
import {
  gitDirtyInScanPaths,
  gitHashObject,
  gitHeadSha,
  gitRef,
  DirtyFile,
} from "../git.js";

interface PushOpts {
  yes?: boolean;
  allowDirty?: boolean;
  watch?: boolean;
  force?: boolean;
  production?: boolean;
  live?: boolean;
  file?: string;
}

const WATCH_TIMEOUT_MS = 30_000;
const WATCH_INTERVAL_MS = 1000;

export function registerPush(program: Command): void {
  program
    .command("push")
    .description("Push @Confiqure-annotated classes (defaults to sandbox; --production promotes)")
    .option("-y, --yes", "skip the confirmation prompt")
    .option(
      "--allow-dirty",
      "upload working-tree (uncommitted) content; backend gitVersion will not match any committed SHA"
    )
    .option("--no-watch", "don't poll for playbook generation completion after upload")
    .option(
      "-f, --force",
      "re-upload every annotated class regardless of gitSha — use after editing an agent's prompt to regenerate playbooks without faking a source change"
    )
    .option(
      "--production",
      "Promote the active sandbox runbooks to production (no Composer re-run — copies what you tested in sandbox). Requires explicit confirm; use --yes to skip."
    )
    .option(
      "--live",
      "Deploy to sandbox, then automatically promote to production once the sandbox generation succeeds — test + ship in one command. (Production receives the runbook validated in sandbox via promote, never a fresh Composer run. On any sandbox failure, nothing is promoted.)"
    )
    .option(
      "--file <path>",
      "Selective push: ship only the annotated class at <path> plus its nested reachable types, instead of every @Confiqure root in scanPaths. <path> may be the full relative path or a suffix like Supplier.java. Sandbox push only."
    )
    .action(async (opts: PushOpts) => {
      const cwd = process.cwd();
      const creds = await requireCredentials();
      const config = await loadConfig(cwd);

      // ── 1. Scan + diff ───────────────────────────────────────────────────
      const scan = await scanProject(cwd, config);

      // ── Promote-only path (--production): skip the upload flow entirely and
      // copy the *tested* sandbox runbook to prod verbatim. --live ALSO ends in
      // a promote, but only after a fresh sandbox deploy below — so it doesn't
      // short-circuit here.
      if (opts.production) {
        await runPromote(creds, scan, opts);
        return;
      }

      // --file: narrow the (sandbox) push to a single annotated root + its
      // nested tree, so a dev can ship one class instead of every endpoint.
      if (opts.file) {
        scopeToFile(scan, opts.file);
      }

      // Sandbox is the default target for confiqure push. The prod credentials
      // workspaceKey is the registered key; the backend authorizes it for the
      // paired sandbox via ApiKeyAuthHelper.authorizedFor.
      const targetWorkspaceKey = sandboxWorkspaceKey(creds.workspaceKey);
      const toolCount = scan.toolFiles.length;
      console.log(chalk.dim(`Scanned ${scan.allFiles.size} files; ${scan.annotated.length} @Confiqure root${scan.annotated.length === 1 ? "" : "s"}, ${toolCount} @Confiqure.Tool controller${toolCount === 1 ? "" : "s"}.`));

      // Show the class tree per root so the user can see exactly which files
      // we'll ship and why — covers the case the keyword scan used to miss
      // (nested types referenced from a root but never annotated themselves).
      console.log();
      console.log(renderTrees(scan));

      const frontendTools = scan.tools.filter((t) => !t.serverSide);
      if (frontendTools.length > 0) {
        console.log();
        console.log(
          chalk.yellow("⚠"),
          chalk.bold(`${frontendTools.length} frontend tool${frontendTools.length === 1 ? "" : "s"} declared (${frontendTools.map((t) => t.name).join(", ")}).`)
        );
        console.log(chalk.dim("  These need browser handlers: register via confiqure.init({ tools }) or run `confiqure scaffold`."));
      }

      let diff: DiffResult;
      if (opts.force) {
        // Bypass the registry diff — treat every annotated root as CHANGED so
        // the backend creates a fresh push_history row + re-fires Composer.
        // Useful right after editing an agent's prompt: regenerates playbooks
        // without faking a source-file edit just to flip the gitSha.
        diff = forceAllChanged(scan.annotated);
        console.log();
        console.log(
          chalk.yellow("⚠"),
          chalk.bold(`Force mode: re-uploading ${diff.changes.length} annotated class${diff.changes.length === 1 ? "" : "es"} regardless of registry diff.`)
        );
      } else {
        const registry = await getRegistry(creds, targetWorkspaceKey);
        diff = diffAgainstRegistry(scan.annotated, registry);
      }

      console.log();
      console.log(
        renderDiff(diff, {
          allScannedPaths: Array.from(scan.reachableFiles),
          annotatedPaths: scan.annotated.map((c) => c.filePath),
        })
      );

      if (diff.changes.length === 0) {
        return;
      }

      // ── 2. Git state check ───────────────────────────────────────────────
      const dirty = await gitDirtyInScanPaths(cwd, config.scanPaths);
      if (dirty.length > 0) {
        if (!opts.allowDirty) {
          console.log();
          console.log(chalk.red("✗"), chalk.bold(`Push blocked. ${dirty.length} file${dirty.length === 1 ? "" : "s"} in scanPaths ${dirty.length === 1 ? "has" : "have"} uncommitted changes:`));
          console.log();
          for (const f of dirty) {
            console.log(`    ${chalk.yellow(f.status)}  ${f.path}`);
          }
          console.log();
          console.log("Commit them (recommended), or re-run with " + chalk.cyan("--allow-dirty") + " to upload working-tree content.");
          process.exitCode = 1;
          return;
        }
        // --allow-dirty: warn loudly and proceed.
        printDirtyWarning(dirty);
      }

      // ── 3. Confirm + upload ──────────────────────────────────────────────
      if (!opts.yes) {
        const ok = await confirm({
          message: opts.live
            ? `Deploy ${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"} to sandbox, then promote to PRODUCTION on success?`
            : `Upload ${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}?`,
          default: true,
        });
        if (!ok) {
          console.log(chalk.yellow("Aborted."));
          return;
        }
      }

      const headSha = await gitHeadSha(cwd);
      const ref = await gitRef(cwd);

      // Ship only the files reachable from the endpoints that actually CHANGED
      // in this push — not every root in scanPaths. Unchanged sibling endpoints
      // already live on the backend; re-bundling them made the backend re-record
      // them as NESTED rows (and bloated every upload). diff.changes is derived
      // from scan.annotated, and --force/--file narrow scan.annotated first, so
      // this stays correct for those paths too.
      const changedClassIds = new Set(
        diff.changes.filter((c) => c.op !== "DELETED").map((c) => c.classUniqueId)
      );
      const uploadSet = new Set<string>();
      for (const root of scan.annotated) {
        if (changedClassIds.has(root.classUniqueId)) {
          for (const f of root.relatedFiles) uploadSet.add(f);
        }
      }
      // Always ship @Confiqure.DefaultCallbackHook files (like tool controllers,
      // they're workspace-level context) so the backend/Composer can discover the
      // callback hook path wherever it lives — not only inside a scanned root/tool.
      for (const hf of scan.hookFiles) uploadSet.add(hf.filePath);
      const uploadPaths = Array.from(uploadSet).sort();
      const files: ManifestFileEntry[] = [];
      for (const path of uploadPaths) {
        const sha = await gitHashObject(path, cwd).catch(() => "");
        files.push({ path, sha });
      }
      const shaCount = files.filter((f) => f.sha !== "").length;
      console.log(chalk.dim(`Git SHAs computed for ${shaCount}/${files.length} files.`));

      const toolFileEntries: ManifestFileEntry[] = scan.toolFiles.map((tf) => ({
        path: tf.filePath,
        sha: tf.gitSha,
      }));

      const manifest: Manifest = {
        workspaceKey: targetWorkspaceKey,
        gitRef: ref,
        headSha,
        language: scan.primaryLanguage,
        changes: diff.changes,
        files,
        toolFiles: toolFileEntries.length > 0 ? toolFileEntries : undefined,
      };

      // Ship only the files actually referenced by an annotated root + tool controllers.
      const uploadFiles = new Map<string, string>();
      for (const p of uploadPaths) {
        const content = scan.allFiles.get(p);
        if (content != null) uploadFiles.set(p, content);
      }
      for (const tf of scan.toolFiles) {
        if (!uploadFiles.has(tf.filePath)) {
          const content = scan.allFiles.get(tf.filePath);
          if (content != null) uploadFiles.set(tf.filePath, content);
        }
      }
      const result = await postUpload(creds, manifest, uploadFiles, targetWorkspaceKey, opts.force === true);
      console.log();
      console.log(
        chalk.bold(`Pushed to sandbox (${targetWorkspaceKey}): ${result.accepted}/${result.totalClasses} accepted, ${result.rejected} rejected.`)
      );
      for (const item of result.items) {
        const icon = item.status === "ACCEPTED"
          ? chalk.green("✓")
          : item.status === "DELETED"
            ? chalk.gray("−")
            : chalk.red("✗");
        const tail = item.error ? chalk.red(` — ${item.error}`) : "";
        console.log(`  ${icon} ${item.className.padEnd(28)} ${item.status}${tail}`);
      }

      // ── 4. Optional watch loop ───────────────────────────────────────────
      const acceptedForWatch = result.items.filter(
        (i) => i.status === "ACCEPTED" && i.pushHistoryId != null
      );
      if (acceptedForWatch.length === 0) {
        if (result.rejected > 0) process.exitCode = 1;
        return;
      }
      if (opts.watch === false) {
        console.log();
        console.log(chalk.dim("Playbook generation continues in the background — view status in the dashboard."));
        if (opts.live) {
          console.log(
            chalk.yellow("⚠"),
            "--live needs to watch generation to confirm success — auto-promote skipped. Promote once green with " +
              chalk.cyan("confiqure push --production") + "."
          );
        }
        return;
      }

      console.log();
      console.log(chalk.dim("Waiting for playbook generation…"));
      const failures = await watchGeneration(creds, acceptedForWatch, targetWorkspaceKey);
      if (failures > 0 || result.rejected > 0) {
        process.exitCode = 1;
        if (opts.live) {
          console.log();
          console.log(
            chalk.yellow("⚠"),
            chalk.bold("Sandbox deploy had failures — NOT promoting to production.")
          );
          console.log(chalk.dim("  Fix and re-run, or promote manually once green with `confiqure push --production`."));
        }
        return;
      }

      // ── 5. --live: sandbox is green → auto-promote the deployed endpoints ──
      // Promote ships the runbook just validated in sandbox to prod verbatim
      // (no Composer re-run). Only the endpoints in THIS push are promoted.
      if (opts.live) {
        const configEnds = [
          ...new Set(
            diff.changes
              .filter((c) => c.op !== "DELETED")
              .map((c) => c.configEnd)
              .filter((ce): ce is string => typeof ce === "string" && ce.length > 0)
          ),
        ];
        console.log();
        console.log(
          chalk.dim(
            `Sandbox deploy succeeded — promoting ${configEnds.length} endpoint${configEnds.length === 1 ? "" : "s"} to production…`
          )
        );
        try {
          const resp = await promote(creds, configEnds);
          console.log(
            chalk.bold(
              `Promoted ${resp.endpointsPromoted}/${configEnds.length} endpoint${resp.endpointsPromoted === 1 ? "" : "s"} + ${resp.toolsMirrored} tool${resp.toolsMirrored === 1 ? "" : "s"} → production.`
            )
          );
          for (const ce of resp.promotedConfigEnds) {
            console.log(`  ${chalk.green("✓")} ${ce}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(chalk.red("✗"), chalk.bold(`Promote failed: ${msg}`));
          process.exitCode = 1;
        }
        return;
      }

      console.log();
      console.log(
        chalk.dim(`Test in sandbox via the dashboard, then promote with: `) +
          chalk.cyan(`confiqure push --production`)
      );
    });
}

/**
 * Promote-only path: skip the entire diff/upload flow, build the configEnd list
 * from the local scan, confirm with the user, and call the backend's promote
 * endpoint. The CLI does NOT re-push source — promote copies the runbook
 * already living in the sandbox PushHistory to prod verbatim.
 */
async function runPromote(
  creds: Awaited<ReturnType<typeof requireCredentials>>,
  scan: ScanResult,
  opts: PushOpts
): Promise<void> {
  const targets = scan.annotated
    .map((c) => c.configEnd)
    .filter((ce): ce is string => typeof ce === "string" && ce.length > 0);
  if (targets.length === 0) {
    console.log(chalk.yellow("No @Confiqure endpoints found locally — nothing to promote."));
    return;
  }

  console.log();
  console.log(
    chalk.yellow("⚠"),
    chalk.bold(
      `About to promote ${targets.length} endpoint${targets.length === 1 ? "" : "s"} from sandbox → production (${creds.workspaceKey}):`
    )
  );
  for (const e of targets) {
    console.log(`    ${e}`);
  }
  console.log();

  if (!opts.yes) {
    const ok = await confirm({
      message: "Promote these to production?",
      default: false,
    });
    if (!ok) {
      console.log(chalk.yellow("Aborted."));
      return;
    }
  }

  try {
    const resp = await promote(creds, targets);
    console.log();
    console.log(
      chalk.bold(
        `Promoted ${resp.endpointsPromoted}/${targets.length} endpoint${resp.endpointsPromoted === 1 ? "" : "s"} + ${resp.toolsMirrored} tool${resp.toolsMirrored === 1 ? "" : "s"} → production.`
      )
    );
    for (const ce of resp.promotedConfigEnds) {
      console.log(`  ${chalk.green("✓")} ${ce}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log();
    console.log(chalk.red("✗"), chalk.bold(`Promote failed: ${msg}`));
    process.exitCode = 1;
  }
}

/**
 * Narrow a full scan to a single annotated root (plus its nested reachable
 * tree), for `--file <path>`. The scan still walks the whole project — it has
 * to, to resolve the root's nested types — but everything downstream (diff,
 * manifest, upload) sees only the selected root, so the dev ships one class
 * instead of every endpoint in scanPaths.
 *
 * Matching is lenient: <path> may be the exact relative path the scanner
 * recorded, a path suffix (`restocker/Supplier.java`), a bare filename
 * (`Supplier.java`), or an absolute path. If <path> isn't itself a root but is
 * a nested file some root reaches, we push the owning root(s) so the nested
 * edit propagates. Tool controllers are dropped — a selective push is
 * endpoint-focused.
 */
function scopeToFile(scan: ScanResult, fileArg: string): void {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const target = norm(fileArg);
  const matches = (filePath: string): boolean => {
    const fp = norm(filePath);
    return fp === target || fp.endsWith("/" + target) || target.endsWith("/" + fp);
  };

  // Prefer a direct root match; fall back to roots that *reach* the file.
  let roots = scan.annotated.filter((c) => matches(c.filePath));
  if (roots.length === 0) {
    roots = scan.annotated.filter((c) => c.relatedFiles.some((f) => matches(f)));
  }
  if (roots.length === 0) {
    console.error(
      chalk.red("✗"),
      `--file: no @Confiqure root matches "${fileArg}" (and no root references it).`
    );
    console.error(chalk.dim("    Run `confiqure push` without --file to list the roots in scanPaths."));
    process.exit(1);
  }

  const reachable = new Set<string>();
  for (const r of roots) for (const f of r.relatedFiles) reachable.add(f);

  scan.annotated = roots;
  scan.reachableFiles = reachable;
  scan.toolFiles = [];
  scan.hookFiles = [];
  scan.tools = [];

  console.log(
    `${chalk.cyan("⏵")} ${chalk.bold("--file")}: scoped to ${roots.length} root${roots.length === 1 ? "" : "s"}` +
      ` (${roots.map((r) => r.className).join(", ")}), ${reachable.size} file${reachable.size === 1 ? "" : "s"}.`
  );
}

/**
 * Build a synthetic DiffResult marking every annotated class as CHANGED,
 * bypassing the registry comparison. Used by `--force`. We don't fabricate
 * DELETED entries here — force is for "regenerate everything I'm currently
 * shipping," not "wipe and reset."
 */
function forceAllChanged(annotated: DiscoveredClass[]): DiffResult {
  const changes: ChangeEntry[] = annotated.map((c) => ({
    op: "CHANGED",
    classUniqueId: c.classUniqueId,
    className: c.className,
    configEnd: c.configEnd,
    filePath: c.filePath,
    gitSha: c.gitSha,
  }));
  return { changes, unchanged: 0 };
}

/**
 * Render the per-root class tree, e.g.
 *
 *   ⏵ Found 1 @Confiqure root: NotificationPreferences
 *       ├─ NotificationPreferences.java   root, 9 fields
 *       ├─ EmailPreferences.java          referenced
 *       ├─ … (8 more)
 *
 * The point is to surface, before the upload confirm, exactly which files
 * we're about to ship and which classes the reachability walk traversed —
 * so a forgotten `@confiqure` doc-tag on a nested type is visible at a
 * glance rather than silently dropped.
 */
function renderTrees(scan: ScanResult): string {
  const lines: string[] = [];
  if (scan.annotated.length === 0) {
    lines.push(chalk.yellow("⚠ No @Confiqure roots found in scanPaths."));
    return lines.join("\n");
  }

  for (const root of scan.annotated) {
    const lang = root.language === "java" ? "" : chalk.dim(` (${root.language})`);
    lines.push(
      `${chalk.cyan("⏵")} Root: ${chalk.bold(root.className)}${lang} — ${root.relatedFiles.length} reachable file${root.relatedFiles.length === 1 ? "" : "s"}`
    );

    const sortedFiles = [...root.relatedFiles].sort();
    const lastIdx = sortedFiles.length - 1;
    for (let i = 0; i < sortedFiles.length; i++) {
      const file = sortedFiles[i];
      const isRoot = file === root.filePath;
      const prefix = i === lastIdx ? "└─" : "├─";
      const label = isRoot ? chalk.bold("root") : chalk.dim("referenced");
      lines.push(`    ${prefix} ${file}  ${label}`);
    }
  }

  return lines.join("\n");
}

function printDirtyWarning(dirty: DirtyFile[]): void {
  console.log();
  console.log(chalk.yellow("⚠"), chalk.bold("--allow-dirty: uploading working-tree content not in git history."));
  console.log(chalk.yellow("  Backend's gitVersion will not match any commit you can `git checkout`."));
  console.log();
  for (const f of dirty) {
    console.log(`    ${chalk.yellow(f.status)}  ${f.path}`);
  }
  console.log();
}

/**
 * Poll the backend's per-push status endpoint until each accepted class
 * reports `playbookReady`, or the timeout fires. Returns the count of
 * classes that did NOT reach ready before the deadline.
 */
async function watchGeneration(
  creds: Parameters<typeof getPushStatus>[0],
  items: UploadStatusItem[],
  targetWorkspaceKey?: string
): Promise<number> {
  const startedAt = Date.now();
  const pending = new Map<number, { className: string; startedAt: number }>();
  for (const item of items) {
    if (item.pushHistoryId == null) continue;
    pending.set(item.pushHistoryId, { className: item.className, startedAt });
  }

  let failures = 0;
  while (pending.size > 0) {
    if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
      for (const [, info] of pending) {
        console.log(`  ${chalk.yellow("⚠")} ${info.className.padEnd(28)} still generating after ${(WATCH_TIMEOUT_MS / 1000).toFixed(0)}s — check the dashboard`);
        failures++;
      }
      break;
    }

    await sleep(WATCH_INTERVAL_MS);

    const doneIds: number[] = [];
    for (const [pushHistoryId, info] of pending) {
      try {
        const status = await getPushStatus(creds, pushHistoryId, targetWorkspaceKey);
        if (status.playbookReady) {
          const elapsed = ((Date.now() - info.startedAt) / 1000).toFixed(1);
          console.log(`  ${chalk.green("✓")} ${info.className.padEnd(28)} ready (${elapsed}s)`);
          doneIds.push(pushHistoryId);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          console.log(`  ${chalk.red("✗")} ${info.className.padEnd(28)} not found (push deleted?)`);
          doneIds.push(pushHistoryId);
          failures++;
        }
        // Transient errors: silently retry on next tick.
      }
    }
    for (const id of doneIds) pending.delete(id);
  }
  return failures;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
