import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FleetState, ServiceState } from "../src/state/types";

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
  getStack: (state: FleetState, name: string) => state.stacks[name],
}));

// Import AFTER mock declarations
import { ps } from "../src/ps";
import { parseDockerComposePs, formatTable } from "../src/ps/ps";

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

afterEach(() => {
  vi.useRealTimers();
});

// --- Helper functions ---

function sampleState(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/opt/fleet/stacks/myapp",
        compose_file: "compose.yml",
        deployed_at: "2025-01-15T10:30:00.000Z",
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

function multiStackState(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {
      api: {
        path: "/opt/fleet/stacks/api",
        compose_file: "compose.yml",
        deployed_at: "2025-01-16T12:00:00.000Z",
        routes: [
          {
            host: "api.example.com",
            service: "server",
            port: 8080,
            caddy_id: "api__server",
          },
        ],
      },
      myapp: {
        path: "/opt/fleet/stacks/myapp",
        compose_file: "compose.yml",
        deployed_at: "2025-01-15T10:30:00.000Z",
        routes: [
          {
            host: "myapp.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
          {
            host: "admin.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web_admin",
          },
        ],
      },
    },
  };
}

function emptyState(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {},
  };
}

function makeServiceState(overrides: Partial<ServiceState> = {}): ServiceState {
  return {
    image: "nginx:latest",
    definition_hash: "sha256:aaa",
    image_digest: "sha256:bbb",
    env_hash: "sha256:ccc",
    deployed_at: "2025-01-15T10:00:00.000Z",
    skipped_at: null,
    one_shot: false,
    status: "running",
    ...overrides,
  };
}

function stateWithServices(
  services: Record<string, ServiceState>,
): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/opt/fleet/stacks/myapp",
        compose_file: "compose.yml",
        deployed_at: "2025-01-15T10:30:00.000Z",
        routes: [
          {
            host: "myapp.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
        ],
        services,
      },
    },
  };
}

// --- Tests ---

describe("parseDockerComposePs", () => {
  it("should parse running services", () => {
    const output =
      '{"Service":"web","State":"running"}\n{"Service":"api","State":"running"}';
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(2);
    // Sorted alphabetically: api first, then web
    expect(result[0]).toEqual({ service: "api", status: "running" });
    expect(result[1]).toEqual({ service: "web", status: "running" });
  });

  it("should parse exited services", () => {
    const output = '{"Service":"worker","State":"exited"}';
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ service: "worker", status: "exited" });
  });

  it("should parse mixed states", () => {
    const output = [
      '{"Service":"web","State":"running"}',
      '{"Service":"worker","State":"exited"}',
      '{"Service":"db","State":"restarting"}',
    ].join("\n");
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(3);
    // Sorted alphabetically: db, web, worker
    expect(result[0].service).toBe("db");
    expect(result[0].status).toBe("restarting");
    expect(result[1].service).toBe("web");
    expect(result[1].status).toBe("running");
    expect(result[2].service).toBe("worker");
    expect(result[2].status).toBe("exited");
  });

  it("should return empty array for empty output", () => {
    const result = parseDockerComposePs("");
    expect(result).toEqual([]);
  });

  it("should return empty array for whitespace-only output", () => {
    const result = parseDockerComposePs("  \n  \n  ");
    expect(result).toEqual([]);
  });

  it("should skip malformed JSON lines", () => {
    const output =
      'not json\n{"Service":"web","State":"running"}\nalso not json';
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ service: "web", status: "running" });
  });

  it("should handle Service field missing by falling back to Name", () => {
    const output = '{"Name":"myservice","State":"running"}';
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ service: "myservice", status: "running" });
  });

  it("should use 'unknown' when both Service and Name are missing", () => {
    const output = '{"State":"running"}';
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ service: "unknown", status: "running" });
  });

  it("should use 'unknown' status when State is missing", () => {
    const output = '{"Service":"web"}';
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ service: "web", status: "unknown" });
  });

  it("should sort services alphabetically", () => {
    const output = [
      '{"Service":"zeta","State":"running"}',
      '{"Service":"alpha","State":"running"}',
      '{"Service":"mid","State":"running"}',
    ].join("\n");
    const result = parseDockerComposePs(output);

    expect(result).toHaveLength(3);
    expect(result[0].service).toBe("alpha");
    expect(result[1].service).toBe("mid");
    expect(result[2].service).toBe("zeta");
  });
});

