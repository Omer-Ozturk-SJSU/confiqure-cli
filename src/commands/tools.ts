import { Command } from "commander";
import chalk from "chalk";
import { requireCredentials } from "../credentials.js";
import { listTools, deleteTool, ApiError } from "../api.js";

export function registerTools(program: Command): void {
  const tools = program
    .command("tools")
    .description("List or remove workspace tools (declare new ones as @Confiqure.Tool classes)");

  tools
    .command("list")
    .description("List tools registered in the current workspace")
    .action(async () => {
      const creds = await requireCredentials();
      const items = await listTools(creds);
      if (items.length === 0) {
        console.log(chalk.dim("(no tools registered)"));
        console.log(chalk.dim("Declare a @Confiqure.Tool class and run `confiqure push` to register its operations."));
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

  // Retired in CLI 1.0: tools are declared in code (annotation 3.0) and registered on push.
  tools
    .command("set <name>")
    .description("Retired — declare tools as @Confiqure.Tool classes; `confiqure push` registers them")
    .allowUnknownOption()
    .action(() => {
      console.error(
        chalk.red("✗"),
        "Since CLI 1.0 tools are declared in code as @Confiqure.Tool classes and registered on push; this command is retired."
      );
      process.exit(1);
    });

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
