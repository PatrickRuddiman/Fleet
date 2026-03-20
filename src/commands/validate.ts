import { Command } from "commander";
import path from "path";
import { loadFleetConfig } from "../config";
import {
  loadComposeFile,
  serviceExists,
  findServicesWithoutImageOrBuild,
  findHostPortBindings,
  findReservedPortConflicts,
} from "../compose";

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

      const errors: string[] = [];
      const warnings: string[] = [];

      for (const route of config.routes) {
        if (route.service !== undefined && !serviceExists(compose, route.service)) {
          errors.push(
            `Route "${route.domain}" references service "${route.service}" which does not exist in ${composePath}`
          );
        }
      }

      const reservedConflicts = findReservedPortConflicts(compose);
      for (const binding of reservedConflicts) {
        errors.push(
          `Service "${binding.service}" binds host port ${binding.hostPort} which is reserved for Caddy`
        );
      }

      const noImageOrBuild = findServicesWithoutImageOrBuild(compose);
      for (const name of noImageOrBuild) {
        warnings.push(
          `Service "${name}" has no "image" or "build" directive`
        );
      }

      const allBindings = findHostPortBindings(compose);
      for (const binding of allBindings) {
        if (binding.hostPort !== 80 && binding.hostPort !== 443) {
          warnings.push(
            `Service "${binding.service}" binds host port ${binding.hostPort} which may conflict with other stacks`
          );
        }
      }

      if (errors.length > 0) {
        console.error("\nErrors:");
        for (const err of errors) {
          console.error(`  ✗ ${err}`);
        }
      }

      if (warnings.length > 0) {
        console.warn("\nWarnings:");
        for (const warn of warnings) {
          console.warn(`  ⚠ ${warn}`);
        }
      }

      if (errors.length === 0 && warnings.length === 0) {
        console.log("Configuration is valid.");
      } else if (errors.length === 0) {
        console.log("\nConfiguration is valid (with warnings).");
      }

      if (errors.length > 0) {
        process.exit(1);
      }
    });
}
