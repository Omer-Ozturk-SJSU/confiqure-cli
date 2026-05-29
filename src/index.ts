#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { registerLogin } from "./commands/login.js";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerDiff } from "./commands/diff.js";
import { registerPush } from "./commands/push.js";
import { registerScaffold } from "./commands/scaffold.js";
import { registerTools } from "./commands/tools.js";
import { registerWorkspace } from "./commands/workspace.js";

const program = new Command();
program
  .name("confiqure")
  .description("confiqure.ai CLI — push @Confiqure-annotated classes to your workspace")
  .version("0.1.0");

registerLogin(program);
registerInit(program);
registerStatus(program);
registerDiff(program);
registerPush(program);
registerScaffold(program);
registerTools(program);
registerWorkspace(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("✗"), msg);
  process.exit(1);
});
