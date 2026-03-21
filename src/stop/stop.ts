import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection, ExecFn } from "../ssh";
import { readState, writeState, getStack, removeStack, StackState } from "../state";
import { buildRemoveRouteCommand } from "../caddy";

export async function stopStack(
  exec: ExecFn,
  stackName: string,
  stackState: StackState
): Promise<void> {
  // Step 1: Remove Caddy routes sequentially
  for (const route of stackState.routes) {
    const removeCmd = buildRemoveRouteCommand(route.caddy_id);
    const result = await exec(removeCmd);

    if (result.code !== 0) {
      throw new Error(
        `Failed to remove Caddy route "${route.caddy_id}": ${result.stderr}`
      );
    }
  }

  // Step 2: Stop containers
  const stopResult = await exec(`docker compose -p ${stackName} stop`);

  if (stopResult.code !== 0) {
    throw new Error(
      `Failed to stop containers for stack "${stackName}": ${stopResult.stderr}`
    );
  }
}

export async function stop(stackName: string): Promise<void> {
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
    const stackState = getStack(state, stackName);
    if (!stackState) {
      throw new Error(
        `Stack "${stackName}" not found in server state. Run 'fleet deploy' first.`
      );
    }

    // Step 5: Stop the stack (remove routes + stop containers)
    console.log(`Stopping stack "${stackName}"...`);
    await stopStack(exec, stackName, stackState);

    // Step 6: Remove stack from state and write updated state
    console.log("Updating server state...");
    const updatedState = removeStack(state, stackName);
    await writeState(exec, updatedState);

    // Step 7: Print success
    console.log(
      `\nSuccess: Stack "${stackName}" has been stopped.`
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nStop failed: ${error.message}`);
    } else {
      console.error("\nStop failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
