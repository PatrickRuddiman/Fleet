import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FleetState } from "../src/state/types";

// --- Mutable mock state (hoisted so vi.mock factories can access them) ---
const {
  mockStateRef,
  mockExecCommandsRef,
  mockExecHandlersRef,
  mockCloseCalledCountRef,
  mockConsoleLogRef,
  mockProcessExitCodeRef,
} = vi.hoisted(() => {
  return {
    mockStateRef: { value: null as unknown as FleetState },
    mockExecCommandsRef: { value: [] as string[] },
    mockExecHandlersRef: {
      value: {} as Record<string, { stdout: string; stderr: string; code: number }>,
    },
    mockCloseCalledCountRef: { value: 0 },
    mockConsoleLogRef: { value: [] as string[] },
    mockProcessExitCodeRef: { value: undefined as number | undefined },
  };
});

// --- Module-level mocks (hoisted by vitest) ---

vi.mock("../src/config", () => ({
  loadFleetConfig: () => ({
    version: "1",
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  }),
}));

vi.mock("../src/ssh", () => ({
  createConnection: async () => ({
    exec: async (cmd: string) => {
      mockExecCommandsRef.value.push(cmd);
      for (const [pattern, result] of Object.entries(
        mockExecHandlersRef.value
      )) {
        if (cmd.includes(pattern)) {
          return result;
        }
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    streamExec: async () => ({ stdout: "", stderr: "", code: 0 }),
    close: async () => {
      mockCloseCalledCountRef.value++;
    },
  }),
}));

vi.mock("../src/state", () => ({
  readState: async () => mockStateRef.value,
}));

// Import AFTER mock declarations
import {
  parseCaddyRoutes,
  collectStateHostnames,
  reconcileRoutes,
  formatStatusOutput,
  formatRoutesTable,
  parseCaddyVersion,
  proxyStatus,
} from "../src/proxy-status";
import type { LiveRoute, ContainerStatus, ReconciliationResult } from "../src/proxy-status";

// --- beforeEach reset ---

beforeEach(() => {
  mockExecCommandsRef.value = [];
  mockExecHandlersRef.value = {};
  mockCloseCalledCountRef.value = 0;
  mockConsoleLogRef.value = [];
  mockProcessExitCodeRef.value = undefined;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    mockConsoleLogRef.value.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(
    (code?: string | number | null | undefined) => {
      mockProcessExitCodeRef.value =
        typeof code === "number" ? code : undefined;
      return undefined as never;
    }
  );
});

// --- Helper functions for creating test FleetState objects ---

function emptyState(): FleetState {
  return {
    fleet_root: "/tmp/fleet",
    caddy_bootstrapped: true,
    stacks: {},
  };
}

function singleStackState(): FleetState {
  return {
    fleet_root: "/tmp/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/tmp/fleet/myapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-01T00:00:00Z",
        routes: [
          {
            host: "myapp.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
        ],
      },
    },
  };
}

function singleStackMultiRouteState(): FleetState {
  return {
    fleet_root: "/tmp/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/tmp/fleet/myapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-01T00:00:00Z",
        routes: [
          {
            host: "myapp.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
          {
            host: "api.example.com",
            service: "api",
            port: 8080,
            caddy_id: "myapp__api",
          },
        ],
      },
    },
  };
}

function multiStackState(): FleetState {
  return {
    fleet_root: "/tmp/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/tmp/fleet/myapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-01T00:00:00Z",
        routes: [
          {
            host: "myapp.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
        ],
      },
      otherapp: {
        path: "/tmp/fleet/otherapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-02T00:00:00Z",
        routes: [
          {
            host: "otherapp.example.com",
            service: "web",
            port: 4000,
            caddy_id: "otherapp__web",
          },
        ],
      },
    },
  };
}

function multiStackMultiRouteState(): FleetState {
  return {
    fleet_root: "/tmp/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/tmp/fleet/myapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-01T00:00:00Z",
        routes: [
          {
            host: "myapp.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
          {
            host: "api.example.com",
            service: "api",
            port: 8080,
            caddy_id: "myapp__api",
          },
        ],
      },
      otherapp: {
        path: "/tmp/fleet/otherapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-02T00:00:00Z",
        routes: [
          {
            host: "otherapp.example.com",
            service: "web",
            port: 4000,
            caddy_id: "otherapp__web",
          },
        ],
      },
    },
  };
}

