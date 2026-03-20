import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("ps")
    .description("List running services")
    .action(() => {
      console.log("ps is not yet implemented");
    });
}
