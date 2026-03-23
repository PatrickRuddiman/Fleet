import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecFn } from "../src/ssh/types";
import type { FleetState } from "../src/state/types";
import type { FleetConfig } from "../src/config/schema";

// --- Mutable mock state (hoisted so vi.mock factories can access them) ---
const {
  mockConfigRef,
  mockStateRef,
  mockExecCommandsRef,
  mockCloseCalledCountRef,
  mockProcessExitCodeRef,
  mockCaddyRunningRef,
} = vi.hoisted(() => {
  return {
    mockConfigRef: { value: null as unknown as FleetConfig },
    mockStateRef: { value: null as unknown as FleetState },
    mockExecCommandsRef: { value: [] as string[] },
    mockCloseCalledCountRef: { value: 0 },
    mockProcessExitCodeRef: { value: undefined as number | undefined },
    mockCaddyRunningRef: { value: true as boolean },
  };
});

// --- Module-level mocks (hoisted by vitest) ---

vi.mock("../src/config", () => ({
  loadFleetConfig: () => mockConfigRef.value,
}));

const fullCaddyConfig = JSON.stringify({
  apps: {
    http: {
      servers: {
        fleet: {
          listen: [":443", ":80"],
          protocols: ["h1", "h2"],
          routes: [],
        },
      },
    },
  },
});

vi.mock("../src/ssh", () => ({
  createConnection: async () => ({
    exec: async (cmd: string) => {
      mockExecCommandsRef.value.push(cmd);
      if (cmd.includes("docker inspect")) {
        if (!mockCaddyRunningRef.value) {
          return { stdout: "", stderr: "No such container", code: 1 };
        }
        return { stdout: "true", stderr: "", code: 0 };
      }
      // GET /config/ — return full config
      if (!cmd.includes("-X") && cmd.includes("/config/")) {
        return { stdout: fullCaddyConfig, stderr: "", code: 0 };
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

// Import after mock declarations
import { reloadRoutes, reloadProxy } from "../src/reload";

// --- Helper functions ---

function makeConfig(): FleetConfig {
  return {
    version: "1" as const,
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  } as FleetConfig;
}

function emptyState(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {},
  };
}

function singleStackState(): FleetState {
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
            host: "api.example.com",
            service: "api",
            port: 4000,
            caddy_id: "myapp__api",
          },
        ],
      },
      backend: {
        path: "/opt/fleet/stacks/backend",
        compose_file: "compose.yml",
        deployed_at: "2025-01-16T12:00:00.000Z",
        routes: [
          {
            host: "backend.example.com",
            service: "server",
            port: 8080,
            caddy_id: "backend__server",
          },
        ],
      },
    },
  };
}

// --- Unit Tests ---

describe("reloadRoutes", () => {
  it("should handle empty state with no stacks", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      if (!cmd.includes("-X") && cmd.includes("/config/")) {
        return Promise.resolve({ stdout: fullCaddyConfig, stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, emptyState());

    // inspect + GET /config/ + POST /load
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("docker inspect"));
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it("should reload a single route via GET + POST /load", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      if (!cmd.includes("-X") && cmd.includes("/config/")) {
        return Promise.resolve({ stdout: fullCaddyConfig, stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, singleStackState());

    // Verify no DELETE or PATCH commands
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining("DELETE"));
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining("-X PATCH"));

    // Verify GET /config/ then POST /load with correct content
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("/config/"));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("-X POST"));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("/load"));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("myapp-web-1:3000"));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("myapp.example.com"));

    // 1 inspect + 1 GET + 1 POST /load = 3 calls total
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(0);
  });

  it("should reload multiple routes across multiple stacks in a single POST /load", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      if (!cmd.includes("-X") && cmd.includes("/config/")) {
        return Promise.resolve({ stdout: fullCaddyConfig, stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, multiStackState());

    // 1 inspect + 1 GET + 1 POST /load = 3 calls total
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining("DELETE"));
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining("-X PATCH"));

    // POST /load contains all upstream hosts
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("myapp-web-1:3000"));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("myapp-api-1:4000"));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("backend-server-1:8080"));

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toHaveLength(0);
  });

  it("should report all routes as failed when POST /load fails", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      if (!cmd.includes("-X") && cmd.includes("/config/")) {
        return Promise.resolve({ stdout: fullCaddyConfig, stderr: "", code: 0 });
      }
      // POST /load fails
      if (cmd.includes("-X POST") && cmd.includes("/load")) {
        return Promise.resolve({ stdout: "", stderr: "connection refused", code: 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, multiStackState());

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(3);
  });

  it("should throw when Caddy container is not running", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({
          stdout: "",
          stderr: "No such container",
          code: 1,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    await expect(
      reloadRoutes(mockExec, singleStackState())
    ).rejects.toThrow("not running");
  });
});

