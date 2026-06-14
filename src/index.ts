#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { registerLogin } from "./commands/login.js";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerDiff } from "./commands/diff.js";
import { registerPush } from "./commands/push.js";
import { registerScaffold } from "./commands/scaffold.js";
import { registerTools } from "./commands/tools.js";
import { registerWorkspace } from "./commands/workspace.js";
import { registerListen } from "./commands/listen.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")
);

const program = new Command();
program
  .name("confiqure")
  .description("confiqure.ai CLI — push @Confiqure-annotated classes to your workspace")
  .version(pkg.version);

registerLogin(program);
registerInit(program);
registerStatus(program);
registerDiff(program);
registerPush(program);
registerScaffold(program);
registerTools(program);
registerWorkspace(program);
registerListen(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("✗"), msg);
  process.exit(1);
});
