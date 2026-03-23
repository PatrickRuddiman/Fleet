import { Command } from "commander";
import path from "path";

export function register(program: Command): void {
  program
    .command("version")
    .description("Print the Fleet version")
    .action(() => {
      const packageJson = require(path.join(__dirname, "..", "..", "package.json"));
      console.log(packageJson.version);
    });
}
