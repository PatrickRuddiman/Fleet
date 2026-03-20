import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("stop")
    .description("Stop services")
    .action(() => {
      console.log("stop is not yet implemented");
    });
}
