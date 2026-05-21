import { Command } from "commander";
import chalk from "chalk";
import { requireCredentials } from "../credentials.js";
import { getWorkspace, updateWorkspace, ApiError } from "../api.js";

export function registerWorkspace(program: Command): void {
  const ws = program
    .command("workspace")
    .description("View or update workspace-level settings (e.g. default callback URL)");

  ws.command("get")
    .description("Show workspace settings")
    .action(async () => {
      const creds = await requireCredentials();
      try {
        const data = await getWorkspace(creds);
        console.log(`${chalk.bold("workspace")} ${data.urlKey} (${data.name})`);
        console.log(`  defaultCallbackUrl: ${data.defaultCallbackUrl ?? chalk.dim("(unset)")}`);
      } catch (e) {
        if (e instanceof ApiError) {
          console.error(chalk.red("✗"), `get failed (${e.status}): ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    });

  ws.command("set")
    .description("Update workspace settings. Pass --default-callback-url '' to clear.")
    .option(
      "--default-callback-url <url>",
      "Fallback URL used when @Confiqure(callback=\"\") is blank on a class"
    )
    .action(async (opts: { defaultCallbackUrl?: string }) => {
      const creds = await requireCredentials();
      if (opts.defaultCallbackUrl === undefined) {
        console.log(chalk.yellow("Nothing to update. Pass --default-callback-url <url>."));
        return;
      }
      try {
        const saved = await updateWorkspace(creds, {
          defaultCallbackUrl: opts.defaultCallbackUrl,
        });
        console.log(chalk.green("✓"), `workspace ${saved.urlKey}`);
        console.log(`  defaultCallbackUrl: ${saved.defaultCallbackUrl ?? chalk.dim("(unset)")}`);
      } catch (e) {
        if (e instanceof ApiError) {
          console.error(chalk.red("✗"), `set failed (${e.status}): ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    });
}
