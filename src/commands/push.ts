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
  getGuideRegistry,
  postGuides,
  promote,
  sandboxWorkspaceKey,
  Manifest,
  ManifestFileEntry,
  UploadStatusItem,
  ApiError,
} from "../api.js";
import { scanGuides, planGuideSync } from "../guides.js";
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
      if (scan.errors.length > 0) {
        console.log();
        console.log(chalk.red("✗"), chalk.bold(`Push blocked — ${scan.errors.length} annotation 3.0 error${scan.errors.length === 1 ? "" : "s"}:`));
        for (const e of scan.errors) console.log(`    ${e}`);
        process.exitCode = 1;
        return;
      }

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
      const toolCount = scan.toolClasses.length;
      const objectCount = scan.annotated.length - toolCount;
      console.log(chalk.dim(`Scanned ${scan.allFiles.size} files; ${objectCount} object${objectCount === 1 ? "" : "s"}, ${toolCount} tool class${toolCount === 1 ? "" : "es"}.`));

      // Show the class tree per root so the user can see exactly which files
      // we'll ship and why — covers the case the keyword scan used to miss
      // (nested types referenced from a root but never annotated themselves).
      console.log();
      console.log(renderTrees(scan));

      const frontendTools = scan.toolClasses.flatMap((tc) =>
        tc.operations.filter((op) => op.browser).map((op) => `${tc.name}.${op.name}`)
      );
      if (frontendTools.length > 0) {
        console.log();
        console.log(
          chalk.yellow("⚠"),
          chalk.bold(`${frontendTools.length} browser operation${frontendTools.length === 1 ? "" : "s"} declared (${frontendTools.join(", ")}).`)
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
        // Selective (--file) push is additive/update-only: tell the diff NOT to
        // compute deletions, so non-targeted roots (absent from the narrowed local
        // set) are never marked DELETED. A full push keeps deletes — it sees every root.
        diff = diffAgainstRegistry(scan.annotated, registry, { deletes: !opts.file });
      }

      // Defense-in-depth: a --file push must NEVER ship a DELETED for a root the dev
      // didn't target (that would tell the backend to wipe untouched endpoints).
      // diffAgainstRegistry already skips deletes in selective mode; this guarantees
      // it even if that path ever regresses.
      if (opts.file) {
        diff.changes = diff.changes.filter((c) => c.op !== "DELETED");
      }

      console.log();
      console.log(
        renderDiff(diff, {
          allScannedPaths: Array.from(scan.reachableFiles),
          annotatedPaths: scan.annotated.map((c) => c.filePath),
        })
      );

      // ── 1b. User guides (#316 P2) ────────────────────────────────────────
      // Runs BEFORE the "nothing to push" return below: guides are an
      // independent corpus, so an edit that only touches docs/user-guides must
      // still ship even when no annotated class changed. Skipped under --file,
      // which is an update-only push that must never compute deletions
      // (PUSH-008) — and guides sync is a full sync by definition.
      if (opts.file) {
        if ((config.guides ?? []).length > 0) {
          console.log();
          console.log(chalk.dim("Guides sync skipped: --file is a selective push. Run a full `confiqure push` to sync guides."));
        }
      } else {
        await syncGuides(creds, cwd, config, targetWorkspaceKey);
      }

      if (diff.changes.length === 0) {
        if (opts.file) {
          console.log();
          console.log(
            chalk.yellow("Nothing to push:"),
            `the selected root${scan.annotated.length === 1 ? " is" : "s are"} already up to date. ` +
              `Use ${chalk.cyan("--file <path> --force")} to re-push anyway.`
          );
        }
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

      // Ship only what CHANGED: each changed object's / tool class's reachable files (+ hook files).
      const fileShas = new Map<string, string>();
      for (const path of uploadPathsOf(scan, diff.changes)) {
        fileShas.set(path, await gitHashObject(path, cwd).catch(() => ""));
      }
      const manifest = buildManifest(scan, {
        changes: diff.changes,
        workspaceKey: targetWorkspaceKey,
        gitRef: ref,
        headSha,
        fileShas,
      });
      const shaCount = manifest.files.filter((f) => f.sha !== "").length;
      console.log(chalk.dim(`Git SHAs computed for ${shaCount}/${manifest.files.length} files.`));

      const uploadFiles = new Map<string, string>();
      for (const f of manifest.files) {
        const content = scan.allFiles.get(f.path);
        if (content != null) uploadFiles.set(f.path, content);
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
 * The files one push ships: every changed object's and tool class's reachable files (the tool
 * class source + the DTOs its operations reach), plus the `@Confiqure.DefaultCallbackHook` files.
 * Unchanged siblings already live on the backend — re-bundling them made it re-record them as
 * NESTED rows. DELETED entries ship nothing.
 */
export function uploadPathsOf(scan: ScanResult, changes: ChangeEntry[]): string[] {
  const changed = new Set(changes.filter((c) => c.op !== "DELETED").map((c) => c.classUniqueId));
  const paths = new Set<string>();
  for (const root of scan.annotated) {
    if (changed.has(root.classUniqueId)) for (const f of root.relatedFiles) paths.add(f);
  }
  for (const hf of scan.hookFiles) paths.add(hf.filePath);
  return Array.from(paths).sort();
}

/**
 * The upload manifest for `changes` (default: every scanned class, as `--force` sends it).
 * `toolClasses` carries only the tool classes among the changes, with their operations.
 */
export function buildManifest(
  scan: ScanResult,
  opts: {
    changes?: ChangeEntry[];
    workspaceKey?: string;
    gitRef?: string;
    headSha?: string;
    fileShas?: Map<string, string>;
  } = {}
): Manifest {
  const changes = opts.changes ?? forceAllChanged(scan.annotated).changes;
  const changed = new Set(changes.filter((c) => c.op !== "DELETED").map((c) => c.classUniqueId));
  const toolClasses = scan.toolClasses
    .filter((tc) => changed.has(tc.classUniqueId))
    .map((tc) => ({
      name: tc.name,
      className: tc.className,
      classUniqueId: tc.classUniqueId,
      doc: tc.doc,
      operations: tc.operations.map((op) => ({ ...op })),
    }));
  const toolFiles: ManifestFileEntry[] = scan.toolFiles
    .filter((tf) => changed.has(tf.filePath))
    .map((tf) => ({ path: tf.filePath, sha: tf.gitSha }));
  return {
    workspaceKey: opts.workspaceKey ?? "",
    gitRef: opts.gitRef ?? "",
    headSha: opts.headSha ?? "",
    language: scan.primaryLanguage,
    changes,
    files: uploadPathsOf(scan, changes).map((path) => ({ path, sha: opts.fileShas?.get(path) ?? "" })),
    toolFiles: toolFiles.length > 0 ? toolFiles : undefined,
    toolClasses: toolClasses.length > 0 ? toolClasses : undefined,
  };
}

/**
 * Sync the folders marked in `guides` (#316 P2): hash what's in the tree, ship
 * only what changed, and hand the backend the FULL local path list so a page
 * deleted in git is retired. Git is the version control; this mirrors it.
 *
 * Never fails the push. Guides are documentation, not configuration — a docs
 * folder the dev hasn't created yet, or a backend that doesn't speak /guides
 * (older engine), must not block shipping their classes.
 */
async function syncGuides(
  creds: Awaited<ReturnType<typeof requireCredentials>>,
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  targetWorkspaceKey: string
): Promise<void> {
  const folders = config.guides ?? [];
  if (folders.length === 0) return;

  let plan;
  try {
    const { guides, skipped } = await scanGuides(cwd, config);
    const registry = await getGuideRegistry(creds, targetWorkspaceKey);
    plan = planGuideSync(guides, registry, skipped);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      // The workspace's backend predates the guides endpoint. Say so once and move on.
      console.log();
      console.log(chalk.dim("Guides sync unavailable on this backend — skipping."));
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.log();
    console.log(chalk.yellow("⚠"), `Guides sync skipped: ${msg}`);
    return;
  }

  if (plan.upload.length === 0 && plan.retire.length === 0) {
    if (plan.unchanged.length > 0) {
      console.log();
      console.log(chalk.dim(`Guides: ${plan.unchanged.length} file${plan.unchanged.length === 1 ? "" : "s"} already in sync.`));
    }
    for (const s of plan.skipped) {
      console.log(`  ${chalk.yellow("⚠")} ${s.path} skipped — ${s.reason}`);
    }
    return;
  }

  console.log();
  console.log(
    `${chalk.cyan("⏵")} ${chalk.bold("Guides")} (${folders.join(", ")}): ` +
      `${plan.upload.length} to upload, ${plan.unchanged.length} unchanged, ${plan.retire.length} to retire.`
  );
  for (const s of plan.skipped) {
    console.log(`  ${chalk.yellow("⚠")} ${s.path} skipped — ${s.reason}`);
  }

  try {
    const resp = await postGuides(creds, plan.paths, plan.upload, targetWorkspaceKey);
    console.log(
      chalk.bold(
        `  Synced: ${resp.accepted} uploaded, ${resp.unchanged} unchanged, ${resp.retired} retired, ${resp.rejected} rejected.`
      )
    );
    for (const item of resp.items) {
      if (item.status === "UNCHANGED") continue; // already summarized; keep the list to what moved
      const icon =
        item.status === "ACCEPTED"
          ? chalk.green("✓")
          : item.status === "RETIRED"
            ? chalk.gray("−")
            : chalk.red("✗");
      const tail = item.error ? chalk.red(` — ${item.error}`) : "";
      console.log(`  ${icon} ${item.sourcePath}${tail}`);
    }
    if (resp.rejected > 0) {
      // Visible, but not fatal: the class push is the contract, guides are content.
      console.log(chalk.yellow("  ⚠ Some guides were rejected — see the reasons above."));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(chalk.yellow("  ⚠"), `Guides sync failed: ${msg}`);
  }
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
    // #316 P2: promote also mirrors the workspace's user guides sandbox → prod.
    // Server-side, alongside the tool registry and the knowledge template —
    // the CLI doesn't re-ship them, so say so rather than leave it invisible.
    console.log(chalk.dim("  User guides were mirrored to production with this promote."));
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
 * edit propagates.
 *
 * #120: `toolFiles`/`toolClasses`/`toolReachableFiles`/`hookFiles` are NOT
 * narrowed here. Since CLI 1.0 a tool class is a root of its own in `annotated`
 * (TOOL_CLASS), so `--file` can target it; the manifest ships only the tool
 * classes among the diff's changes, and a selective push never deletes.
 */
export function scopeToFile(scan: ScanResult, fileArg: string): void {
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

  console.log(
    `${chalk.cyan("⏵")} ${chalk.bold("--file")} ${fileArg}: matched ${roots.length} root${roots.length === 1 ? "" : "s"}, ${reachable.size} file${reachable.size === 1 ? "" : "s"}:`
  );
  for (const r of roots) {
    console.log(`    ${chalk.bold(r.className)}  ${chalk.dim(r.filePath)}`);
  }
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
    objectKind: c.objectKind,
    identityField: c.identityField,
    callback: c.callback,
    relatedFiles: c.relatedFiles,
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
    lines.push(chalk.yellow("⚠ No @Confiqure objects or tool classes found in scanPaths."));
    return lines.join("\n");
  }

  for (const root of scan.annotated) {
    const lang = root.language === "java" ? "" : chalk.dim(` (${root.language})`);
    const kind = root.objectKind === "TOOL_CLASS" ? "Tool class" : "Root";
    lines.push(
      `${chalk.cyan("⏵")} ${kind}: ${chalk.bold(root.className)}${lang} — ${root.relatedFiles.length} reachable file${root.relatedFiles.length === 1 ? "" : "s"}`
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
