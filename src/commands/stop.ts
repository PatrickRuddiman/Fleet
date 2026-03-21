import { Command } from "commander";
import { stop } from "../stop";

export function register(program: Command): void {
  program
    .command("stop")
    .description("Stop a deployed stack")
    .argument("<stack>", "Name of the deployed stack")
    .action(async (stack: string) => {
      try {
        await stop(stack);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Stop failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
