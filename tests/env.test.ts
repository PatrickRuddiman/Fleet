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
  mockResolveSecretsCallsRef,
  mockProcessExitCodeRef,
  mockWriteState,
} = vi.hoisted(() => {
  return {
    mockConfigRef: { value: null as unknown as FleetConfig },
    mockStateRef: { value: null as unknown as FleetState },
    mockExecCommandsRef: { value: [] as string[] },
    mockCloseCalledCountRef: { value: 0 },
    mockResolveSecretsCallsRef: {
      value: [] as Array<{ config: FleetConfig; stackDir: string }>,
    },
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

vi.mock("../src/deploy", () => ({
  resolveSecrets: async (
    _exec: ExecFn,
    config: FleetConfig,
    stackDir: string
  ) => {
    mockResolveSecretsCallsRef.value.push({ config, stackDir });
  },
  configHasSecrets: (config: FleetConfig) => {
    if (!config.env) return false;
    if ("file" in config.env) return true;
    if (Array.isArray(config.env)) return config.env.length > 0;
    return (
      (config.env.entries !== undefined && config.env.entries.length > 0) ||
      config.env.infisical !== undefined
    );
  },
}));

vi.mock("../src/deploy/infisical", () => ({
  bootstrapInfisicalCli: async () => {},
}));

// Import pushEnv after mock declarations
import { pushEnv } from "../src/env";

// --- beforeEach reset ---

beforeEach(() => {
  mockExecCommandsRef.value = [];
  mockCloseCalledCountRef.value = 0;
  mockResolveSecretsCallsRef.value = [];
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

// --- Helper functions ---

function configWithEnv(): FleetConfig {
  return {
    version: "1" as const,
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    env: [
      { key: "DB_HOST", value: "localhost" },
      { key: "DB_PORT", value: "5432" },
    ],
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  } as FleetConfig;
}

function configWithInfisical(): FleetConfig {
  return {
    version: "1" as const,
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    env: {
      infisical: {
        token: "my-token",
        project_id: "proj-123",
        environment: "production",
        path: "/",
      },
    },
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  } as FleetConfig;
}

function configWithNoEnvSource(): FleetConfig {
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

// --- Tests ---

describe("pushEnv", () => {
  it("should successfully push env key-value pairs to an existing stack", async () => {
    mockConfigRef.value = configWithEnv();
    mockStateRef.value = stateWithStack();

    await pushEnv();

    expect(mockProcessExitCodeRef.value).toBeUndefined();
    expect(mockResolveSecretsCallsRef.value).toHaveLength(1);
    expect(mockResolveSecretsCallsRef.value[0].stackDir).toBe(
      "/opt/fleet/stacks/myapp"
    );
    expect(mockResolveSecretsCallsRef.value[0].config).toEqual(
      mockConfigRef.value
    );
  });

  it("should successfully push infisical secrets to an existing stack", async () => {
    mockConfigRef.value = configWithInfisical();
    mockStateRef.value = stateWithStack();

    await pushEnv();

    expect(mockProcessExitCodeRef.value).toBeUndefined();
    expect(mockResolveSecretsCallsRef.value).toHaveLength(1);
    expect(mockResolveSecretsCallsRef.value[0].stackDir).toBe(
      "/opt/fleet/stacks/myapp"
    );
    const env = mockResolveSecretsCallsRef.value[0].config.env as { infisical?: { token: string; project_id: string; environment: string; path: string } };
    expect(env.infisical).toEqual({
      token: "my-token",
      project_id: "proj-123",
      environment: "production",
      path: "/",
    });
  });

  it("should error when no env source is configured", async () => {
    mockConfigRef.value = configWithNoEnvSource();
    mockStateRef.value = stateWithStack();

    await pushEnv();

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockResolveSecretsCallsRef.value).toHaveLength(0);
    // Connection should NOT be established (error happens before SSH)
    expect(mockCloseCalledCountRef.value).toBe(0);
  });

  it("should error when the stack is not found in state.json", async () => {
    mockConfigRef.value = configWithEnv();
    mockStateRef.value = stateWithoutStack();

    await pushEnv();

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockResolveSecretsCallsRef.value).toHaveLength(0);
  });

  it("should never call writeState (state is read-only)", async () => {
    mockConfigRef.value = configWithEnv();
    mockStateRef.value = stateWithStack();

    await pushEnv();

    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it("should close SSH connection even on error", async () => {
    mockConfigRef.value = configWithEnv();
    mockStateRef.value = stateWithoutStack(); // triggers "stack not found" after connection

    await pushEnv();

    expect(mockProcessExitCodeRef.value).toBe(1);
    expect(mockCloseCalledCountRef.value).toBe(1);
  });

  it("should close SSH connection on success", async () => {
    mockConfigRef.value = configWithEnv();
    mockStateRef.value = stateWithStack();

    await pushEnv();

    expect(mockCloseCalledCountRef.value).toBe(1);
  });
});