// --- Integration Tests ---

describe("reloadProxy", () => {
  beforeEach(() => {
    mockExecCommandsRef.value = [];
    mockCloseCalledCountRef.value = 0;
    mockProcessExitCodeRef.value = undefined;
    mockCaddyRunningRef.value = true;
    vi.spyOn(process, "exit").mockImplementation(
      (code?: string | number | null | undefined) => {
        mockProcessExitCodeRef.value =
          typeof code === "number" ? code : undefined;
        return undefined as never;
      }
    );
  });

  it("should successfully reload routes for a single stack", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = singleStackState();

    await reloadProxy();

    expect(mockProcessExitCodeRef.value).toBeUndefined();
    // Verify docker inspect check was issued
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([expect.stringContaining("docker inspect")])
    );
    // Verify GET /config/ then POST /load with the route
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([expect.stringContaining("/config/")])
    );
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([expect.stringContaining("-X POST")])
    );
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([expect.stringContaining("myapp.example.com")])
    );
    // No DELETE or PATCH commands
    expect(mockExecCommandsRef.value.some((cmd) => cmd.includes("DELETE"))).toBe(false);
    expect(mockExecCommandsRef.value.some((cmd) => cmd.includes("-X PATCH"))).toBe(false);
  });

  it("should successfully reload routes for multiple stacks", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = multiStackState();

    await reloadProxy();

    expect(mockProcessExitCodeRef.value).toBeUndefined();

    // Single POST /load contains all upstream hosts (no DELETE or PATCH commands)
    expect(mockExecCommandsRef.value.some((cmd) => cmd.includes("DELETE"))).toBe(false);
    expect(mockExecCommandsRef.value.some((cmd) => cmd.includes("-X PATCH"))).toBe(false);
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([
        expect.stringContaining("myapp-web-1:3000"),
        expect.stringContaining("myapp-api-1:4000"),
        expect.stringContaining("backend-server-1:8080"),
      ])
    );
  });

  it("should handle empty state gracefully", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = emptyState();

    await reloadProxy();

    expect(mockProcessExitCodeRef.value).toBeUndefined();
    // Inspect + GET /config/ + POST /load (even with empty routes, config is updated)
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([expect.stringContaining("docker inspect")])
    );
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([expect.stringContaining("/load")])
    );
  });

  it("should exit with error when Caddy container is not running", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = singleStackState();
    mockCaddyRunningRef.value = false;

    await reloadProxy();

    expect(mockProcessExitCodeRef.value).toBe(1);
  });

  it("should close SSH connection on success", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = singleStackState();

    await reloadProxy();

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should close SSH connection on failure", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = singleStackState();
    mockCaddyRunningRef.value = false;

    await reloadProxy();

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should generate correct Caddy API commands", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = singleStackState();

    await reloadProxy();

    // No DELETE or PATCH commands — uses GET /config/ + POST /load
    expect(mockExecCommandsRef.value.some((cmd) => cmd.includes("DELETE"))).toBe(false);
    expect(mockExecCommandsRef.value.some((cmd) => cmd.includes("-X PATCH"))).toBe(false);

    // Verify POST /load command format
    const loadCmd = mockExecCommandsRef.value.find(
      (cmd) => cmd.includes("-X POST") && cmd.includes("/load")
    );
    expect(loadCmd).toBeDefined();
    expect(loadCmd).toContain("docker exec -i fleet-proxy");
    expect(loadCmd).toContain("myapp.example.com");
    expect(loadCmd).toContain("myapp-web-1:3000");
  });
});
