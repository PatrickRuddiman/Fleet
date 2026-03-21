import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection, ExecFn } from "../ssh";
import { readState, writeState, getStack, removeStack, RouteState } from "../state";
import { buildRemoveRouteCommand } from "../caddy";

export async function teardownStack(
  exec: ExecFn,
  stack: string,
  routes: RouteState[],
  volumes: boolean
): Promise<void> {
  for (const route of routes) {
    const result = await exec(buildRemoveRouteCommand(route.caddy_id));
    if (result.code !== 0) {
      throw new Error(
        `Failed to remove Caddy route "${route.caddy_id}": ${result.stderr}`
      );
    }
  }

  const command = volumes
    ? `docker compose -p ${stack} down --volumes`
    : `docker compose -p ${stack} down`;

  const result = await exec(command);
  if (result.code !== 0) {
    throw new Error(
      `Failed to run docker compose down for stack "${stack}": ${result.stderr}`
    );
  }
}

export async function teardown(stack: string, volumes: boolean): Promise<void> {
  let connection: Connection | null = null;

  try {
    // Step 1: Load config
    console.log("Step 1: Loading configuration...");
    const configPath = path.resolve("fleet.yml");
    const config = loadFleetConfig(configPath);

    // Step 2: Connect to server
    console.log("Step 2: Connecting to server...");
    connection = await createConnection(config.server);
    const exec = connection.exec;

    // Step 3: Read server state and validate stack exists
    console.log("Step 3: Reading server state...");
    const state = await readState(exec);
    const stackState = getStack(state, stack);
    if (!stackState) {
      throw new Error(
        `Stack "${stack}" not found in server state. Run 'fleet deploy' first.`
      );
    }

    // Warn if volumes flag is set
    if (volumes) {
      console.warn(
        `\nWarning: --volumes flag is set. This will irreversibly delete all persistent volumes for stack "${stack}".`
      );
    }

    // Step 4: Tear down the stack (remove routes + docker compose down)
    console.log(`Step 4: Tearing down stack "${stack}"...`);
    await teardownStack(exec, stack, stackState.routes, volumes);

    // Step 5: Update state
    console.log("Step 5: Updating server state...");
    const newState = removeStack(state, stack);
    await writeState(exec, newState);

    // Print success
    console.log(
      `\nSuccess: Stack "${stack}" has been torn down.`
    );
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nTeardown failed: ${error.message}`);
    } else {
      console.error("\nTeardown failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
