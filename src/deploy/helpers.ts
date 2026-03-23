import fs from "fs";
import path from "path";
import { ExecFn } from "../ssh";
import { FleetState, RouteState } from "../state";
import { FleetConfig, RouteConfig } from "../config";
import { getServiceNames, ParsedComposeFile, alwaysRedeploy } from "../compose";
import { resolveFleetRoot, PROXY_DIR } from "../fleet-root";
import { writeProxyCompose } from "../proxy";
import {
  buildBootstrapCommand,
  buildAddRouteCommand,
  buildRemoveRouteCommand,
  buildCaddyId,
} from "../caddy";
import { HostCollision, UploadFileOptions } from "./types";
import type { ServiceClassification } from "./classify";
import type { StackState } from "../state/types";
import { getImageDigest } from "./hashes";

/**
 * Converts an ISO timestamp to a human-readable relative time string.
 * Examples: "just now", "2 minutes ago", "3 hours ago", "4 days ago".
 * Returns "in the future" for timestamps ahead of the current time.
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const then = Date.parse(isoTimestamp);
  if (isNaN(then)) {
    return "unknown";
  }

  const diffMs = Date.now() - then;

  if (diffMs < 0) {
    return "in the future";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

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

  const mkdirResult = await exec(`mkdir -p ${dir}`);
  if (mkdirResult.code !== 0) {
    const detail = mkdirResult.stderr ? ` — ${mkdirResult.stderr}` : "";
    throw new Error(`Failed to create directory ${dir}: command exited with code ${mkdirResult.code}${detail}`);
  }

  const writeResult = await exec(`cat << 'FLEET_EOF' > ${tmpPath}\n${content}\nFLEET_EOF`);
  if (writeResult.code !== 0) {
    const detail = writeResult.stderr ? ` — ${writeResult.stderr}` : "";
    throw new Error(`Failed to write temp file ${tmpPath}: command exited with code ${writeResult.code}${detail}`);
  }

  const mvResult = await exec(`mv ${tmpPath} ${remotePath}`);
  if (mvResult.code !== 0) {
    const detail = mvResult.stderr ? ` — ${mvResult.stderr}` : "";
    throw new Error(`Failed to upload file to ${remotePath}: command exited with code ${mvResult.code}${detail}`);
  }

  if (permissions) {
    const chmodResult = await exec(`chmod ${permissions} ${remotePath}`);
    if (chmodResult.code !== 0) {
      const detail = chmodResult.stderr ? ` — ${chmodResult.stderr}` : "";
      throw new Error(`Failed to set permissions on ${remotePath}: command exited with code ${chmodResult.code}${detail}`);
    }
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
 * Handles `env` entries (key-value pairs), `env.file` (local file upload),
 * `env.infisical` (remote CLI export), producing a `.env` file with `0600` permissions.
 */
