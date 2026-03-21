import { Command } from "commander";
import { restart } from "../restart";

export function register(program: Command): void {
  program
    .command("restart")
    .description("Restart a service within a deployed stack")
    .argument("<stack>", "Name of the deployed stack")
    .argument("<service>", "Name of the service to restart")
    .action(async (stack: string, service: string) => {
      try {
        await restart(stack, service);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Restart failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
