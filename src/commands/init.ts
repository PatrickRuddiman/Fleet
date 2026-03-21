import { Command } from "commander";
import fs from "fs";
import path from "path";
import readline from "readline";
import { loadComposeFile } from "../compose";
import { STACK_NAME_REGEX } from "../config/schema";
import { slugify, detectComposeFile, generateFleetYml } from "../init";
import { ParsedComposeFile } from "../compose/types";

function promptStackName(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const ask = (): void => {
      rl.question("Enter a valid stack name (lowercase alphanumeric and hyphens): ", (answer) => {
        const trimmed = answer.trim();
        if (STACK_NAME_REGEX.test(trimmed)) {
          rl.close();
          resolve(trimmed);
        } else {
          console.error(`Invalid stack name: "${trimmed}". Must match ${STACK_NAME_REGEX}.`);
          ask();
        }
      });
    };
    ask();
  });
}

export function register(program: Command): void {
  program
    .command("init")
    .description("Initialize a new Fleet project")
    .option("--force", "Overwrite existing fleet.yml")
    .action(async (opts: { force?: boolean }) => {
      const cwd = process.cwd();
      const fleetYmlPath = path.join(cwd, "fleet.yml");

      // Check for existing fleet.yml
      if (fs.existsSync(fleetYmlPath) && !opts.force) {
        console.error("fleet.yml already exists. Use --force to overwrite.");
        process.exit(1);
      }

      // Detect compose file
      const composeFilename = detectComposeFile(cwd);
      const composePath = path.join(cwd, composeFilename);

      // Parse compose file if it exists
      let compose: ParsedComposeFile | null = null;
      if (fs.existsSync(composePath)) {
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
      }

      // Derive stack name from parent directory
      const dirName = path.basename(cwd);
      let stackName = slugify(dirName);

      if (stackName === null) {
        console.log(`Could not derive a valid stack name from directory "${dirName}".`);
        stackName = await promptStackName();
      }

      // Generate fleet.yml
      const content = generateFleetYml({
        stackName,
        composeFilename,
        compose,
      });

      // Write fleet.yml
      fs.writeFileSync(fleetYmlPath, content, "utf-8");

      // Print summary
      const routedServices: string[] = [];
      const skippedServices: string[] = [];

      if (compose) {
        for (const [name, service] of Object.entries(compose.services)) {
          if (service.ports.length > 0) {
            routedServices.push(name);
          } else {
            skippedServices.push(name);
          }
        }
      }

      console.log(`\nCreated fleet.yml`);
      console.log(`  Stack name: ${stackName}`);
      console.log(`  Compose file: ${composeFilename}`);

      if (compose === null) {
        console.log(`  No compose file found. Routes section is empty.`);
      } else {
        console.log(`  Routes inferred: ${routedServices.length}`);
        if (routedServices.length > 0) {
          console.log(`    Routed services: ${routedServices.join(", ")}`);
        }
        if (skippedServices.length > 0) {
          console.log(`    Skipped services (no ports): ${skippedServices.join(", ")}`);
        }
      }

      console.log(`\nRemember to run \`fleet validate\` after editing fleet.yml.`);
    });
}
