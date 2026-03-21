import { Command } from "commander";
import { teardown } from "../teardown";

export function register(program: Command): void {
  program
    .command("teardown")
    .description("Tear down a deployed stack")
    .argument("<stack>", "Name of the deployed stack")
    .option("--volumes", "Remove persistent volumes")
    .action(async (stack: string, opts: { volumes?: boolean }) => {
      try {
        await teardown(stack, opts.volumes ?? false);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Teardown failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
