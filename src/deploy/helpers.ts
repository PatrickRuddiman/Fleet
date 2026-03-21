import { ExecFn } from "../ssh";
import { FleetState, RouteState } from "../state";
import { FleetConfig, RouteConfig } from "../config";
import { getServiceNames } from "../compose";
import { resolveFleetRoot, PROXY_DIR } from "../fleet-root";
import { writeProxyCompose } from "../proxy";
import {
  buildBootstrapCommand,
  buildAddRouteCommand,
  buildRemoveRouteCommand,
  buildCaddyId,
} from "../caddy";
import { HostCollision, UploadFileOptions } from "./types";

/**
 * Compares incoming routes against all stacks in state, flagging conflicts
 * where a host is owned by a different stack.
 */
export function detectHostCollisions(
  routes: RouteConfig[],
  state: FleetState,
  currentStackName: string
): HostCollision[] {
  const collisions: HostCollision[] = [];

  for (const route of routes) {
    for (const [stackName, stackState] of Object.entries(state.stacks)) {
      if (stackName === currentStackName) continue;
      for (const existingRoute of stackState.routes) {
        if (existingRoute.host === route.domain) {
          collisions.push({
            host: route.domain,
            ownedByStack: stackName,
          });
        }
      }
    }
  }

  return collisions;
}

/**
 * Checks `caddy_bootstrapped`, and if false, resolves the fleet root,
 * ensures the `fleet-proxy` Docker network exists, writes the proxy compose file,
 * runs `docker compose up -d` in the proxy directory, and posts the bootstrap
 * config to Caddy.
 */
export async function bootstrapProxy(
  exec: ExecFn,
  state: FleetState,
  acmeEmail?: string
): Promise<{ fleetRoot: string; updatedState: FleetState }> {
  if (state.caddy_bootstrapped) {
    const fleetRoot = state.fleet_root;
    return { fleetRoot, updatedState: state };
  }

  console.log("  Resolving fleet root...");
  const fleetRoot = await resolveFleetRoot(exec);

  console.log("  Ensuring fleet-proxy Docker network exists...");
  await exec("docker network create fleet-proxy 2>/dev/null || true");

  console.log("  Writing proxy compose file...");
  await writeProxyCompose(fleetRoot, exec);

  const proxyDir = `${fleetRoot}/${PROXY_DIR}`;
  console.log("  Starting proxy containers...");
  const upResult = await exec(
    `docker compose -f ${proxyDir}/compose.yml up -d`
  );
  if (upResult.code !== 0) {
    throw new Error(`Failed to start proxy: ${upResult.stderr}`);
  }

  console.log("  Posting bootstrap config to Caddy...");
  const bootstrapCmd = buildBootstrapCommand(
    acmeEmail ? { acme_email: acmeEmail } : undefined
  );
  const bootstrapResult = await exec(bootstrapCmd);
  if (bootstrapResult.code !== 0) {
    throw new Error(`Failed to bootstrap Caddy: ${bootstrapResult.stderr}`);
  }

  const updatedState: FleetState = {
    ...state,
    fleet_root: fleetRoot,
    caddy_bootstrapped: true,
  };

  return { fleetRoot, updatedState };
}

/**
 * Writes content to a remote path using the atomic `.tmp` + `mv` pattern
 * with configurable permissions.
 */
export async function uploadFile(
  exec: ExecFn,
  options: UploadFileOptions
): Promise<void> {
  const { content, remotePath, permissions } = options;
  const tmpPath = `${remotePath}.tmp`;
  const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));

  let command = `mkdir -p ${dir} && cat << 'FLEET_EOF' > ${tmpPath}\n${content}\nFLEET_EOF\n&& mv ${tmpPath} ${remotePath}`;

  if (permissions) {
    command += ` && chmod ${permissions} ${remotePath}`;
  }

  const result = await exec(command);

  if (result.code !== 0) {
    const detail = result.stderr ? ` — ${result.stderr}` : "";
    throw new Error(
      `Failed to upload file to ${remotePath}: command exited with code ${result.code}${detail}`
    );
  }
}

/**
 * Handles `env.entries` (key-value pairs written directly) and `env.infisical`
 * (remote CLI export) cases, producing a `.env` file with `0600` permissions.
 */
