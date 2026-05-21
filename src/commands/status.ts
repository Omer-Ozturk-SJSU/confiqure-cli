import { Command } from "commander";
import chalk from "chalk";
import { credentialsPath, loadCredentials } from "../credentials.js";
import { gitStatus } from "../git.js";
import { loadConfig } from "../config.js";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show credential state, workspace, and git status")
    .action(async () => {
      const creds = await loadCredentials();
      console.log(chalk.bold("Credentials"));
      if (creds) {
        console.log(`  apiBase:      ${creds.apiBase}`);
        console.log(`  workspaceKey: ${creds.workspaceKey}`);
        console.log(`  token:        ${creds.token.slice(0, 12)}…`);
        console.log(`  file:         ${credentialsPath()}`);
      } else {
        console.log(chalk.yellow(`  not configured — run \`confiqure login\``));
      }

      console.log();
      console.log(chalk.bold("Project config"));
      try {
        const config = await loadConfig(process.cwd());
        console.log(`  scanPaths: ${config.scanPaths.join(", ")}`);
        console.log(`  languages: ${Object.keys(config.languages).join(", ")}`);
      } catch (e) {
        console.log(chalk.dim(`  (could not read confiqure.config.json: ${(e as Error).message})`));
      }

      console.log();
      console.log(chalk.bold("Git"));
      try {
        const g = await gitStatus(process.cwd());
        console.log(`  branch:    ${g.branch}`);
        console.log(`  dirty:     ${g.isDirty ? chalk.yellow("yes") : "no"}`);
        console.log(`  upstream:  ${g.upstreamConfigured ? "configured" : chalk.dim("(none)")}`);
        if (g.upstreamConfigured) {
          console.log(`  ahead:     ${g.aheadOfUpstream ? chalk.yellow("yes") : "no"}`);
        }
      } catch (e) {
        console.log(chalk.dim(`  (not a git repo: ${(e as Error).message})`));
      }
    });
}
