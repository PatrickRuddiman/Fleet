import { Command } from "commander";
import { proxyStatus } from "../proxy-status";
import { reloadProxy } from "../reload";

export function register(program: Command): void {
  const proxy = program
    .command("proxy")
    .description("Manage the proxy");

  proxy
    .command("status")
    .description("Show proxy status")
    .action(async () => {
      try {
        await proxyStatus();
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Proxy status failed with an unknown error.");
        }
        process.exit(1);
      }
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