describe("formatTable", () => {
  it("should format a single row with correct headers", () => {
    const rows = [
      {
        stack: "myapp",
        service: "web",
        status: "running",
        routes: "myapp.example.com -> web:3000",
        deployedAt: "2025-01-15T10:30:00.000Z",
      },
    ];
    const output = formatTable(rows);
    const lines = output.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("STACK");
    expect(lines[0]).toContain("SERVICE");
    expect(lines[0]).toContain("STATUS");
    expect(lines[0]).toContain("ROUTES");
    expect(lines[0]).toContain("DEPLOYED AT");
    expect(lines[1]).toContain("myapp");
    expect(lines[1]).toContain("web");
    expect(lines[1]).toContain("running");
    expect(lines[1]).toContain("myapp.example.com -> web:3000");
    expect(lines[1]).toContain("2025-01-15T10:30:00.000Z");
  });

  it("should align columns correctly", () => {
    const rows = [
      {
        stack: "a",
        service: "short",
        status: "running",
        routes: "r1",
        deployedAt: "d1",
      },
      {
        stack: "longstackname",
        service: "svc",
        status: "exited",
        routes: "very-long-route-string",
        deployedAt: "d2",
      },
    ];
    const output = formatTable(rows);
    const lines = output.split("\n");

    // All lines should have the same column start positions
    // The header and all data lines should have SERVICE starting at the same offset
    const headerServiceIdx = lines[0].indexOf("SERVICE");
    const row1ServiceIdx = lines[1].indexOf("short");
    const row2ServiceIdx = lines[2].indexOf("svc");

    expect(headerServiceIdx).toBe(row1ServiceIdx);
    expect(headerServiceIdx).toBe(row2ServiceIdx);
  });

  it("should handle empty routes", () => {
    const rows = [
      {
        stack: "myapp",
        service: "worker",
        status: "running",
        routes: "",
        deployedAt: "2025-01-15T10:30:00.000Z",
      },
    ];
    const output = formatTable(rows);

    expect(output).toContain("worker");
    expect(output).toContain("running");
    // Should not crash and should still have proper headers
    expect(output).toContain("ROUTES");
  });

  it("should group by stack name", () => {
    const rows = [
      {
        stack: "myapp",
        service: "web",
        status: "running",
        routes: "myapp.example.com -> web:3000",
        deployedAt: "2025-01-15T10:30:00.000Z",
      },
      {
        stack: "",
        service: "worker",
        status: "running",
        routes: "",
        deployedAt: "",
      },
    ];
    const output = formatTable(rows);
    const lines = output.split("\n");

    // Stack name appears on first data row
    expect(lines[1]).toContain("myapp");
    // Second data row has empty stack
    // "worker" appears but "myapp" does not appear at the start of the line
    expect(lines[2]).toContain("worker");
    // Verify stack name appears exactly once in data rows
    const dataLines = lines.slice(1);
    const stackOccurrences = dataLines.filter((l) => l.trimStart().startsWith("myapp"));
    expect(stackOccurrences).toHaveLength(1);
  });

  it("should handle multiple rows with different stacks", () => {
    const rows = [
      {
        stack: "api",
        service: "server",
        status: "running",
        routes: "api.example.com -> server:8080",
        deployedAt: "2025-01-16T12:00:00.000Z",
      },
      {
        stack: "myapp",
        service: "web",
        status: "running",
        routes: "myapp.example.com -> web:3000",
        deployedAt: "2025-01-15T10:30:00.000Z",
      },
    ];
    const output = formatTable(rows);

    expect(output).toContain("api");
    expect(output).toContain("myapp");
  });
});

describe("route joining", () => {
  it("should show routes for services that have them", async () => {
    mockStateRef.value = sampleState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("myapp.example.com -> web:3000");
  });

  it("should show empty routes for services without routes", async () => {
    mockStateRef.value = sampleState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout:
        '{"Service":"web","State":"running"}\n{"Service":"worker","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    const logOutput = mockConsoleLogRef.value.join("\n");
    // web should have a route
    expect(logOutput).toContain("myapp.example.com -> web:3000");
    // worker should appear but without routes
    expect(logOutput).toContain("worker");
  });

  it("should show multiple routes for a service", async () => {
    mockStateRef.value = multiStackState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps("myapp");

    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("myapp.example.com -> web:3000");
    expect(logOutput).toContain("admin.example.com -> web:3000");
  });
});

