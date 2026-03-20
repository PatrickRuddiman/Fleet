import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("init")
    .description("Initialize a new Fleet project")
    .action(() => {
      console.log("init is not yet implemented");
    });
}
