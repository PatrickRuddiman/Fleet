import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("logs")
    .description("View service logs")
    .action(() => {
      console.log("logs is not yet implemented");
    });
}