function duplicateHostnameState(): FleetState {
  return {
    fleet_root: "/tmp/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/tmp/fleet/myapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-01T00:00:00Z",
        routes: [
          {
            host: "shared.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
        ],
      },
      otherapp: {
        path: "/tmp/fleet/otherapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-02T00:00:00Z",
        routes: [
          {
            host: "shared.example.com",
            service: "web",
            port: 4000,
            caddy_id: "otherapp__web",
          },
        ],
      },
    },
  };
}

// --- Helper for building Caddy route JSON ---

function buildCaddyRoute(id: string, hostname: string, upstream: string): object {
  return {
    "@id": id,
    match: [{ host: [hostname] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
  };
}

// --- Tests ---

describe("parseCaddyVersion", () => {
  it("should parse version from valid config JSON", () => {
    const json = JSON.stringify({ version: "v2.7.6" });
    expect(parseCaddyVersion(json)).toBe("v2.7.6");
  });

  it("should return 'unknown' when version key is missing", () => {
    const json = JSON.stringify({ apps: {} });
    expect(parseCaddyVersion(json)).toBe("unknown");
  });

  it("should return 'unknown' for malformed JSON", () => {
    expect(parseCaddyVersion("not json")).toBe("unknown");
  });

  it("should return 'unknown' for null input", () => {
    expect(parseCaddyVersion("null")).toBe("unknown");
  });

  it("should return 'unknown' when version is not a string", () => {
    const json = JSON.stringify({ version: 123 });
    expect(parseCaddyVersion(json)).toBe("unknown");
  });
});

describe("parseCaddyRoutes", () => {
  it("should parse a single route", () => {
    const json = JSON.stringify([
      buildCaddyRoute("myapp__web", "myapp.example.com", "myapp-web:3000"),
    ]);
    const result = parseCaddyRoutes(json);
    expect(result).toEqual([
      { hostname: "myapp.example.com", upstream: "myapp-web:3000" },
    ]);
  });

  it("should parse multiple routes", () => {
    const json = JSON.stringify([
      buildCaddyRoute("myapp__web", "myapp.example.com", "myapp-web:3000"),
      buildCaddyRoute("otherapp__web", "otherapp.example.com", "otherapp-web:4000"),
    ]);
    const result = parseCaddyRoutes(json);
    expect(result).toEqual([
      { hostname: "myapp.example.com", upstream: "myapp-web:3000" },
      { hostname: "otherapp.example.com", upstream: "otherapp-web:4000" },
    ]);
  });

  it("should return empty array for empty routes array", () => {
    const result = parseCaddyRoutes("[]");
    expect(result).toEqual([]);
  });

  it("should return empty array for null response", () => {
    const result = parseCaddyRoutes("null");
    expect(result).toEqual([]);
  });

  it("should return empty array for malformed JSON", () => {
    const result = parseCaddyRoutes("not json at all");
    expect(result).toEqual([]);
  });

  it("should handle route with missing match field", () => {
    const json = JSON.stringify([
      {
        "@id": "broken",
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "x:80" }] }],
      },
    ]);
    const result = parseCaddyRoutes(json);
    expect(result).toEqual([]);
  });

  it("should handle route with missing handle field", () => {
    const json = JSON.stringify([
      {
        "@id": "broken",
        match: [{ host: ["myapp.example.com"] }],
      },
    ]);
    const result = parseCaddyRoutes(json);
    expect(result).toEqual([]);
  });

  it("should handle route with empty host array", () => {
    const json = JSON.stringify([
      {
        "@id": "broken",
        match: [{ host: [] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "x:80" }] }],
      },
    ]);
    const result = parseCaddyRoutes(json);
    expect(result).toEqual([]);
  });

  it("should handle route with empty upstreams array", () => {
    const json = JSON.stringify([
      {
        "@id": "broken",
        match: [{ host: ["myapp.example.com"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [] }],
      },
    ]);
    const result = parseCaddyRoutes(json);
    expect(result).toEqual([]);
  });

  it("should sort routes alphabetically by hostname", () => {
    const json = JSON.stringify([
      buildCaddyRoute("z__web", "z.example.com", "z-web:3000"),
      buildCaddyRoute("a__web", "a.example.com", "a-web:3000"),
    ]);
    const result = parseCaddyRoutes(json);
    expect(result[0].hostname).toBe("a.example.com");
    expect(result[1].hostname).toBe("z.example.com");
  });
});

