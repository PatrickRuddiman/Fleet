import { Command } from "commander";
import { ps } from "../ps";

export function register(program: Command): void {
  program
    .command("ps")
    .description("List running services")
    .argument("[stack]", "Stack name to filter by")
    .action(async (stack?: string) => {
      try {
        await ps(stack);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Ps failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
