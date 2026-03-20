import { Command } from "commander";
import { loadFleetConfig } from "../config";

export function register(program: Command): void {
  program
    .command("validate")
    .description("Validate the Fleet configuration")
    .argument("[file]", "path to fleet.yml", "./fleet.yml")
    .action((file: string) => {
      try {
        loadFleetConfig(file);
        console.log("Configuration is valid.");
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Validation failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
