import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecFn } from "../src/ssh/types";
import type { FleetState, StackState } from "../src/state/types";
import type { FleetConfig } from "../src/config/schema";

// --- Mutable mock state (hoisted so vi.mock factories can access them) ---
const {
  mockConfigRef,
  mockStateRef,
  mockExecCommandsRef,
  mockCloseCalledCountRef,
  mockProcessExitCodeRef,
  mockWriteState,
  mockRemoveStack,
} = vi.hoisted(() => {
  return {
    mockConfigRef: { value: null as unknown as FleetConfig },
    mockStateRef: { value: null as unknown as FleetState },
    mockExecCommandsRef: { value: [] as string[] },
    mockCloseCalledCountRef: { value: 0 },
    mockProcessExitCodeRef: { value: undefined as number | undefined },
    mockWriteState: vi.fn(),
    mockRemoveStack: vi.fn(),
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
  removeStack: mockRemoveStack,
  writeState: mockWriteState,
}));

// Import after mock declarations
import { stopStack, stop } from "../src/stop";

// --- Helper functions ---

function makeConfig(): FleetConfig {
  return {
    version: "1" as const,
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  } as FleetConfig;
}

function makeStackState(): StackState {
  return {
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
  };
}

function stateWithStack(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: makeStackState(),
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

describe("stopStack", () => {
  it("should execute correct Caddy DELETE commands for each route", async () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    await stopStack(mockExec, "myapp", makeStackState());

    expect(mockExec).toHaveBeenCalledWith(
      "docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/myapp__web"
    );
    expect(mockExec).toHaveBeenCalledWith(
      "docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/myapp__api"
    );
  });

  it("should execute correct docker compose stop command", async () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    await stopStack(mockExec, "myapp", makeStackState());

    expect(mockExec).toHaveBeenCalledWith("docker compose -p myapp stop");
  });

  it("should throw error when route deletion fails", async () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "route not found",
      code: 1,
    });

    await expect(
      stopStack(mockExec, "myapp", makeStackState())
    ).rejects.toThrow("route not found");
  });

  it("should throw error when container stop fails", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("docker compose")) {
        return Promise.resolve({ stdout: "", stderr: "stop failed", code: 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });

    await expect(
      stopStack(mockExec, "myapp", makeStackState())
    ).rejects.toThrow("stop failed");
  });
});

// --- Integration Tests ---

describe("stop", () => {
  beforeEach(() => {
    mockExecCommandsRef.value = [];
    mockCloseCalledCountRef.value = 0;
    mockProcessExitCodeRef.value = undefined;
    mockWriteState.mockClear();
    mockRemoveStack.mockClear();
    mockRemoveStack.mockImplementation((state: FleetState, name: string) => {
      const { [name]: _, ...remainingStacks } = state.stacks;
      return { ...state, stacks: remainingStacks };
    });
    vi.spyOn(process, "exit").mockImplementation(
      (code?: string | number | null | undefined) => {
        mockProcessExitCodeRef.value =
          typeof code === "number" ? code : undefined;
        return undefined as never;
      }
    );
  });

  it("should successfully stop an existing stack", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await stop("myapp");

    expect(mockProcessExitCodeRef.value).toBeUndefined();
    expect(mockExecCommandsRef.value).toContain(
      "docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/myapp__web"
    );
    expect(mockExecCommandsRef.value).toContain(
      "docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/myapp__api"
    );
    expect(mockExecCommandsRef.value).toContain(
      "docker compose -p myapp stop"
    );
  });

  it("should error when stack is not found in state", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithoutStack();

    await stop("nonexistent");

    expect(mockProcessExitCodeRef.value).toBe(1);
  });

  it("should close SSH connection on success", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await stop("myapp");

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should close SSH connection on failure", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithoutStack();

    await stop("nonexistent");

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should call writeState with the stack removed from state", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await stop("myapp");

    expect(mockWriteState).toHaveBeenCalledOnce();
    expect(mockWriteState.mock.calls[0][1].stacks).not.toHaveProperty("myapp");
  });
});
