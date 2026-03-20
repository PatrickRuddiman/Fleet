import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("teardown")
    .description("Tear down all services and resources")
    .action(() => {
      console.log("teardown is not yet implemented");
    });
}
