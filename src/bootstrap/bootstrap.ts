import { ExecFn } from "../ssh";
import { readState, writeState, FleetState } from "../state";
import { resolveFleetRoot } from "../fleet-root";
import { PROXY_DIR } from "../fleet-root";
import { writeProxyCompose } from "../proxy";
import {
  buildBootstrapCommand,
  CADDY_CONTAINER_NAME,
  CADDY_API_CONFIG_PATH,
  CADDY_ADMIN_URL,
} from "../caddy";
import { BootstrapOptions } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function bootstrap(
  exec: ExecFn,
  options: BootstrapOptions
): Promise<void> {
  // Step 1 — Read state and check early return
  const state = await readState(exec);

  if (state.caddy_bootstrapped) {
    return;
  }

  // Resolve fleet root if not already set
  let fleetRoot = state.fleet_root;
  if (!fleetRoot) {
    fleetRoot = await resolveFleetRoot(exec);
  }

  const initialState: FleetState = {
    ...state,
    fleet_root: fleetRoot,
    caddy_bootstrapped: false,
  };
  await writeState(exec, initialState);

  // Step 2 — Create Docker network (idempotent)
  await exec("docker network create fleet-proxy || true");

  // Step 3 — Create proxy directory
  const mkdirResult = await exec(`mkdir -p ${fleetRoot}/${PROXY_DIR}`);
  if (mkdirResult.code !== 0) {
    throw new Error(
      `Failed to create proxy directory: command exited with code ${mkdirResult.code}${mkdirResult.stderr ? ` — ${mkdirResult.stderr}` : ""}`
    );
  }

  // Step 4 — Write proxy compose file
  await writeProxyCompose(fleetRoot, exec);

  // Step 5 — Start Caddy container
  const composeFile = `${fleetRoot}/${PROXY_DIR}/compose.yml`;
  const upResult = await exec(
    `docker compose -f ${composeFile} -p fleet-proxy up -d`
  );
  if (upResult.code !== 0) {
    throw new Error(
      `Failed to start Caddy container: command exited with code ${upResult.code}${upResult.stderr ? ` — ${upResult.stderr}` : ""}`
    );
  }

  // Step 6 — Wait for Caddy Admin API with retries
  const maxAttempts = 10;
  const retryIntervalMs = 3000;
  let healthy = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = await exec(
      `docker exec ${CADDY_CONTAINER_NAME} curl -s -f ${CADDY_ADMIN_URL}${CADDY_API_CONFIG_PATH}`
    );
    if (probe.code === 0) {
      healthy = true;
      break;
    }
    if (attempt < maxAttempts) {
      await sleep(retryIntervalMs);
    }
  }

  if (!healthy) {
    throw new Error(
      `Caddy Admin API did not become healthy after ${maxAttempts} attempts (${(maxAttempts * retryIntervalMs) / 1000}s timeout)`
    );
  }

  // Step 7 — Post initial Caddy configuration
  const bootstrapCommand = buildBootstrapCommand({
    acme_email: options.acme_email,
  });
  const configResult = await exec(bootstrapCommand);
  if (configResult.code !== 0) {
    throw new Error(
      `Failed to post initial Caddy configuration: command exited with code ${configResult.code}${configResult.stderr ? ` — ${configResult.stderr}` : ""}`
    );
  }

  // Step 8 — Mark bootstrap complete
  const finalState: FleetState = {
    ...initialState,
    caddy_bootstrapped: true,
  };
  await writeState(exec, finalState);
}
