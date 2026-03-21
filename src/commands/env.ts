import { Command } from "commander";
import { pushEnv } from "../env";

export function register(program: Command): void {
  program
    .command("env")
    .description("Push or refresh secrets (.env file) for the current stack")
    .action(async () => {
      try {
        await pushEnv();
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Env push failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
