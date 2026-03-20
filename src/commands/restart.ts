import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("restart")
    .description("Restart services")
    .action(() => {
      console.log("restart is not yet implemented");
    });
}
