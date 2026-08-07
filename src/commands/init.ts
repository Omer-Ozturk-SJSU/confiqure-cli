import { Command } from "commander";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  loadConfig,
  ProjectConfig,
  saveConfig,
} from "../config.js";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description(`Generate or update ${CONFIG_FILE} in the current directory`)
    .option("-y, --yes", "accept defaults without prompting")
    .action(async (opts: { yes?: boolean }) => {
      const cwd = process.cwd();
      const path = join(cwd, CONFIG_FILE);
      const exists = existsSync(path);

      if (exists && !opts.yes) {
        const overwrite = await confirm({
          message: `${CONFIG_FILE} already exists. Update it?`,
          default: true,
        });
        if (!overwrite) {
          console.log(chalk.yellow("Aborted."));
          return;
        }
      }

      const existing = exists ? await loadConfig(cwd) : DEFAULT_CONFIG;

      let config: ProjectConfig = existing;
      if (!opts.yes) {
        const scanPathsRaw = await input({
          message: "Scan paths (comma-separated globs):",
          default: existing.scanPaths.join(", "),
        });
        const guidesRaw = await input({
          message: "User-guide folders to keep in sync (comma-separated, blank for none):",
          default: (existing.guides ?? []).join(", "),
        });
        const ignoreRaw = await input({
          message: "Directories to ignore (comma-separated):",
          default: existing.ignore.join(", "),
        });
        config = {
          ...existing,
          scanPaths: scanPathsRaw.split(",").map((s) => s.trim()).filter(Boolean),
          guides: guidesRaw.split(",").map((s) => s.trim()).filter(Boolean),
          ignore: ignoreRaw.split(",").map((s) => s.trim()).filter(Boolean),
        };
      }

      await saveConfig(cwd, config);
      console.log(chalk.green("✓"), `Wrote ${path}`);
      console.log(chalk.dim(`  scanPaths: ${config.scanPaths.join(", ")}`));
      console.log(
        chalk.dim(
          `  guides: ${config.guides.length > 0 ? config.guides.join(", ") : "(none)"}`
        )
      );
      console.log(chalk.dim(`  ignore: ${config.ignore.join(", ")}`));
      console.log(chalk.dim(`  languages: ${Object.keys(config.languages).join(", ")}`));
      if (config.guides.length > 0) {
        console.log(
          chalk.dim(
            `  Drop .md/.html/.pdf/.txt pages and screenshots in ${config.guides[0]} — ` +
              `confiqure push keeps them in sync and the chat answers how-to questions from them.`
          )
        );
      }
    });
}
