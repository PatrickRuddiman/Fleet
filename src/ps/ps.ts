import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection } from "../ssh";
import { readState, getStack } from "../state";
import type { ExecFn } from "../ssh";
import type { FleetState, StackState, RouteState } from "../state";
import type { ServiceStatus, StackRow } from "./types";

/**
 * Parses the JSON output from `docker compose ps --format json`.
 * Docker Compose outputs one JSON object per line.
 * Each object has at least "Service" and "State" fields.
 * Returns an array of ServiceStatus sorted alphabetically by service name.
 */
export function parseDockerComposePs(output: string): ServiceStatus[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  const results: ServiceStatus[] = [];
  const lines = trimmed.split("\n");

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) continue;
    try {
      const parsed = JSON.parse(stripped);
      results.push({
        service: parsed.Service ?? parsed.Name ?? "unknown",
        status: parsed.State ?? "unknown",
      });
    } catch {
      // Skip lines that aren't valid JSON
    }
  }

  results.sort((a, b) => a.service.localeCompare(b.service));
  return results;
}

/**
 * Formats an array of StackRow objects into an aligned table string.
 * Columns: STACK, SERVICE, STATUS, ROUTES, DEPLOYED AT
 * Returns the formatted string (without trailing newline).
 */
export function formatTable(rows: StackRow[]): string {
  const headers = ["STACK", "SERVICE", "STATUS", "ROUTES", "DEPLOYED AT"];

  // Calculate column widths
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    const values = [row.stack, row.service, row.status, row.routes, row.deployedAt];
    for (let i = 0; i < values.length; i++) {
      widths[i] = Math.max(widths[i], values[i].length);
    }
  }

  const formatRow = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i])).join("  ");

  const lines: string[] = [];
  lines.push(formatRow(headers));

  for (const row of rows) {
    lines.push(formatRow([row.stack, row.service, row.status, row.routes, row.deployedAt]));
  }

  return lines.join("\n");
}

/**
 * Main ps function. Loads config, connects via SSH, reads state,
 * queries Docker for container status, and prints a formatted table.
 */
export async function ps(stackName?: string): Promise<void> {
  let connection: Connection | null = null;

  try {
    const configPath = path.resolve("fleet.yml");
    const config = loadFleetConfig(configPath);

    connection = await createConnection(config.server);
    const exec = connection.exec;

    const state = await readState(exec);

    // Determine which stacks to show
    let stackEntries: [string, StackState][];

    if (stackName) {
      const stack = getStack(state, stackName);
      if (!stack) {
        throw new Error(
          `Stack "${stackName}" not found in server state. Available stacks: ${
            Object.keys(state.stacks).join(", ") || "none"
          }`
        );
      }
      stackEntries = [[stackName, stack]];
    } else {
      stackEntries = Object.entries(state.stacks);
      if (stackEntries.length === 0) {
        console.log("No stacks are currently deployed.");
        return;
      }
    }

    // Build rows for each stack
    const rows: StackRow[] = [];

    for (const [name, stackState] of stackEntries) {
      // Run docker compose ps for this stack
      let services: ServiceStatus[];
      const result = await exec(`docker compose -p ${name} ps --format json`);

      if (result.code !== 0) {
        // On failure, show "unknown" status for services known from routes
        const routeServices = new Set(stackState.routes.map((r) => r.service));
        services = Array.from(routeServices)
          .sort()
          .map((s) => ({ service: s, status: "unknown" }));

        // If no route services are known either, add a single unknown entry
        if (services.length === 0) {
          services = [{ service: "(unknown)", status: "unknown" }];
        }
      } else {
        services = parseDockerComposePs(result.stdout);
      }

      // Build route lookup: service name -> formatted route strings
      const routeMap = new Map<string, string[]>();
      for (const route of stackState.routes) {
        const key = route.service;
        const formatted = `${route.host} -> ${route.service}:${route.port}`;
        if (!routeMap.has(key)) {
          routeMap.set(key, []);
        }
        routeMap.get(key)!.push(formatted);
      }

      // Create rows for each service
      let isFirstRow = true;
      for (const svc of services) {
        const routeStrings = routeMap.get(svc.service) ?? [];
        rows.push({
          stack: isFirstRow ? name : "",
          service: svc.service,
          status: svc.status,
          routes: routeStrings.join(", "),
          deployedAt: isFirstRow ? stackState.deployed_at : "",
        });
        isFirstRow = false;
      }
    }

    // Format and print the table
    console.log(formatTable(rows));
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nPs failed: ${error.message}`);
    } else {
      console.error("\nPs failed with an unknown error.");
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
