import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("env")
    .description("Manage environment variables")
    .action(() => {
      console.log("env is not yet implemented");
    });
}
