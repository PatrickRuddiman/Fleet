import { Command } from "commander";

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
    .action(() => {
      console.log("not yet implemented");
    });
}
