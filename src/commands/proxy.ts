import { Command } from "commander";
import { reloadProxy } from "../reload";

export function register(program: Command): void {
  const proxy = program
    .command("proxy")
    .description("Manage the proxy");

  proxy
    .command("status")
    .description("Show proxy status")
    .action(() => {
      console.log("not yet implemented");
    });

  proxy
    .command("reload")
    .description("Reload proxy configuration")
    .action(async () => {
      try {
        await reloadProxy();
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Reload failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
