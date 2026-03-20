import { Command } from "commander";

export function register(program: Command): void {
  program
    .command("validate")
    .description("Validate the Fleet configuration")
    .action(() => {
      console.log("validate is not yet implemented");
    });
}