describe("collectStateHostnames", () => {
  it("should return empty array for empty stacks", () => {
    const result = collectStateHostnames(emptyState());
    expect(result).toEqual([]);
  });

  it("should collect hostname from single stack with single route", () => {
    const result = collectStateHostnames(singleStackState());
    expect(result).toHaveLength(1);
    expect(result).toContain("myapp.example.com");
  });

  it("should collect hostnames from single stack with multiple routes", () => {
    const result = collectStateHostnames(singleStackMultiRouteState());
    expect(result).toHaveLength(2);
    expect(result).toContain("myapp.example.com");
    expect(result).toContain("api.example.com");
  });

  it("should collect hostnames from multiple stacks", () => {
    const result = collectStateHostnames(multiStackState());
    expect(result).toHaveLength(2);
    expect(result).toContain("myapp.example.com");
    expect(result).toContain("otherapp.example.com");
  });

  it("should collect hostnames from multiple stacks with multiple routes", () => {
    const result = collectStateHostnames(multiStackMultiRouteState());
    expect(result).toHaveLength(3);
    expect(result).toContain("myapp.example.com");
    expect(result).toContain("api.example.com");
    expect(result).toContain("otherapp.example.com");
  });

  it("should deduplicate hostnames across stacks", () => {
    const result = collectStateHostnames(duplicateHostnameState());
    expect(result).toHaveLength(1);
    expect(result).toContain("shared.example.com");
  });

  it("should return sorted hostnames", () => {
    const result = collectStateHostnames(multiStackMultiRouteState());
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });
});

describe("reconcileRoutes", () => {
  it("should return empty arrays when sets match", () => {
    const caddy = ["a.com", "b.com"];
    const state = ["a.com", "b.com"];
    const result = reconcileRoutes(caddy, state);
    expect(result).toEqual({ ghostRoutes: [], missingRoutes: [] });
  });

  it("should detect ghost routes (in Caddy but not in state)", () => {
    const caddy = ["a.com", "b.com"];
    const state = ["a.com"];
    const result = reconcileRoutes(caddy, state);
    expect(result).toEqual({ ghostRoutes: ["b.com"], missingRoutes: [] });
  });

  it("should detect missing routes (in state but not in Caddy)", () => {
    const caddy = ["a.com"];
    const state = ["a.com", "b.com"];
    const result = reconcileRoutes(caddy, state);
    expect(result).toEqual({ ghostRoutes: [], missingRoutes: ["b.com"] });
  });

  it("should detect both ghost and missing routes", () => {
    const caddy = ["a.com", "ghost.com"];
    const state = ["a.com", "missing.com"];
    const result = reconcileRoutes(caddy, state);
    expect(result).toEqual({
      ghostRoutes: ["ghost.com"],
      missingRoutes: ["missing.com"],
    });
  });

  it("should handle both sets empty", () => {
    const result = reconcileRoutes([], []);
    expect(result).toEqual({ ghostRoutes: [], missingRoutes: [] });
  });

  it("should handle Caddy empty and state non-empty", () => {
    const result = reconcileRoutes([], ["a.com"]);
    expect(result).toEqual({ ghostRoutes: [], missingRoutes: ["a.com"] });
  });

  it("should handle Caddy non-empty and state empty", () => {
    const result = reconcileRoutes(["a.com"], []);
    expect(result).toEqual({ ghostRoutes: ["a.com"], missingRoutes: [] });
  });

  it("should sort ghost routes alphabetically", () => {
    const caddy = ["z.com", "a.com"];
    const state: string[] = [];
    const result = reconcileRoutes(caddy, state);
    expect(result.ghostRoutes).toEqual(["a.com", "z.com"]);
  });

  it("should sort missing routes alphabetically", () => {
    const caddy: string[] = [];
    const state = ["z.com", "a.com"];
    const result = reconcileRoutes(caddy, state);
    expect(result.missingRoutes).toEqual(["a.com", "z.com"]);
  });
});

