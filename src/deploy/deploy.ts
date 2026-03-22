import fs from "fs";
import path from "path";
import { loadFleetConfig } from "../config";
import { loadComposeFile, getServiceNames } from "../compose";
import { runAllChecks } from "../validation";
import { createConnection, Connection } from "../ssh";
import { readState, writeState, StackState } from "../state";
import { STACKS_DIR } from "../fleet-root";
import { DeployOptions } from "./types";
import {
  detectHostCollisions,
  bootstrapProxy,
  uploadFile,
  resolveSecrets,
  attachNetworks,
  checkHealth,
  registerRoutes,
  printSummary,
  configHasSecrets,
  pullSelectiveImages,
} from "./helpers";
import { bootstrapInfisicalCli } from "./infisical";
import { computeDefinitionHash, computeEnvHash } from "./hashes";
import type { CandidateHashes } from "./classify";

export async function deploy(options: DeployOptions): Promise<void> {
  const warnings: string[] = [];
  let connection: Connection | null = null;

  try {
    // Step 1: Load and validate config
    console.log("Step 1: Loading and validating configuration...");
    const configPath = path.resolve("fleet.yml");
    const config = loadFleetConfig(configPath);

    const composePath = path.resolve(
      path.dirname(configPath),
      config.stack.compose_file
    );
    const compose = loadComposeFile(composePath);

    const findings = runAllChecks(config, compose);
    const errors = findings.filter((f) => f.severity === "error");
    if (errors.length > 0) {
      console.error("\nValidation errors:");
      for (const finding of errors) {
        console.error(`  ✗ [${finding.code}] ${finding.message}`);
      }
      process.exit(1);
    }

    const findingWarnings = findings.filter((f) => f.severity === "warning");
    for (const finding of findingWarnings) {
      warnings.push(`[${finding.code}] ${finding.message}`);
    }

    // Step 2: Connect to server
    console.log("Step 2: Connecting to server...");
    connection = await createConnection(config.server);
    const exec = connection.exec;

    // Step 3: Read server state
    console.log("Step 3: Reading server state...");
    let state = await readState(exec);

    // Step 4: Check for host collisions
    console.log("Step 4: Checking for host collisions...");
    const collisions = detectHostCollisions(
      config.routes,
      state,
      config.stack.name
    );
    if (collisions.length > 0) {
      console.error("\nHost collisions detected:");
      for (const collision of collisions) {
        console.error(
          `  ✗ ${collision.host} is already owned by stack "${collision.ownedByStack}"`
        );
      }
      process.exit(1);
    }

    // Step 5: Bootstrap proxy
    console.log("Step 5: Bootstrapping proxy...");
    const acmeEmail = config.routes.find((r) => r.acme_email)?.acme_email;
    const bootstrapResult = await bootstrapProxy(exec, state, acmeEmail);
    const fleetRoot = bootstrapResult.fleetRoot;
    state = bootstrapResult.updatedState;

    // Dry-run exit point
    if (options.dryRun) {
      console.log("\n--- Dry Run Summary ---");
      console.log(`Stack: ${config.stack.name}`);
      console.log(`Fleet root: ${fleetRoot}`);
      console.log("Routes to be configured:");
      for (const route of config.routes) {
        const protocol = route.tls !== false ? "https" : "http";
        console.log(`  ${protocol}://${route.domain} → ${route.service || "default"}:${route.port}`);
      }
      if (warnings.length > 0) {
        console.log("\nWarnings:");
        for (const w of warnings) {
          console.log(`  ⚠ ${w}`);
        }
      }
      console.log("\nDry run complete. No changes were made.");
      return;
    }

    const stackDir = `${fleetRoot}/${STACKS_DIR}/${config.stack.name}`;

    // Step 6: Create stack directory
    console.log("Step 6: Creating stack directory...");
    const mkdirResult = await exec(`mkdir -p ${stackDir}`);
    if (mkdirResult.code !== 0) {
      throw new Error(
        `Failed to create stack directory: ${mkdirResult.stderr}`
      );
    }

    // Step 7: Upload compose file
    console.log("Step 7: Uploading compose file...");
    const composeContent = fs.readFileSync(composePath, "utf-8");
    await uploadFile(exec, {
      content: composeContent,
      remotePath: `${stackDir}/compose.yml`,
    });

    // Step 8: Upload fleet.yml
    console.log("Step 8: Uploading fleet.yml...");
    const fleetYmlContent = fs.readFileSync(configPath, "utf-8");
    await uploadFile(exec, {
      content: fleetYmlContent,
      remotePath: `${stackDir}/fleet.yml`,
    });

    // Step 9: Resolve and upload secrets
    console.log("Step 9: Resolving secrets...");
    if (config.env && !Array.isArray(config.env) && "infisical" in config.env && config.env.infisical) {
      console.log("  Bootstrapping Infisical CLI...");
      await bootstrapInfisicalCli(exec);
    }
    await resolveSecrets(exec, config, stackDir, path.dirname(configPath));

    // Step 10: Compute hashes for selective deploy
    console.log("Step 10: Computing hashes for selective deploy...");
    const candidateHashes: Record<string, CandidateHashes> = {};
    for (const [serviceName, service] of Object.entries(compose.services)) {
      candidateHashes[serviceName] = {
        definitionHash: computeDefinitionHash(service),
        imageDigest: null,
      };
    }

    const newEnvHash = configHasSecrets(config)
      ? await computeEnvHash(exec, stackDir + "/.env")
      : null;

    const existingStackState = state.stacks[config.stack.name];
    const envHashChanged = newEnvHash !== existingStackState?.env_hash;

    // Step 11: Pull images
    if (!options.skipPull) {
      console.log("Step 11: Pulling images...");
      await pullSelectiveImages(
        exec,
        compose,
        config.stack.name,
        stackDir,
        getServiceNames(compose),
        options.force
      );
    } else {
      console.log("Step 11: Skipping image pull (--skip-pull).");
    }

    // Step 12: Start containers
    console.log("Step 12: Starting containers...");
    const hasSecrets = configHasSecrets(config);
    const envFileFlag = hasSecrets ? ` --env-file ${stackDir}/.env` : "";
    const upResult = await exec(
      `docker compose -p ${config.stack.name} -f ${stackDir}/compose.yml${envFileFlag} up -d --remove-orphans`
    );
    if (upResult.code !== 0) {
      throw new Error(`Failed to start containers: ${upResult.stderr}`);
    }

    // Step 13: Attach containers to fleet-proxy network
    console.log("Step 13: Attaching containers to fleet-proxy network...");
    const routedServices = config.routes
      .map((r) => r.service)
      .filter((s): s is string => s !== undefined);
    const uniqueServices = [
      ...new Set(
        routedServices.length > 0 ? routedServices : getServiceNames(compose)
      ),
    ];
    await attachNetworks(exec, config.stack.name, uniqueServices);

    // Step 14: Health checks
    if (!options.noHealthCheck) {
      console.log("Step 14: Running health checks...");
      for (const route of config.routes) {
        if (route.health_check) {
          const serviceName =
            route.service || getServiceNames(compose)[0];
          const warning = await checkHealth(
            exec,
            config.stack.name,
            serviceName,
            route.port,
            route.health_check
          );
          if (warning) {
            warnings.push(warning);
          }
        }
      }
    } else {
      console.log("Step 14: Skipping health checks (--no-health-check).");
    }

    // Step 15: Register Caddy routes
    console.log("Step 15: Registering routes with Caddy...");
    const routeStates = await registerRoutes(
      exec,
      config.stack.name,
      config.routes
    );

    // Step 16: Write state
    console.log("Step 16: Writing server state...");
    const stackState: StackState = {
      path: stackDir,
      compose_file: config.stack.compose_file,
      deployed_at: new Date().toISOString(),
      routes: routeStates,
    };
    state = {
      ...state,
      fleet_root: fleetRoot,
      stacks: {
        ...state.stacks,
        [config.stack.name]: stackState,
      },
    };
    await writeState(exec, state);

    // Step 17: Print summary
    console.log("Step 17: Printing summary...");
    await printSummary(
      exec,
      config.stack.name,
      stackDir,
      config.routes,
      warnings
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nDeploy failed: ${error.message}`);
    } else {
      console.error("\nDeploy failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
