import { Command } from "commander";
import chalk from "chalk";
import { requireCredentials } from "../credentials.js";
import { loadConfig } from "../config.js";
import { scanProject } from "../scan.js";
import { diffAgainstRegistry, renderDiff } from "../diff.js";
import { getRegistry } from "../api.js";

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Compute the change-file vs the backend without uploading")
    .action(async () => {
      const cwd = process.cwd();
      const creds = await requireCredentials();
      const config = await loadConfig(cwd);

      const scan = await scanProject(cwd, config);
      console.log(chalk.dim(`Scanned ${scan.allFiles.size} files; ${scan.annotated.length} annotated.`));

      const registry = await getRegistry(creds);
      console.log(chalk.dim(`Backend registry: ${registry.length} class${registry.length === 1 ? "" : "es"}.`));

      const diff = diffAgainstRegistry(scan.annotated, registry);
      console.log();
      console.log(renderDiff(diff, {
        allScannedPaths: Array.from(scan.allFiles.keys()),
        annotatedPaths: scan.annotated.map((c) => c.filePath),
      }));
    });
}