describe("formatRoutesTable", () => {
  it("should format a single route into a table", () => {
    const routes: LiveRoute[] = [
      { hostname: "myapp.example.com", upstream: "myapp-web:3000" },
    ];
    const output = formatRoutesTable(routes);
    expect(output).toContain("HOSTNAME");
    expect(output).toContain("UPSTREAM");
    expect(output).toContain("myapp.example.com");
    expect(output).toContain("myapp-web:3000");
  });

  it("should format multiple routes into aligned columns", () => {
    const routes: LiveRoute[] = [
      { hostname: "myapp.example.com", upstream: "myapp-web:3000" },
      { hostname: "otherapp.example.com", upstream: "otherapp-web:4000" },
    ];
    const output = formatRoutesTable(routes);
    expect(output).toContain("myapp.example.com");
    expect(output).toContain("otherapp.example.com");
    expect(output).toContain("myapp-web:3000");
    expect(output).toContain("otherapp-web:4000");
  });

  it("should produce header-only output for empty routes", () => {
    const output = formatRoutesTable([]);
    expect(output).toContain("HOSTNAME");
    expect(output).toContain("UPSTREAM");
  });
});

describe("formatStatusOutput", () => {
  const runningStatus: ContainerStatus = { running: true, status: "running" };
  const stoppedStatus: ContainerStatus = { running: false, status: "stopped" };
  const noDiscrepancies: ReconciliationResult = { ghostRoutes: [], missingRoutes: [] };

  it("should indicate proxy is stopped when not running", () => {
    const output = formatStatusOutput(stoppedStatus, "v2.7.6", [], noDiscrepancies);
    expect(output.toLowerCase()).toContain("stopped");
  });

  it("should not include route data when proxy is stopped", () => {
    const output = formatStatusOutput(stoppedStatus, "v2.7.6", [], noDiscrepancies);
    expect(output).toContain("stopped");
  });

  it("should indicate proxy is running", () => {
    const output = formatStatusOutput(runningStatus, "v2.7.6", [], noDiscrepancies);
    expect(output.toLowerCase()).toContain("running");
  });

  it("should show Caddy version", () => {
    const output = formatStatusOutput(runningStatus, "v2.7.6", [], noDiscrepancies);
    expect(output).toContain("v2.7.6");
  });

  it("should show no routes message when running with empty routes", () => {
    const output = formatStatusOutput(runningStatus, "v2.7.6", [], noDiscrepancies);
    expect(output.toLowerCase()).toMatch(/no\s*(live\s*)?routes/);
  });

  it("should display route table when routes exist", () => {
    const routes: LiveRoute[] = [
      { hostname: "myapp.example.com", upstream: "myapp-web:3000" },
    ];
    const output = formatStatusOutput(runningStatus, "v2.7.6", routes, noDiscrepancies);
    expect(output).toContain("myapp.example.com");
    expect(output).toContain("myapp-web:3000");
  });

  it("should display multiple routes in table", () => {
    const routes: LiveRoute[] = [
      { hostname: "myapp.example.com", upstream: "myapp-web:3000" },
      { hostname: "otherapp.example.com", upstream: "otherapp-web:4000" },
    ];
    const output = formatStatusOutput(runningStatus, "v2.7.6", routes, noDiscrepancies);
    expect(output).toContain("myapp.example.com");
    expect(output).toContain("myapp-web:3000");
    expect(output).toContain("otherapp.example.com");
    expect(output).toContain("otherapp-web:4000");
  });

  it("should display ghost route warnings", () => {
    const routes: LiveRoute[] = [
      { hostname: "ghost.com", upstream: "x:80" },
    ];
    const reconciliation: ReconciliationResult = {
      ghostRoutes: ["ghost.com"],
      missingRoutes: [],
    };
    const output = formatStatusOutput(runningStatus, "v2.7.6", routes, reconciliation);
    expect(output.toLowerCase()).toContain("ghost");
    expect(output).toContain("ghost.com");
  });

  it("should display missing route warnings", () => {
    const reconciliation: ReconciliationResult = {
      ghostRoutes: [],
      missingRoutes: ["missing.com"],
    };
    const output = formatStatusOutput(runningStatus, "v2.7.6", [], reconciliation);
    expect(output.toLowerCase()).toContain("missing");
    expect(output).toContain("missing.com");
  });

  it("should suggest fleet proxy reload when missing routes exist", () => {
    const reconciliation: ReconciliationResult = {
      ghostRoutes: [],
      missingRoutes: ["missing.com"],
    };
    const output = formatStatusOutput(runningStatus, "v2.7.6", [], reconciliation);
    expect(output).toContain("fleet proxy reload");
  });

  it("should not suggest reload when no missing routes", () => {
    const routes: LiveRoute[] = [
      { hostname: "myapp.example.com", upstream: "myapp-web:3000" },
    ];
    const output = formatStatusOutput(runningStatus, "v2.7.6", routes, noDiscrepancies);
    expect(output).not.toContain("fleet proxy reload");
  });

  it("should display both ghost and missing warnings", () => {
    const routes: LiveRoute[] = [
      { hostname: "ghost.com", upstream: "x:80" },
    ];
    const reconciliation: ReconciliationResult = {
      ghostRoutes: ["ghost.com"],
      missingRoutes: ["missing.com"],
    };
    const output = formatStatusOutput(runningStatus, "v2.7.6", routes, reconciliation);
    expect(output).toContain("ghost.com");
    expect(output).toContain("missing.com");
  });
});