export async function resolveSecrets(
  exec: ExecFn,
  config: FleetConfig,
  stackDir: string
): Promise<void> {
  if (config.env?.entries && config.env.entries.length > 0) {
    // Handle inline env key-value pairs — format as KEY=VALUE lines
    const lines = config.env.entries.map((e) => `${e.key}=${e.value}`);
    const envContent = lines.join("\n") + "\n";

    await uploadFile(exec, {
      content: envContent,
      remotePath: `${stackDir}/.env`,
      permissions: "0600",
    });
  } else if (config.env?.infisical) {
    // Handle Infisical CLI-based export on the remote server
    const { token, project_id, environment, path: secretPath } = config.env.infisical;

    const exportCmd = `infisical export --token=${token} --projectId=${project_id} --env=${environment} --path=${secretPath} --format=dotenv > ${stackDir}/.env`;
    const result = await exec(exportCmd);

    if (result.code !== 0) {
      throw new Error(
        `Failed to export secrets via Infisical CLI: ${result.stderr}`
      );
    }

    // Set file permissions to 0600
    const chmodResult = await exec(`chmod 0600 ${stackDir}/.env`);
    if (chmodResult.code !== 0) {
      throw new Error(
        `Failed to set .env file permissions: ${chmodResult.stderr}`
      );
    }
  } else {
    // No secrets to resolve
    return;
  }
}

/**
 * Connects containers to `fleet-proxy`, silently ignoring "already connected" errors.
 */
export async function attachNetworks(
  exec: ExecFn,
  stackName: string,
  serviceNames: string[]
): Promise<void> {
  for (const service of serviceNames) {
    const containerName = `${stackName}-${service}-1`;
    const result = await exec(
      `docker network connect fleet-proxy ${containerName}`
    );
    if (result.code !== 0) {
      // Silently ignore "already connected" errors
      if (
        result.stderr.includes("already exists") ||
        result.stderr.includes("already connected")
      ) {
        continue;
      }
      throw new Error(
        `Failed to connect ${containerName} to fleet-proxy: ${result.stderr}`
      );
    }
  }
}

/**
 * Polls an HTTP endpoint until 2xx or timeout, returning a warning on timeout
 * rather than failing.
 */
export async function checkHealth(
  exec: ExecFn,
  domain: string,
  healthCheck: { path: string; timeout_seconds: number; interval_seconds: number }
): Promise<string | null> {
  const url = `https://${domain}${healthCheck.path}`;
  const maxAttempts = Math.ceil(
    healthCheck.timeout_seconds / healthCheck.interval_seconds
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await exec(
      `curl -s -o /dev/null -w "%{http_code}" --insecure ${url}`
    );
    const statusCode = parseInt(result.stdout.trim(), 10);

    if (statusCode >= 200 && statusCode < 300) {
      return null; // healthy, no warning
    }

    if (attempt < maxAttempts) {
      await exec(`sleep ${healthCheck.interval_seconds}`);
    }
  }

  return `Health check timed out for ${domain}${healthCheck.path} after ${healthCheck.timeout_seconds}s`;
}

/**
 * Performs the delete-then-post pattern for each route using the Caddy command builders.
 */
export async function registerRoutes(
  exec: ExecFn,
  stackName: string,
  routes: RouteConfig[]
): Promise<RouteState[]> {
  const routeStates: RouteState[] = [];

  for (const route of routes) {
    const service = route.service || "default";
    const caddyId = buildCaddyId(stackName, service);

    // Delete existing route (ignore errors if it doesn't exist)
    const removeCmd = buildRemoveRouteCommand(caddyId);
    await exec(removeCmd);

    // Add the new route
    const addCmd = buildAddRouteCommand({
      stackName,
      serviceName: service,
      domain: route.domain,
      upstreamHost: `${stackName}-${service}-1`,
      upstreamPort: route.port,
      tls: route.tls,
      acme_email: route.acme_email,
    });

    const addResult = await exec(addCmd);
    if (addResult.code !== 0) {
      throw new Error(
        `Failed to register route for ${route.domain}: ${addResult.stderr}`
      );
    }

    routeStates.push({
      host: route.domain,
      service,
      port: route.port,
      caddy_id: caddyId,
    });
  }

  return routeStates;
}

/**
 * Runs `docker compose ps` and formats the output with route information
 * and any collected warnings.
 */
export async function printSummary(
  exec: ExecFn,
  stackName: string,
  stackDir: string,
  routes: RouteConfig[],
  warnings: string[]
): Promise<void> {
  console.log("\n--- Deploy Summary ---\n");

  // Run docker compose ps
  const psResult = await exec(
    `docker compose -p ${stackName} -f ${stackDir}/compose.yml ps`
  );
  if (psResult.code === 0 && psResult.stdout.trim()) {
    console.log("Services:");
    console.log(psResult.stdout);
  }

  // Print routes
  if (routes.length > 0) {
    console.log("Routes:");
    for (const route of routes) {
      const protocol = route.tls !== false ? "https" : "http";
      console.log(`  ${protocol}://${route.domain} → ${route.service || "default"}:${route.port}`);
    }
  }

  // Print warnings
  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of warnings) {
      console.log(`  ⚠ ${warning}`);
    }
  }

  console.log("\nDeploy complete.");
}