export async function resolveSecrets(
  exec: ExecFn,
  config: FleetConfig,
  stackDir: string,
  configDir?: string
): Promise<void> {
  if (!config.env) {
    return;
  }

  // Handle env.file — read local file and upload via base64
  if ("file" in config.env) {
    if (!configDir) {
      throw new Error(
        "configDir is required when using env.file"
      );
    }
    const envFilePath = path.resolve(configDir, config.env.file);
    if (!envFilePath.startsWith(configDir + path.sep) && envFilePath !== configDir) {
      throw new Error(
        `env.file path "${config.env.file}" resolves outside the project directory — path traversal is not allowed`
      );
    }
    if (!fs.existsSync(envFilePath)) {
      throw new Error(
        `env.file not found: ${config.env.file} (resolved to ${envFilePath})`
      );
    }
    const envContent = fs.readFileSync(envFilePath, "utf-8");

    await uploadFileBase64(exec, {
      content: envContent,
      remotePath: `${stackDir}/.env`,
      permissions: "0600",
    });

    console.log(`  Uploaded env file (${Buffer.byteLength(envContent)} bytes)`);
    return;
  }

  // Handle env as array of key-value pairs
  if (Array.isArray(config.env)) {
    if (config.env.length === 0) {
      return;
    }
    const lines = config.env.map((e) => `${e.key}=${e.value}`);
    const envContent = lines.join("\n") + "\n";

    await uploadFile(exec, {
      content: envContent,
      remotePath: `${stackDir}/.env`,
      permissions: "0600",
    });
    return;
  }

  // Handle env as object with entries and/or infisical
  if (config.env.entries && config.env.entries.length > 0) {
    const lines = config.env.entries.map((e) => `${e.key}=${e.value}`);
    const envContent = lines.join("\n") + "\n";

    await uploadFile(exec, {
      content: envContent,
      remotePath: `${stackDir}/.env`,
      permissions: "0600",
    });
  }

  if (config.env.infisical) {
    const { token, project_id, environment, path: secretPath } = config.env.infisical;

    // Pass the token via environment variable to avoid exposing it in the process list (ps aux)
    const exportCmd = `INFISICAL_TOKEN=${token} infisical export --projectId=${project_id} --env=${environment} --path=${secretPath} --format=dotenv > ${stackDir}/.env`;
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
 * Polls a container's health endpoint directly via Docker exec until 2xx or
 * timeout, returning a warning on timeout rather than failing.
 */
export async function checkHealth(
  exec: ExecFn,
  stackName: string,
  serviceName: string,
  port: number,
  healthCheck: { path: string; timeout_seconds: number; interval_seconds: number }
): Promise<string | null> {
  const containerName = `${stackName}-${serviceName}-1`;
  const maxAttempts = Math.ceil(
    healthCheck.timeout_seconds / healthCheck.interval_seconds
  );
  let lastStatus = "no response";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await exec(
      `docker exec ${containerName} curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}${healthCheck.path}`
    );

    if (result.code !== 0) {
      lastStatus = result.stderr.trim() || `exit code ${result.code}`;
    } else {
      const statusCode = parseInt(result.stdout.trim(), 10);
      lastStatus = `HTTP ${statusCode}`;

      if (statusCode >= 200 && statusCode < 300) {
        return null; // healthy, no warning
      }
    }

    if (attempt < maxAttempts) {
      await exec(`sleep ${healthCheck.interval_seconds}`);
    }
  }

  return `Health check timed out for ${containerName}${healthCheck.path} after ${healthCheck.timeout_seconds}s (last status: ${lastStatus})`;
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
  if (!config.env) return false;

  // env is { file: string }
  if ("file" in config.env) return true;

  // env is array of { key, value }
  if (Array.isArray(config.env)) return config.env.length > 0;

  // env is { entries?, infisical? }
  return (
    (config.env.entries !== undefined && config.env.entries.length > 0) ||
    config.env.infisical !== undefined
  );
}

/**
 * Formats and prints the deploy summary with per-service classification details,
 * route information, warnings, and elapsed time.
 *
 * Supports three output modes:
 * - Selective mode: per-service reason and outcome lines
 * - Force mode: banner and `(forced)` tags on all services
 * - Nothing-changed mode: all non-one-shot services show `no changes → skipped`
 */
export function printSummary(
  classification: ServiceClassification,
  compose: ParsedComposeFile,
  reasons: Record<string, string>,
  force: boolean,
  existingStackState: StackState | undefined,
  elapsedSeconds: number,
  routes: RouteConfig[],
  warnings: string[],
): void {
  console.log("\n--- Deploy Summary ---\n");

  // Force mode banner
  if (force) {
    console.log("⚠ Force mode — all services will be redeployed\n");
  }

  // Build per-service status lines
  const toDeploySet = new Set(classification.toDeploy);
  const toRestartSet = new Set(classification.toRestart);

  // Determine if this is "nothing changed" mode:
  // all non-one-shot services are in toSkip (and nothing in toDeploy except one-shots, nothing in toRestart)
  const nonOneShotInToDeploy = classification.toDeploy.filter(
    (name) => !alwaysRedeploy(compose.services[name])
  );
  const nothingChanged = nonOneShotInToDeploy.length === 0 && classification.toRestart.length === 0;

  // Build rows: [serviceName, detail]
  type StatusRow = { name: string; detail: string };
  const rows: StatusRow[] = [];
  const allServiceNames = Object.keys(compose.services);

  for (const name of allServiceNames) {
    const service = compose.services[name];
    const oneShot = alwaysRedeploy(service);
    const reason = reasons[name] ?? "no changes";

    if (force) {
      // Force mode: all services show "(forced)" tags
      if (oneShot) {
        rows.push({ name, detail: "run (forced)" });
      } else {
        rows.push({ name, detail: "deployed (forced)" });
      }
    } else if (toDeploySet.has(name)) {
      if (oneShot) {
        rows.push({ name, detail: `${reason} → run` });
      } else {
        rows.push({ name, detail: `${reason} → deployed` });
      }
    } else if (toRestartSet.has(name)) {
      rows.push({ name, detail: `${reason} → restarted` });
    } else {
      // Skipped
      const lastDeployed = existingStackState?.services?.[name]?.deployed_at;
      const timeAgo = lastDeployed ? ` (last deployed ${formatRelativeTime(lastDeployed)})` : "";
      if (nothingChanged && !oneShot) {
        rows.push({ name, detail: `no changes → skipped${timeAgo}` });
      } else {
        rows.push({ name, detail: `${reason} → skipped${timeAgo}` });
      }
    }
  }

  // Compute padEnd width (max service name length)
  const maxNameWidth = Math.max(...rows.map((r) => r.name.length));

  // Print service lines
  if (rows.length > 0) {
    console.log("Services:");
    for (const row of rows) {
      console.log(`  ${row.name.padEnd(maxNameWidth)}  ${row.detail}`);
    }
  }

  // Summary counts line
  const deployedCount = classification.toDeploy.filter(
    (n) => !alwaysRedeploy(compose.services[n])
  ).length;
  const restartedCount = classification.toRestart.length;
  const oneShotCount = classification.toDeploy.filter(
    (n) => alwaysRedeploy(compose.services[n])
  ).length;
  const skippedCount = classification.toSkip.length;

  const parts: string[] = [];
  if (deployedCount > 0) parts.push(`${deployedCount} deployed`);
  if (restartedCount > 0) parts.push(`${restartedCount} restarted`);
  if (oneShotCount > 0) parts.push(`${oneShotCount} run (one-shot)`);
  if (skippedCount > 0) parts.push(`${skippedCount} skipped`);

  if (parts.length > 0) {
    console.log(`\n${parts.join(", ")}`);
  }

  // Print routes
  if (routes.length > 0) {
    console.log("\nRoutes:");
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

  // Deploy elapsed time
  console.log(`\nDeploy complete in ${elapsedSeconds}s`);
}

/**
 * Determines whether a Docker image reference uses a "floating" tag —
 * one that may resolve to different content over time.
 *
 * Returns `true` if the image has no tag (defaults to `latest`),
 * an explicit `:latest` tag, or a digest-based `@sha256:` reference.
 */
export function hasFloatingTag(image: string | undefined): boolean {
  if (!image) {
    return true;
  }

  if (image.includes("@sha256:")) {
    return true;
  }

  // Strip any @digest suffix (e.g. image@sha256:... already handled above,
  // but guard against other @ references)
  const ref = image.split("@")[0];

  // Find the portion after the last '/' to avoid confusing
  // a registry port (e.g. registry:5000/app) with a tag.
  const lastSlash = ref.lastIndexOf("/");
  const afterSlash = lastSlash >= 0 ? ref.substring(lastSlash + 1) : ref;

  const colonIndex = afterSlash.lastIndexOf(":");
  if (colonIndex < 0) {
    // No tag specified — Docker defaults to latest
    return true;
  }

  const tag = afterSlash.substring(colonIndex + 1);
  return tag === "latest";
}

/**
 * Pulls Docker images selectively based on deployment needs.
 *
 * In force mode, pulls all images at once. Otherwise, iterates services
 * and pulls those in the toDeploy list, one-shots, or floating-tag
 * services while skipping and logging others.
 */
export async function pullSelectiveImages(
  exec: ExecFn,
  compose: ParsedComposeFile,
  stackName: string,
  stackDir: string,
  toDeploy: string[],
  force: boolean
): Promise<string[]> {
  const composePath = `${stackDir}/compose.yml`;
  const toDeploySet = new Set(toDeploy);

  // Force mode: pull all images at once
  if (force) {
    const result = await exec(
      `docker compose -p ${stackName} -f ${composePath} pull`
    );
    if (result.code !== 0) {
      throw new Error(`Failed to pull images: ${result.stderr}`);
    }
    return Object.keys(compose.services);
  }

  // Selective mode: iterate services
  const pulled: string[] = [];

  for (const [serviceName, service] of Object.entries(compose.services)) {
    const oneShot = alwaysRedeploy(service);
    const floating = hasFloatingTag(service.image);
    const inToDeploy = toDeploySet.has(serviceName);

    if (inToDeploy || oneShot || floating) {
      const result = await exec(
        `docker compose -p ${stackName} -f ${composePath} pull ${serviceName}`
      );
      if (result.code !== 0) {
        throw new Error(
          `Failed to pull image for service ${serviceName}: ${result.stderr}`
        );
      }

      // For floating-tag services, retrieve the post-pull digest
      if (floating && service.image) {
        await getImageDigest(exec, service.image);
      }

      pulled.push(serviceName);
    } else {
      console.log(`  ⊘ ${serviceName} — skipped pull (no changes detected)`);
    }
  }

  return pulled;
}