// --- Integration tests for proxyStatus orchestration ---

describe("proxyStatus()", () => {
  it("should report stopped and not attempt API calls when container is not running", async () => {
    mockStateRef.value = singleStackState();
    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "",
      stderr: "Error: No such object: fleet-caddy",
      code: 1,
    };

    await proxyStatus();

    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("not found");

    // Should NOT have executed any Caddy API curl commands
    const caddyApiCalls = mockExecCommandsRef.value.filter(
      (cmd) => cmd.includes("curl")
    );
    expect(caddyApiCalls).toHaveLength(0);
  });

  it("should display route table with no warnings when routes match state", async () => {
    mockStateRef.value = singleStackState();

    // Container is running
    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "running",
      stderr: "",
      code: 0,
    };

    // IMPORTANT: /routes must come before /config/ due to pattern matching order
    // (both commands contain "/config/" in the URL, so routes must match first)
    mockExecHandlersRef.value["/routes"] = {
      stdout: JSON.stringify([
        buildCaddyRoute("myapp__web", "myapp.example.com", "myapp-web:3000"),
      ]),
      stderr: "",
      code: 0,
    };

    // Caddy config response with version
    mockExecHandlersRef.value["/config/"] = {
      stdout: JSON.stringify({ version: "v2.7.6" }),
      stderr: "",
      code: 0,
    };

    await proxyStatus();

    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("running");
    expect(logOutput).toContain("v2.7.6");
    expect(logOutput).toContain("myapp.example.com");
    expect(logOutput).toContain("myapp-web:3000");

    // No warnings
    expect(logOutput).not.toContain("Ghost");
    expect(logOutput).not.toContain("ghost");
    expect(logOutput).not.toContain("Missing");
    expect(logOutput).not.toContain("missing");
    expect(logOutput).not.toContain("fleet proxy reload");
  });

  it("should display ghost route warnings when Caddy has extra routes", async () => {
    mockStateRef.value = singleStackState(); // only myapp.example.com

    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "running",
      stderr: "",
      code: 0,
    };

    // IMPORTANT: /routes before /config/ due to pattern matching order
    mockExecHandlersRef.value["/routes"] = {
      stdout: JSON.stringify([
        buildCaddyRoute("myapp__web", "myapp.example.com", "myapp-web:3000"),
        buildCaddyRoute("ghost__web", "ghost.example.com", "ghost-web:9999"),
      ]),
      stderr: "",
      code: 0,
    };

    mockExecHandlersRef.value["/config/"] = {
      stdout: JSON.stringify({ version: "v2.7.6" }),
      stderr: "",
      code: 0,
    };

    await proxyStatus();

    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("myapp.example.com");
    expect(logOutput).toContain("ghost.example.com");
    expect(logOutput.toLowerCase()).toContain("ghost");
  });

  it("should display missing route warnings and reload suggestion when state has routes not in Caddy", async () => {
    mockStateRef.value = multiStackState(); // myapp.example.com + otherapp.example.com

    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "running",
      stderr: "",
      code: 0,
    };

    // IMPORTANT: /routes before /config/ due to pattern matching order
    mockExecHandlersRef.value["/routes"] = {
      stdout: JSON.stringify([
        buildCaddyRoute("myapp__web", "myapp.example.com", "myapp-web:3000"),
      ]),
      stderr: "",
      code: 0,
    };

    mockExecHandlersRef.value["/config/"] = {
      stdout: JSON.stringify({ version: "v2.7.6" }),
      stderr: "",
      code: 0,
    };

    await proxyStatus();

    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("otherapp.example.com");
    expect(logOutput.toLowerCase()).toContain("missing");
    expect(logOutput).toContain("fleet proxy reload");
  });

  it("should handle Caddy API call failure gracefully", async () => {
    mockStateRef.value = singleStackState();

    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "running",
      stderr: "",
      code: 0,
    };

    // IMPORTANT: /routes before /config/ due to pattern matching order
    mockExecHandlersRef.value["/routes"] = {
      stdout: "",
      stderr: "curl: (7) Failed to connect",
      code: 7,
    };

    mockExecHandlersRef.value["/config/"] = {
      stdout: "",
      stderr: "curl: (7) Failed to connect",
      code: 7,
    };

    await proxyStatus();

    // Should not crash - proxyStatus handles failed API calls gracefully
    // (parseCaddyVersion returns "unknown", parseCaddyRoutes returns [])
    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("unknown");
    expect(mockProcessExitCodeRef.value).toBeUndefined();
  });

  it("should always close SSH connection on success", async () => {
    mockStateRef.value = singleStackState();

    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "running",
      stderr: "",
      code: 0,
    };

    // IMPORTANT: /routes before /config/ due to pattern matching order
    mockExecHandlersRef.value["/routes"] = {
      stdout: JSON.stringify([
        buildCaddyRoute("myapp__web", "myapp.example.com", "myapp-web:3000"),
      ]),
      stderr: "",
      code: 0,
    };

    mockExecHandlersRef.value["/config/"] = {
      stdout: JSON.stringify({ version: "v2.7.6" }),
      stderr: "",
      code: 0,
    };

    await proxyStatus();

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should always close SSH connection when container is not running", async () => {
    mockStateRef.value = singleStackState();

    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "",
      stderr: "Error: No such object: fleet-caddy",
      code: 1,
    };

    await proxyStatus();

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should always close SSH connection on error", async () => {
    // Set state to null to force an error when proxyStatus tries to use it
    mockStateRef.value = null as unknown as FleetState;

    // Make docker inspect succeed so we get past it, then
    // the null state will cause an error during reconciliation
    mockExecHandlersRef.value["docker inspect"] = {
      stdout: "running",
      stderr: "",
      code: 0,
    };

    // IMPORTANT: /routes before /config/ due to pattern matching order
    mockExecHandlersRef.value["/routes"] = {
      stdout: JSON.stringify([]),
      stderr: "",
      code: 0,
    };

    mockExecHandlersRef.value["/config/"] = {
      stdout: JSON.stringify({ version: "v2.7.6" }),
      stderr: "",
      code: 0,
    };

    await proxyStatus();

    // Should have called process.exit(1) due to error
    expect(mockProcessExitCodeRef.value).toBe(1);
    // Connection should still be closed
    expect(mockCloseCalledCountRef.value).toBe(1);
  });
});
