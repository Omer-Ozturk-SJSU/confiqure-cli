import { Command } from "commander";
import { input, password } from "@inquirer/prompts";
import chalk from "chalk";
import {
  Credentials,
  credentialsPath,
  loadCredentials,
  saveCredentials,
} from "../credentials.js";
import { ApiError, getWhoami } from "../api.js";

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Save a workspace API key for the CLI to use")
    .option("--api-base <url>", "confiqure API base URL")
    .option(
      "--workspace <key>",
      "workspace key (6-letter) — skips the whoami lookup; useful for offline/scripted setup"
    )
    .option("--token <token>", "API token (cqai_…)")
    .action(async (opts: { apiBase?: string; workspace?: string; token?: string }) => {
      const existing = await loadCredentials();
      const apiBase: string =
        opts.apiBase ??
        (await input({
          message: "API base URL:",
          default: existing?.apiBase ?? "https://api.confiqure.ai",
        }));
      const token: string =
        opts.token ??
        (await password({
          message: "API token (cqai_…):",
          mask: "*",
          validate: (v) =>
            v.startsWith("cqai_") && v.length >= 16 ? true : "Token must start with cqai_",
        }));

      // Resolve workspaceKey. Manual override skips the network call (useful
      // for CI / offline setup); otherwise we ask the backend.
      let workspaceKey: string;
      let workspaceName: string | null = null;
      if (opts.workspace) {
        workspaceKey = opts.workspace;
      } else {
        try {
          const me = await getWhoami(apiBase, token);
          workspaceKey = me.workspaceKey;
          workspaceName = me.workspaceName;
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            console.error(chalk.red("✗"), "Invalid token — the server rejected this key.");
          } else if (e instanceof ApiError) {
            console.error(chalk.red("✗"), `whoami failed (${e.status}): ${e.message}`);
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(chalk.red("✗"), `Couldn't reach ${apiBase}: ${msg}`);
          }
          process.exit(1);
        }
      }

      const creds: Credentials = { apiBase, workspaceKey, token };
      await saveCredentials(creds);
      const who = workspaceName ? `${workspaceName} (${workspaceKey})` : workspaceKey;
      console.log(chalk.green("✓"), `Logged in as ${who}`);
      console.log(chalk.dim(`  apiBase: ${apiBase}`));
      console.log(chalk.dim(`  saved:   ${credentialsPath()}`));
    });
}
