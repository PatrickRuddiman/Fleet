import { Command } from "commander";
import { deploy, DeployOptions } from "../deploy";

export function register(program: Command): void {
  program
    .command("deploy")
    .description("Deploy services")
    .option("--skip-pull", "Skip pulling images before deploying")
    .option("--no-health-check", "Skip health checks after deploying")
    .option("--dry-run", "Preview changes without applying them")
    .action(async (opts: { skipPull?: boolean; healthCheck?: boolean; dryRun?: boolean }) => {
      const options: DeployOptions = {
        skipPull: opts.skipPull ?? false,
        noHealthCheck: opts.healthCheck === false,
        dryRun: opts.dryRun ?? false,
      };

      try {
        await deploy(options);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Deploy failed with an unknown error.");
        }
        process.exit(1);
      }
    });
}
