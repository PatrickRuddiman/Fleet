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
    const mockExec: ExecFn = vi
      .fn()
      .mockResolvedValue({ stdout: "true", stderr: "", code: 0 });

    const result = await reloadRoutes(mockExec, emptyState());

    // Only the docker inspect check should have been called
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("docker inspect")
    );
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it("should reload a single route with delete then add", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, singleStackState());

    // Verify DELETE command for the route
    expect(mockExec).toHaveBeenCalledWith(
      "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/myapp__web"
    );

    // Verify ADD command contains correct upstream host
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("docker exec -i fleet-caddy")
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("myapp-web-1:3000")
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("myapp.example.com")
    );

    // Verify result counts: 1 inspect + 1 delete + 1 add = 3 calls
    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(0);
  });

  it("should reload multiple routes across multiple stacks", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, multiStackState());

    // 1 inspect + 3 routes × 2 commands each (delete + add) = 7 calls
    expect(mockExec).toHaveBeenCalledTimes(7);

    // Verify DELETE commands for all three caddy_ids
    expect(mockExec).toHaveBeenCalledWith(
      "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/myapp__web"
    );
    expect(mockExec).toHaveBeenCalledWith(
      "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/myapp__api"
    );
    expect(mockExec).toHaveBeenCalledWith(
      "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/backend__server"
    );

    // Verify ADD commands contain correct upstream hosts
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("myapp-web-1:3000")
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("myapp-api-1:4000")
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("backend-server-1:8080")
    );

    // Verify result counts
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toHaveLength(0);
  });

  it("should collect partial failures and continue", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      // Fail the POST/add command for api.example.com
      if (cmd.includes("POST") && cmd.includes("api.example.com")) {
        return Promise.resolve({
          stdout: "",
          stderr: "connection refused",
          code: 1,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, multiStackState());

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toHaveLength(1);

    // Verify failure details include the failed route
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "api.example.com",
          stackName: "myapp",
        }),
      ])
    );
  });

  it("should report all failures when all routes fail to register", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      // All POST/add commands fail
      if (cmd.includes("POST")) {
        return Promise.resolve({
          stdout: "",
          stderr: "registration failed",
          code: 1,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, multiStackState());

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(3);
  });

  it("should silently ignore delete failures", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return Promise.resolve({ stdout: "true", stderr: "", code: 0 });
      }
      // DELETE commands fail
      if (cmd.includes("DELETE")) {
        return Promise.resolve({
          stdout: "",
          stderr: "route not found",
          code: 1,
        });
      }
      // POST commands succeed
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    const result = await reloadRoutes(mockExec, singleStackState());

    // Route should still succeed despite delete failure
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(0);
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
      expect.arrayContaining([
        expect.stringContaining("docker inspect"),
      ])
    );
    // Verify DELETE command for the route
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([
        "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/myapp__web",
      ])
    );
    // Verify ADD command for the route
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([
        expect.stringContaining("myapp.example.com"),
      ])
    );
  });

  it("should successfully reload routes for multiple stacks", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = multiStackState();

    await reloadProxy();

    expect(mockProcessExitCodeRef.value).toBeUndefined();

    // Verify DELETE commands for all 3 routes
    expect(mockExecCommandsRef.value).toEqual(
      expect.arrayContaining([
        "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/myapp__web",
        "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/myapp__api",
        "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/backend__server",
      ])
    );

    // Verify ADD commands contain correct upstream hosts
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
    // Only the docker inspect command should be issued (no route commands)
    const routeCommands = mockExecCommandsRef.value.filter(
      (cmd) => !cmd.includes("docker inspect")
    );
    expect(routeCommands).toHaveLength(0);
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

    // Verify exact DELETE command format
    const deleteCmd = mockExecCommandsRef.value.find((cmd) =>
      cmd.includes("DELETE")
    );
    expect(deleteCmd).toBe(
      "docker exec fleet-caddy curl -s -f -X DELETE http://localhost:2019/id/myapp__web"
    );

    // Verify ADD command format
    const addCmd = mockExecCommandsRef.value.find((cmd) =>
      cmd.includes("POST")
    );
    expect(addCmd).toBeDefined();
    expect(addCmd).toContain("docker exec -i fleet-caddy");
    expect(addCmd).toContain("myapp.example.com");
    expect(addCmd).toContain("myapp-web-1:3000");
  });
});
