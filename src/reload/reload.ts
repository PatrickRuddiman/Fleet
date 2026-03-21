import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection, ExecFn } from "../ssh";
import { readState, FleetState } from "../state";
import {
  buildRemoveRouteCommand,
  buildAddRouteCommand,
  CADDY_CONTAINER_NAME,
} from "../caddy";

export interface ReloadResult {
  total: number;
  succeeded: number;
  failed: { host: string; stackName: string; error: string }[];
}

export async function reloadRoutes(
  exec: ExecFn,
  state: FleetState
): Promise<ReloadResult> {
  // Step 1: Verify Caddy is running
  const inspectResult = await exec(
    `docker inspect --format='{{.State.Running}}' ${CADDY_CONTAINER_NAME}`
  );

  if (
    inspectResult.code !== 0 ||
    inspectResult.stdout.trim() !== "true"
  ) {
    throw new Error(
      `Caddy container "${CADDY_CONTAINER_NAME}" is not running. Start the proxy first with 'fleet deploy'.`
    );
  }

  // Step 2: Collect all routes from state
  const items: { stackName: string; route: { host: string; service: string; port: number; caddy_id: string } }[] = [];

  for (const [stackName, stackState] of Object.entries(state.stacks)) {
    for (const route of stackState.routes) {
      items.push({ stackName, route });
    }
  }

  // Step 3: Process each route (delete-then-post, fault-tolerant)
  const failed: { host: string; stackName: string; error: string }[] = [];
  let succeeded = 0;

  for (const { stackName, route } of items) {
    // Delete existing route (ignore errors)
    await exec(buildRemoveRouteCommand(route.caddy_id));

    // Re-add the route
    const addResult = await exec(
      buildAddRouteCommand({
        stackName,
        serviceName: route.service,
        domain: route.host,
        upstreamHost: `${stackName}-${route.service}-1`,
        upstreamPort: route.port,
      })
    );

    if (addResult.code !== 0) {
      failed.push({
        host: route.host,
        stackName,
        error: addResult.stderr,
      });
    } else {
      succeeded++;
    }
  }

  // Step 4: Return summary
  return {
    total: items.length,
    succeeded,
    failed,
  };
}

export async function reloadProxy(): Promise<void> {
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

    // Step 4: Reload proxy routes
    console.log("Reloading proxy routes...");
    const result = await reloadRoutes(exec, state);

    // Step 5: Print summary
    console.log(
      `\nReload complete: ${result.succeeded}/${result.total} routes registered successfully.`
    );

    if (result.failed.length > 0) {
      console.error("\nFailed routes:");
      for (const f of result.failed) {
        console.error(`  - ${f.host} (stack: ${f.stackName}): ${f.error}`);
      }
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nReload failed: ${error.message}`);
    } else {
      console.error("\nReload failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
