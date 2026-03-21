import fs from "fs";
import path from "path";
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
 * Writes content to a remote path using base64 encoding over SSH exec.
 * Uses the atomic `.tmp` + `mv` pattern. This avoids heredoc delimiter
 * and shell metacharacter issues with arbitrary file content.
 */
export async function uploadFileBase64(
  exec: ExecFn,
  options: UploadFileOptions
): Promise<void> {
  const { content, remotePath, permissions } = options;
  const tmpPath = `${remotePath}.tmp`;
  const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
  const encoded = Buffer.from(content).toString("base64");

  let command = `mkdir -p ${dir} && echo '${encoded}' | base64 -d > ${tmpPath} && mv ${tmpPath} ${remotePath}`;

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
 * Handles `env` (key-value pairs) and `infisical` (API call) cases
 * and uploads the result as a `.env` file with `0600` permissions.
 */
export async function resolveSecrets(
  exec: ExecFn,
  config: FleetConfig,
  stackDir: string,
  configDir?: string
): Promise<void> {
  let envContent = "";

  if (config.env && "file" in config.env) {
    // Handle env.file — read local file and upload via base64
    if (!configDir) {
      throw new Error(
        "configDir is required when using env.file"
      );
    }
    const envFilePath = path.resolve(configDir, config.env.file);
    if (!fs.existsSync(envFilePath)) {
      throw new Error(
        `env.file not found: ${config.env.file} (resolved to ${envFilePath})`
      );
    }
    envContent = fs.readFileSync(envFilePath, "utf-8");

    await uploadFileBase64(exec, {
      content: envContent,
      remotePath: `${stackDir}/.env`,
      permissions: "0600",
    });

    console.log(`  Uploaded env file (${Buffer.byteLength(envContent)} bytes)`);
    return;
  } else if (config.env && Array.isArray(config.env) && config.env.length > 0) {
    // Handle env key-value pairs — format as KEY=VALUE lines
    const lines = config.env.map((e) => `${e.key}=${e.value}`);
    envContent = lines.join("\n") + "\n";
  } else if (config.infisical) {
    // Handle Infisical API call
    const { project_id, environment } = config.infisical;
    const token = process.env.INFISICAL_TOKEN;
    if (!token) {
      throw new Error(
        "INFISICAL_TOKEN environment variable is required when using infisical secrets"
      );
    }

    const url = `https://app.infisical.com/api/v3/secrets/raw?workspaceId=${project_id}&environment=${environment}`;
    const result = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!result.ok) {
      throw new Error(
        `Failed to fetch secrets from Infisical: ${result.status} ${result.statusText}`
      );
    }

    const data = (await result.json()) as {
      secrets: Array<{ secretKey: string; secretValue: string }>;
    };

    const lines = data.secrets.map(
      (s) => `${s.secretKey}=${s.secretValue}`
    );
    envContent = lines.join("\n") + "\n";
  } else {
    // No secrets to resolve
    return;
  }

  await uploadFile(exec, {
    content: envContent,
    remotePath: `${stackDir}/.env`,
    permissions: "0600",
  });
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
 * Determines whether the config has any secrets source that requires
 * the `--env-file` flag on `docker compose up`.
 */
export function configHasSecrets(config: FleetConfig): boolean {
  return (
    (config.env !== undefined &&
      ("file" in config.env ||
        (Array.isArray(config.env) && config.env.length > 0))) ||
    config.infisical !== undefined
  );
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
