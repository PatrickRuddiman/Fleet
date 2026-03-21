import { Command } from "commander";
import { logs } from "../logs";

export function register(program: Command): void {
  program
    .command("logs")
    .description("View service logs")
    .argument("<stack>", "Stack name")
    .argument("[service]", "Service name")
    .option("-n, --tail <lines>", "Number of lines to show")
    .action(async (stack: string, service: string | undefined, opts: { tail?: string }) => {
      let tail: number | undefined;
      if (opts.tail !== undefined) {
        tail = Number(opts.tail);
        if (!Number.isInteger(tail) || tail <= 0) {
          console.error("Error: --tail must be a positive integer.");
          process.exit(1);
        }
      }

      try {
        await logs(stack, service, tail);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Logs failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
