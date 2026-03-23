import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection } from "../ssh";
import { readState, getStack } from "../state";
import { resolveSecrets, configHasSecrets } from "../deploy";
export async function pushEnv(): Promise<void> {
  let connection: Connection | null = null;

  try {
    // Step 1: Load and validate config
    console.log("Step 1: Loading and validating configuration...");
    const configPath = path.resolve("fleet.yml");
    const config = loadFleetConfig(configPath);

    // Step 2: Validate env source presence (fail fast, before SSH)
    if (!configHasSecrets(config)) {
      throw new Error(
        "No env source configured in fleet.yml. Define an 'env' array, env.file, or env.infisical block."
      );
    }

    // Step 3: Connect to server
    console.log("Step 2: Connecting to server...");
    connection = await createConnection(config.server);
    const exec = connection.exec;

    // Step 4: Read server state
    console.log("Step 3: Reading server state...");
    const state = await readState(exec);

    // Step 5: Look up stack in state
    console.log("Step 4: Looking up stack in server state...");
    const stackState = getStack(state, config.stack.name);
    if (!stackState) {
      throw new Error(
        `Stack "${config.stack.name}" not found in server state. Run 'fleet deploy' first.`
      );
    }

    const stackDir = stackState.path;

    // Step 6: Resolve and upload secrets
    console.log("Step 5: Resolving and pushing secrets...");
    await resolveSecrets(exec, config, stackDir, path.dirname(configPath));

    // Step 7: Log success
    console.log(
      `\nSuccess: .env file written for stack "${config.stack.name}".`
    );
    console.log(
      "If your services need to pick up the new values, restart them with 'fleet restart'."
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nEnv push failed: ${error.message}`);
    } else {
      console.error("\nEnv push failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
