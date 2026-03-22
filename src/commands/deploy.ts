import { Command } from "commander";
import { deploy, DeployOptions } from "../deploy";

export function register(program: Command): void {
  program
    .command("deploy")
    .description("Deploy services")
    .option("--skip-pull", "Skip pulling images before deploying")
    .option("--no-health-check", "Skip health checks after deploying")
    .option("--dry-run", "Preview changes without applying them")
    .option("-f, --force", "Force pull and redeploy all services")
    .action(async (opts: { skipPull?: boolean; healthCheck?: boolean; dryRun?: boolean; force?: boolean }) => {
      const options: DeployOptions = {
        skipPull: opts.skipPull ?? false,
        noHealthCheck: opts.healthCheck === false,
        dryRun: opts.dryRun ?? false,
        force: opts.force ?? false,
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
