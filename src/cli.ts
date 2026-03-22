import { Command } from "commander";
import path from "path";

import { register as registerInit } from "./commands/init";
import { register as registerValidate } from "./commands/validate";
import { register as registerDeploy } from "./commands/deploy";
import { register as registerPs } from "./commands/ps";
import { register as registerLogs } from "./commands/logs";
import { register as registerRestart } from "./commands/restart";
import { register as registerStop } from "./commands/stop";
import { register as registerTeardown } from "./commands/teardown";
import { register as registerEnv } from "./commands/env";
import { register as registerProxy } from "./commands/proxy";

export function createProgram(): Command {
  const program = new Command();

  const packageJson = require(path.join(__dirname, "..", "package.json"));

  program
    .name("fleet")
    .version(packageJson.version)
    .description("A TypeScript CLI tool for managing deployments");

  registerInit(program);
  registerValidate(program);
  registerDeploy(program);
  registerPs(program);
  registerLogs(program);
  registerRestart(program);
  registerStop(program);
  registerTeardown(program);
  registerEnv(program);
  registerProxy(program);

  return program;
}

if (require.main === module) {
  const program = createProgram();
  program.parse(process.argv);
}
