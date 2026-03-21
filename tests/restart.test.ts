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
} = vi.hoisted(() => {
  return {
    mockConfigRef: { value: null as unknown as FleetConfig },
    mockStateRef: { value: null as unknown as FleetState },
    mockExecCommandsRef: { value: [] as string[] },
    mockCloseCalledCountRef: { value: 0 },
    mockProcessExitCodeRef: { value: undefined as number | undefined },
    mockWriteState: vi.fn(),
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
  writeState: mockWriteState,
}));

// Import after mock declarations
import { restartService, restart } from "../src/restart";

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

function stateWithoutStack(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {},
  };
}

// --- Unit Tests ---

describe("restartService", () => {
  it("should execute the correct docker compose restart command", async () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });

    await restartService(mockExec, "myapp", "web");

    expect(mockExec).toHaveBeenCalledOnce();
    expect(mockExec).toHaveBeenCalledWith(
      "docker compose -p myapp restart web"
    );
  });

  it("should succeed when exit code is 0", async () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "restarted",
      stderr: "",
      code: 0,
    });

    await expect(
      restartService(mockExec, "myapp", "api")
    ).resolves.toBeUndefined();
  });

  it("should throw an error with stderr content when exit code is non-zero", async () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "no such service: bad-svc",
      code: 1,
    });

    await expect(
      restartService(mockExec, "myapp", "bad-svc")
    ).rejects.toThrow("no such service: bad-svc");
  });
});

// --- Integration Tests ---

describe("restart", () => {
  beforeEach(() => {
    mockExecCommandsRef.value = [];
    mockCloseCalledCountRef.value = 0;
    mockProcessExitCodeRef.value = undefined;
    mockWriteState.mockClear();
    vi.spyOn(process, "exit").mockImplementation(
      (code?: string | number | null | undefined) => {
        mockProcessExitCodeRef.value =
          typeof code === "number" ? code : undefined;
        return undefined as never;
      }
    );
  });

  it("should successfully restart an existing stack's service", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await restart("myapp", "web");

    expect(mockProcessExitCodeRef.value).toBeUndefined();
    expect(mockExecCommandsRef.value).toContain(
      "docker compose -p myapp restart web"
    );
  });

  it("should error when stack is not found in state", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithoutStack();

    await restart("nonexistent", "web");

    expect(mockProcessExitCodeRef.value).toBe(1);
  });

  it("should close SSH connection on success", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await restart("myapp", "web");

    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should close SSH connection on failure", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithoutStack();

    await restart("myapp", "web");

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should never call writeState (read-only operation)", async () => {
    mockConfigRef.value = makeConfig();
    mockStateRef.value = stateWithStack();

    await restart("myapp", "web");

    expect(mockWriteState).not.toHaveBeenCalled();
  });
});
