import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection, ExecFn } from "../ssh";
import { readState, getStack } from "../state";

export async function restartService(
  exec: ExecFn,
  stack: string,
  service: string
): Promise<void> {
  const result = await exec(
    `docker compose -p ${stack} restart ${service}`
  );

  if (result.code !== 0) {
    throw new Error(
      `Failed to restart service "${service}" in stack "${stack}": ${result.stderr}`
    );
  }
}

export async function restart(stack: string, service: string): Promise<void> {
  let connection: Connection | null = null;

  try {
    // Step 1: Load and validate config
    console.log("Loading configuration...");
    const configPath = path.resolve("fleet.yml");
    const config = loadFleetConfig(configPath);

    // Step 2: Connect to server
    console.log("Connecting to server...");
    connection = await createConnection(config.server);
    const exec = connection.exec;

    // Step 3: Read server state
    console.log("Reading server state...");
    const state = await readState(exec);

    // Step 4: Validate stack exists
    const stackState = getStack(state, stack);
    if (!stackState) {
      throw new Error(
        `Stack "${stack}" not found in server state. Run 'fleet deploy' first.`
      );
    }

    // Step 5: Restart the service
    console.log(`Restarting service "${service}" in stack "${stack}"...`);
    await restartService(exec, stack, service);

    // Step 6: Print success
    console.log(
      `\nSuccess: Service "${service}" in stack "${stack}" has been restarted.`
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nRestart failed: ${error.message}`);
    } else {
      console.error("\nRestart failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
