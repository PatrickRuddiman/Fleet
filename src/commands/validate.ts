import { Command } from "commander";
import path from "path";
import { loadFleetConfig } from "../config";
import { loadComposeFile } from "../compose";
import { runAllChecks, Finding } from "../validation";

export function register(program: Command): void {
  program
    .command("validate")
    .description("Validate the Fleet configuration")
    .argument("[file]", "path to fleet.yml", "./fleet.yml")
    .action((file: string) => {
      let config;
      try {
        config = loadFleetConfig(file);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Validation failed with an unknown error.");
        }
        process.exit(1);
      }

      const dir = path.dirname(file);
      const composePath = path.resolve(dir, config.stack.compose_file);

      let compose;
      try {
        compose = loadComposeFile(composePath);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Failed to load compose file.");
        }
        process.exit(1);
      }

      const findings = runAllChecks(config, compose);

      const errors = findings.filter(
        (f: Finding) => f.severity === "error",
      );
      const warnings = findings.filter(
        (f: Finding) => f.severity === "warning",
      );

      if (errors.length > 0) {
        console.error("\nErrors:");
        for (const finding of errors) {
          console.error(
            `  ✗ [${finding.code}] ${finding.message}`,
          );
          console.error(
            `    Resolution: ${finding.resolution}`,
          );
        }
      }

      if (warnings.length > 0) {
        console.warn("\nWarnings:");
        for (const finding of warnings) {
          console.warn(
            `  ⚠ [${finding.code}] ${finding.message}`,
          );
          console.warn(
            `    Resolution: ${finding.resolution}`,
          );
        }
      }

      console.log(
        `\nFound ${errors.length} error(s) and ${warnings.length} warning(s).`,
      );

      if (errors.length > 0) {
        process.exit(1);
      }
    });
}
