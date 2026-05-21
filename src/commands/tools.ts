import { Command } from "commander";
import chalk from "chalk";
import { readFile } from "node:fs/promises";
import { requireCredentials } from "../credentials.js";
import { listTools, upsertTool, deleteTool, ApiError } from "../api.js";

export function registerTools(program: Command): void {
  const tools = program
    .command("tools")
    .description("List, register, or remove workspace tools (URL + instructions)");

  tools
    .command("list")
    .description("List tools registered in the current workspace")
    .action(async () => {
      const creds = await requireCredentials();
      const items = await listTools(creds);
      if (items.length === 0) {
        console.log(chalk.dim("(no tools registered)"));
        console.log(
          chalk.dim("Add one with: ") +
            chalk.cyan("confiqure tools set <name> --url <url> --instructions \"...\"")
        );
        return;
      }
      for (const t of items) {
        const firstLine = (t.instructions ?? "").split(/\r?\n/)[0] ?? "";
        console.log(`${chalk.cyan(t.name.padEnd(24))}  ${chalk.dim(t.url)}`);
        if (firstLine) {
          console.log(`  ${chalk.dim(firstLine)}`);
        }
      }
    });

  tools
    .command("set <name>")
    .description("Create or update a tool. Provide --url and (optionally) instructions.")
    .requiredOption("--url <url>", "Tool callback URL the backend will POST to")
    .option(
      "--instructions <text>",
      "Free-text guidance for the AI: what the tool does, when to invoke it"
    )
    .option(
      "--instructions-file <path>",
      "Read instructions from a file (e.g. instructions.md) — overrides --instructions"
    )
    .action(
      async (
        name: string,
        opts: { url: string; instructions?: string; instructionsFile?: string }
      ) => {
        const creds = await requireCredentials();
        let instructions: string | null = opts.instructions ?? null;
        if (opts.instructionsFile) {
          instructions = (await readFile(opts.instructionsFile, "utf8")).trim();
        }
        try {
          const saved = await upsertTool(creds, name, opts.url, instructions);
          console.log(chalk.green("✓"), `${saved.name} → ${saved.url}`);
          if (saved.instructions) {
            const first = saved.instructions.split(/\r?\n/)[0] ?? "";
            console.log(chalk.dim(`  ${first}`));
          }
        } catch (e) {
          if (e instanceof ApiError) {
            console.error(chalk.red("✗"), `set ${name} failed (${e.status}): ${e.message}`);
            process.exit(1);
          }
          throw e;
        }
      }
    );

  tools
    .command("delete <name>")
    .description("Remove a tool from this workspace")
    .action(async (name: string) => {
      const creds = await requireCredentials();
      try {
        await deleteTool(creds, name);
        console.log(chalk.green("✓"), `removed ${name}`);
      } catch (e) {
        if (e instanceof ApiError) {
          console.error(chalk.red("✗"), `delete ${name} failed (${e.status}): ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    });
}