describe("ps()", () => {
  it("should read state and execute docker compose ps for each stack", async () => {
    mockStateRef.value = sampleState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    expect(mockExecCommandsRef.value).toContain(
      "docker compose -p myapp ps --format json"
    );
  });

  it("should handle single-stack filtering", async () => {
    mockStateRef.value = multiStackState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps("myapp");

    // Only myapp should be queried
    expect(mockExecCommandsRef.value).toContain(
      "docker compose -p myapp ps --format json"
    );
    expect(mockExecCommandsRef.value).not.toContain(
      "docker compose -p api ps --format json"
    );
  });

  it("should show all stacks when no filter provided", async () => {
    mockStateRef.value = multiStackState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    expect(mockExecCommandsRef.value).toContain(
      "docker compose -p api ps --format json"
    );
    expect(mockExecCommandsRef.value).toContain(
      "docker compose -p myapp ps --format json"
    );
  });

  it("should handle missing stack error", async () => {
    mockStateRef.value = sampleState();

    await ps("nonexistent");

    expect(mockProcessExitCodeRef.value).toBe(1);
  });

  it("should handle empty state gracefully", async () => {
    mockStateRef.value = emptyState();

    await ps();

    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("No stacks");
    expect(mockProcessExitCodeRef.value).toBeUndefined();
  });

  it("should close SSH connection on success", async () => {
    mockStateRef.value = sampleState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should close SSH connection on error", async () => {
    mockStateRef.value = sampleState();

    await ps("nonexistent");

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should handle docker compose ps failure gracefully", async () => {
    mockStateRef.value = sampleState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: "",
      stderr: "error",
      code: 1,
    };

    await ps();

    // Should not exit with error - the code shows "unknown" status for route-based services
    expect(mockProcessExitCodeRef.value).toBeUndefined();
    const logOutput = mockConsoleLogRef.value.join("\n");
    expect(logOutput).toContain("unknown");
  });
});

describe("per-service deployed/skipped timestamps", () => {
  it("(a) should show relative deployed time without annotation when only deployed_at is set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:30:00.000Z"));

    mockStateRef.value = stateWithServices({
      web: makeServiceState({
        deployed_at: "2025-01-15T10:30:00.000Z",
        skipped_at: null,
      }),
    });
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    const logOutput = mockConsoleLogRef.value.join("\n");
    // Should show "2 hours ago" for web, with no skip annotation
    expect(logOutput).toContain("2 hours ago");
    expect(logOutput).not.toContain("skipped");
  });

  it("(b) should show both deployed and skipped times when skipped_at is more recent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T14:00:00.000Z"));

    mockStateRef.value = stateWithServices({
      web: makeServiceState({
        deployed_at: "2025-01-15T10:00:00.000Z",
        skipped_at: "2025-01-15T13:00:00.000Z",
      }),
    });
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    const logOutput = mockConsoleLogRef.value.join("\n");
    // deployed_at was 4 hours ago, skipped_at was 1 hour ago
    expect(logOutput).toContain("4 hours ago");
    expect(logOutput).toContain("skipped");
    expect(logOutput).toContain("1 hour ago");
  });

  it("(c) should fall back to stack-level deployed_at for pre-V1.2 state without services map", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:30:00.000Z"));

    // Use sampleState() which has no `services` field — simulates pre-V1.2 state
    mockStateRef.value = sampleState();
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    const logOutput = mockConsoleLogRef.value.join("\n");
    // sampleState().stacks.myapp.deployed_at = "2025-01-15T10:30:00.000Z"
    // Current time is 2025-01-15T12:30:00.000Z → 2 hours ago
    expect(logOutput).toContain("2 hours ago");
    // Should not throw or error
    expect(mockProcessExitCodeRef.value).toBeUndefined();
  });

  it("(d) should show only deployed time when deployed_at is more recent than skipped_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T14:00:00.000Z"));

    mockStateRef.value = stateWithServices({
      web: makeServiceState({
        deployed_at: "2025-01-15T13:00:00.000Z",
        skipped_at: "2025-01-15T10:00:00.000Z",
      }),
    });
    mockExecHandlersRef.value["docker compose"] = {
      stdout: '{"Service":"web","State":"running"}',
      stderr: "",
      code: 0,
    };

    await ps();

    const logOutput = mockConsoleLogRef.value.join("\n");
    // deployed_at was 1 hour ago, skipped_at was 4 hours ago (older)
    // Should show only deployed time, no skip annotation
    expect(logOutput).toContain("1 hour ago");
    expect(logOutput).not.toContain("skipped");
  });
});
