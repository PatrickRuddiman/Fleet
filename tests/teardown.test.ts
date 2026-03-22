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
  mockWriteState,
  mockExecFailPatternRef,
} = vi.hoisted(() => {
  return {
    mockConfigRef: { value: null as unknown as FleetConfig },
    mockStateRef: { value: null as unknown as FleetState },
    mockExecCommandsRef: { value: [] as string[] },
    mockCloseCalledCountRef: { value: 0 },
    mockProcessExitCodeRef: { value: undefined as number | undefined },
    mockWriteState: vi.fn(),
    mockExecFailPatternRef: { value: null as string | null },
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
      if (
        mockExecFailPatternRef.value &&
        cmd.includes(mockExecFailPatternRef.value)
      ) {
        return { stdout: "", stderr: "command failed", code: 1 };
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
  removeStack: (state: FleetState, name: string) => {
    const { [name]: _, ...remainingStacks } = state.stacks;
    return { ...state, stacks: remainingStacks };
  },
  writeState: mockWriteState,
}));

// Import after mock declarations
import { teardownStack, teardown } from "../src/teardown";

// --- Helper functions ---

function makeConfig(): FleetConfig {
  return {
    version: "1" as const,
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  } as FleetConfig;
}

function stateWithStack(): FleetState {
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

function stateWithMultiRouteStack(): FleetState {
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
            port: 8080,
            caddy_id: "myapp__api",
          },
        ],
      },
    },
  };
}

function stateWithoutStack(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {},
  };
}

// --- Unit Tests ---

describe("teardownStack", () => {
  it("should execute correct Caddy DELETE commands for each route", async () => {
    const commands: string[] = [];
    const mockExec: ExecFn = vi.fn().mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    });

    const routes = stateWithMultiRouteStack().stacks.myapp.routes;
    await teardownStack(mockExec, "myapp", routes, false);

    // Should have Caddy DELETE for each route + docker compose down
    expect(commands[0]).toBe(
      "docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/myapp__web"
    );
    expect(commands[1]).toBe(
      "docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/myapp__api"
    );
  });

  it("should execute docker compose down without --volumes when volumes is false", async () => {
    const commands: string[] = [];
    const mockExec: ExecFn = vi.fn().mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    });

    const routes = stateWithStack().stacks.myapp.routes;
    await teardownStack(mockExec, "myapp", routes, false);

    const downCmd = commands.find((c) => c.includes("docker compose"));
    expect(downCmd).toBe("docker compose -p myapp down");
  });

  it("should execute docker compose down with --volumes when volumes is true", async () => {
    const commands: string[] = [];
    const mockExec: ExecFn = vi.fn().mockImplementation(async (cmd: string) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    });

    const routes = stateWithStack().stacks.myapp.routes;
    await teardownStack(mockExec, "myapp", routes, true);

    const downCmd = commands.find((c) => c.includes("docker compose"));
    expect(downCmd).toBe("docker compose -p myapp down --volumes");
  });

  it("should throw an error when Caddy route removal fails", async () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "curl: (22) The requested URL returned error: 404",
      code: 1,
    });

    const routes = stateWithStack().stacks.myapp.routes;
    await expect(
      teardownStack(mockExec, "myapp", routes, false)
    ).rejects.toThrow();
  });

  it("should throw an error when docker compose down fails", async () => {
    const callCount = { value: 0 };
    const mockExec: ExecFn = vi.fn().mockImplementation(async (cmd: string) => {
      callCount.value++;
      // Caddy removal succeeds, docker compose down fails
      if (cmd.includes("docker compose")) {
        return { stdout: "", stderr: "error during connect", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const routes = stateWithStack().stacks.myapp.routes;
    await expect(
      teardownStack(mockExec, "myapp", routes, false)
    ).rejects.toThrow();
  });
});

// --- Integration Tests ---

describe("teardown", () => {
  beforeEach(() => {
    mockExecCommandsRef.value = [];
    mockCloseCalledCountRef.value = 0;
    mockProcessExitCodeRef.value = undefined;
    mockExecFailPatternRef.value = null;
    mockWriteState.mockClear();
    vi.spyOn(process, "exit").mockImplementation(
      (code?: string | number | null | undefined) => {
        mockProcessExitCodeRef.value =
          typeof code === "number" ? code : undefined;
        return undefined as never;
      }
    );
  });

  it("should successfully teardown and write updated state", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await teardown("myapp", false);

    expect(mockProcessExitCodeRef.value).toBeUndefined();
    expect(mockWriteState).toHaveBeenCalledOnce();
  });

  it("should call writeState with the stack removed from state", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await teardown("myapp", false);

    expect(mockWriteState).toHaveBeenCalledOnce();
    // The second argument to writeState should be the updated state without "myapp"
    const writtenState = mockWriteState.mock.calls[0][1] as FleetState;
    expect(writtenState.stacks).not.toHaveProperty("myapp");
    expect(writtenState.fleet_root).toBe("/opt/fleet");
    expect(writtenState.caddy_bootstrapped).toBe(true);
  });

  it("should call process.exit(1) when stack is not found", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithoutStack();

    await teardown("nonexistent", false);

    expect(mockProcessExitCodeRef.value).toBe(1);
  });

  it("should close SSH connection on success", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await teardown("myapp", false);

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should close SSH connection on failure", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithoutStack();

    await teardown("nonexistent", false);

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should not call writeState when docker compose down fails", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();
    mockExecFailPatternRef.value = "docker compose";

    await teardown("myapp", false);

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockWriteState).not.toHaveBeenCalled();
  });
});
