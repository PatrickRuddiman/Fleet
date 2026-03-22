import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection } from "../ssh";
import { readState } from "../state";
import { CADDY_CONTAINER_NAME, buildGetConfigCommand, buildListRoutesCommand } from "../caddy";
import type { ExecFn } from "../ssh";
import type { FleetState } from "../state";
import type { LiveRoute, ContainerStatus, ReconciliationResult } from "./types";

/**
 * Parses the Caddy full config JSON response to extract the version string.
 * Looks for a top-level "version" key. Returns "unknown" if not found or on parse failure.
 */
export function parseCaddyVersion(configJson: string): string {
  try {
    const parsed = JSON.parse(configJson);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.version === "string") {
      return parsed.version;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Parses the Caddy routes JSON response to extract hostname-to-upstream mappings.
 * Each route is expected to have match[0].host[0] and handle[0].upstreams[0].dial.
 * Routes that don't match this structure are skipped.
 * Returns an array of LiveRoute sorted alphabetically by hostname.
 */
export function parseCaddyRoutes(routesJson: string): LiveRoute[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(routesJson);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const routes: LiveRoute[] = [];

  for (const route of parsed) {
    try {
      const hostname = route?.match?.[0]?.host?.[0];
      const upstream = route?.handle?.[0]?.upstreams?.[0]?.dial;

      if (typeof hostname === "string" && typeof upstream === "string") {
        routes.push({ hostname, upstream });
      }
    } catch {
      // Skip malformed routes
    }
  }

  routes.sort((a, b) => a.hostname.localeCompare(b.hostname));
  return routes;
}

/**
 * Collects all hostnames from a FleetState object by iterating across
 * all stacks' routes arrays.
 * Returns a sorted array of unique hostnames.
 */
export function collectStateHostnames(state: FleetState): string[] {
  const hostnames = new Set<string>();

  for (const stack of Object.values(state.stacks)) {
    for (const route of stack.routes) {
      hostnames.add(route.host);
    }
  }

  return Array.from(hostnames).sort();
}

/**
 * Reconciles two sets of hostnames: live (from Caddy) and expected (from state.json).
 * Returns ghost routes (in live but not in expected) and missing routes (in expected but not in live).
 */
export function reconcileRoutes(
  liveHostnames: string[],
  stateHostnames: string[]
): ReconciliationResult {
  const liveSet = new Set(liveHostnames);
  const stateSet = new Set(stateHostnames);

  const ghostRoutes = liveHostnames
    .filter((h) => !stateSet.has(h))
    .sort();

  const missingRoutes = stateHostnames
    .filter((h) => !liveSet.has(h))
    .sort();

  return { ghostRoutes, missingRoutes };
}

/**
 * Formats an array of LiveRoute objects into an aligned table string.
 * Columns: HOSTNAME, UPSTREAM
 * Returns the formatted string (without trailing newline).
 */
export function formatRoutesTable(routes: LiveRoute[]): string {
  const headers = ["HOSTNAME", "UPSTREAM"];

  const widths = headers.map((h) => h.length);
  for (const route of routes) {
    const values = [route.hostname, route.upstream];
    for (let i = 0; i < values.length; i++) {
      widths[i] = Math.max(widths[i], values[i].length);
    }
  }

  const formatRow = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i])).join("  ");

  const lines: string[] = [];
  lines.push(formatRow(headers));

  for (const route of routes) {
    lines.push(formatRow([route.hostname, route.upstream]));
  }

  return lines.join("\n");
}

/**
 * Formats the overall proxy status output including container status,
 * Caddy version, route table, and any reconciliation warnings.
 * If missing routes exist, includes a suggestion to run `fleet proxy reload`.
 */
export function formatStatusOutput(
  containerStatus: ContainerStatus,
  caddyVersion: string,
  routes: LiveRoute[],
  reconciliation: ReconciliationResult
): string {
  const lines: string[] = [];

  lines.push(`Proxy container: ${containerStatus.status}`);
  lines.push(`Caddy version: ${caddyVersion}`);

  lines.push("");

  if (routes.length === 0) {
    lines.push("No live routes.");
  } else {
    lines.push(formatRoutesTable(routes));
  }

  if (reconciliation.ghostRoutes.length > 0) {
    lines.push("");
    lines.push("Warning: Ghost routes (in Caddy but not in state.json):");
    for (const route of reconciliation.ghostRoutes) {
      lines.push(`  - ${route}`);
    }
  }

  if (reconciliation.missingRoutes.length > 0) {
    lines.push("");
    lines.push("Warning: Missing routes (in state.json but not in Caddy):");
    for (const route of reconciliation.missingRoutes) {
      lines.push(`  - ${route}`);
    }
    lines.push("");
    lines.push("Run `fleet proxy reload` to reconcile.");
  }

  return lines.join("\n");
}

/**
 * Main proxy-status orchestration function. Loads config, connects via SSH,
 * reads state, checks container status, queries Caddy API, performs
 * reconciliation, and prints formatted output.
 */
export async function proxyStatus(): Promise<void> {
  let connection: Connection | null = null;

  try {
    const configPath = path.resolve("fleet.yml");
    const config = loadFleetConfig(configPath);

    connection = await createConnection(config.server);
    const exec = connection.exec;

    const state = await readState(exec);

    // Check if fleet-caddy container is running
    const inspectResult = await exec(
      `docker inspect --format '{{.State.Status}}' ${CADDY_CONTAINER_NAME}`
    );

    const containerStatus: ContainerStatus =
      inspectResult.code === 0 && inspectResult.stdout.trim() === "running"
        ? { running: true, status: "running" }
        : { running: false, status: inspectResult.code === 0 ? inspectResult.stdout.trim() : "not found" };

    if (!containerStatus.running) {
      console.log(`Proxy container: ${containerStatus.status}`);
      return;
    }

    // Query Caddy API for full config and routes
    const configResult = await exec(buildGetConfigCommand());
    const routesResult = await exec(buildListRoutesCommand());

    const caddyVersion = configResult.code === 0
      ? parseCaddyVersion(configResult.stdout)
      : "unknown";

    const liveRoutes = routesResult.code === 0
      ? parseCaddyRoutes(routesResult.stdout)
      : [];

    // Reconcile live routes against state.json
    const liveHostnames = liveRoutes.map((r) => r.hostname);
    const stateHostnames = collectStateHostnames(state);
    const reconciliation = reconcileRoutes(liveHostnames, stateHostnames);

    // Format and print output
    const output = formatStatusOutput(containerStatus, caddyVersion, liveRoutes, reconciliation);
    console.log(output);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nProxy status failed: ${error.message}`);
    } else {
      console.error("\nProxy status failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
