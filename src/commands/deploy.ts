import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("deploy")
    .description("Deploy services")
    .action(() => {
      console.log("deploy is not yet implemented");
    });
}
