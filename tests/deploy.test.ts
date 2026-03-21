import { describe, it, expect, vi } from "vitest";
import type { ExecResult, ExecFn } from "../src/ssh/types";
import type { FleetState } from "../src/state/types";
import type { FleetConfig, RouteConfig } from "../src/config/schema";
import {
  detectHostCollisions,
  bootstrapProxy,
  uploadFile,
  resolveSecrets,
  attachNetworks,
  checkHealth,
  registerRoutes,
} from "../src/deploy/helpers";
import { deploy } from "../src/deploy/deploy";

// --- Mocks for deploy() integration test (dry-run) ---
// These are hoisted by vitest and apply to the entire file.
// They only affect modules used by deploy() directly, not the helper functions
// which receive ExecFn as parameters.

const capturedDeployExecCommands: string[] = [];

vi.mock("../src/config", async () => {
  const actual = await vi.importActual<typeof import("../src/config")>(
    "../src/config"
  );
  return {
    ...actual,
    loadFleetConfig: () => ({
      version: "1",
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    }),
  };
});

vi.mock("../src/compose", async () => {
  const actual = await vi.importActual<typeof import("../src/compose")>(
    "../src/compose"
  );
  return {
    ...actual,
    loadComposeFile: () => ({ services: { web: {} } }),
    getServiceNames: () => ["web"],
  };
});

vi.mock("../src/validation", () => ({
  runAllChecks: () => [],
}));

vi.mock("../src/ssh", async () => {
  const actual = await vi.importActual<typeof import("../src/ssh")>(
    "../src/ssh"
  );
  return {
    ...actual,
    createConnection: async () => ({
      exec: async (cmd: string) => {
        capturedDeployExecCommands.push(cmd);
        if (cmd.includes("cat") && cmd.includes("state.json")) {
          return {
            stdout: JSON.stringify({
              fleet_root: "/opt/fleet",
              caddy_bootstrapped: true,
              stacks: {},
            }),
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      streamExec: async () => ({ stdout: "", stderr: "", code: 0 }),
      close: async () => {},
    }),
  };
});

// --- Test helpers ---

function mockExec(result: ExecResult): ExecFn {
  return async (_command: string): Promise<ExecResult> => result;
}

function createMockExec(handlers: Record<string, ExecResult>): ExecFn {
  return async (command: string): Promise<ExecResult> => {
    for (const [pattern, result] of Object.entries(handlers)) {
      if (command.includes(pattern)) {
        return result;
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function sampleState(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {
      "existing-app": {
        path: "/opt/fleet/stacks/existing-app",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-15T10:30:00.000Z",
        routes: [
          {
            host: "existing.example.com",
            service: "web",
            port: 3000,
            caddy_id: "existing-app__web",
          },
        ],
      },
    },
  };
}

// --- Tests ---

describe("detectHostCollisions", () => {
  it("should detect conflict when host is owned by a different stack", () => {
    const routes = [
      { domain: "existing.example.com", port: 3000, tls: true },
    ] as RouteConfig[];
    const state = sampleState();
    const result = detectHostCollisions(routes, state, "my-new-app");

    expect(result).toHaveLength(1);
    expect(result[0].host).toBe("existing.example.com");
    expect(result[0].ownedByStack).toBe("existing-app");
  });

  it("should return no collisions when hosts do not overlap", () => {
    const routes = [
      { domain: "brand-new.example.com", port: 8080, tls: true },
    ] as RouteConfig[];
    const state = sampleState();
    const result = detectHostCollisions(routes, state, "my-new-app");

    expect(result).toHaveLength(0);
  });

  it("should allow same-stack update (no collision with self)", () => {
    const routes = [
      { domain: "existing.example.com", port: 3000, tls: true },
    ] as RouteConfig[];
    const state = sampleState();
    const result = detectHostCollisions(routes, state, "existing-app");

    expect(result).toHaveLength(0);
  });
});

describe("bootstrapProxy", () => {
  it("should skip bootstrap when caddy_bootstrapped is true", async () => {
    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };
    const state = sampleState();
    const result = await bootstrapProxy(exec, state, "admin@test.com");

    expect(result.fleetRoot).toBe("/opt/fleet");
    expect(result.updatedState).toEqual(state);
    expect(commands).toHaveLength(0);
  });

  it("should run full bootstrap on fresh server", async () => {
    const freshState: FleetState = {
      fleet_root: "",
      caddy_bootstrapped: false,
      stacks: {},
    };
    const exec = createMockExec({
      "mkdir -p /opt/fleet": { code: 0, stdout: "", stderr: "" },
      "echo '/opt/fleet'": { code: 0, stdout: "", stderr: "" },
      "docker network create": { code: 0, stdout: "", stderr: "" },
      "mkdir -p": { code: 0, stdout: "", stderr: "" },
      "docker compose": { code: 0, stdout: "", stderr: "" },
      "docker exec": { code: 0, stdout: "", stderr: "" },
      FLEET_EOF: { code: 0, stdout: "", stderr: "" },
    });

    const result = await bootstrapProxy(exec, freshState, "admin@test.com");

    expect(result.fleetRoot).toBe("/opt/fleet");
    expect(result.updatedState.caddy_bootstrapped).toBe(true);
    expect(result.updatedState.fleet_root).toBe("/opt/fleet");
  });
});

describe("uploadFile", () => {
  it("should use atomic write pattern with .tmp and mv", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (cmd) => {
      capturedCommand = cmd;
      return { stdout: "", stderr: "", code: 0 };
    };

    await uploadFile(exec, {
      content: "hello world",
      remotePath: "/opt/fleet/stacks/myapp/compose.yml",
    });

    expect(capturedCommand).toContain(".tmp");
    expect(capturedCommand).toContain("mv");
    expect(capturedCommand).toContain("hello world");
    expect(capturedCommand).toContain("mkdir -p");
  });

  it("should throw on non-zero exit code", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "permission denied",
      code: 1,
    });

    await expect(
      uploadFile(exec, { content: "x", remotePath: "/some/path" })
    ).rejects.toThrow("Failed to upload file");
  });
});

describe("resolveSecrets", () => {
  it("should upload .env file when config has env entries", async () => {
    const config = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      env: [
        { key: "DB_HOST", value: "localhost" },
        { key: "DB_PORT", value: "5432" },
      ],
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };

    await resolveSecrets(exec, config, "/opt/fleet/stacks/myapp");

    expect(commands.length).toBeGreaterThan(0);
    expect(commands[0]).toContain("DB_HOST=localhost");
    expect(commands[0]).toContain("DB_PORT=5432");
    expect(commands[0]).toContain(".env");
    expect(commands[0]).toContain("0600");
  });

  it("should do nothing when config has no env and no infisical", async () => {
    const config = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };

    await resolveSecrets(exec, config, "/opt/fleet/stacks/myapp");

    expect(commands).toHaveLength(0);
  });
});

describe("attachNetworks", () => {
  it("should silently ignore 'already exists' errors", async () => {
    const exec = mockExec({
      code: 1,
      stdout: "",
      stderr:
        "Error response from daemon: endpoint with name myapp-web-1 already exists in network fleet-proxy",
    });

    // Should not throw
    await attachNetworks(exec, "myapp", ["web"]);
  });

  it("should throw on non-connection errors", async () => {
    const exec = mockExec({
      code: 1,
      stdout: "",
      stderr: "network fleet-proxy not found",
    });

    await expect(attachNetworks(exec, "myapp", ["web"])).rejects.toThrow(
      "Failed to connect"
    );
  });
});

describe("checkHealth", () => {
  it("should return null when health check succeeds", async () => {
    const exec = createMockExec({
      curl: { stdout: "200", stderr: "", code: 0 },
    });

    const result = await checkHealth(exec, "myapp.example.com", {
      path: "/health",
      timeout_seconds: 10,
      interval_seconds: 5,
    });

    expect(result).toBeNull();
  });

  it("should return a warning string when health check times out", async () => {
    const exec = createMockExec({
      curl: { stdout: "503", stderr: "", code: 0 },
      sleep: { stdout: "", stderr: "", code: 0 },
    });

    const result = await checkHealth(exec, "myapp.example.com", {
      path: "/health",
      timeout_seconds: 10,
      interval_seconds: 5,
    });

    expect(result).toBeTypeOf("string");
    expect(result).toContain("timed out");
    expect(result).toContain("myapp.example.com/health");
  });
});

describe("registerRoutes", () => {
  it("should register a new route and return route states", async () => {
    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };

    const routes = [
      { domain: "myapp.example.com", port: 3000, tls: true },
    ] as RouteConfig[];

    const result = await registerRoutes(exec, "myapp", routes);

    expect(commands.length).toBeGreaterThanOrEqual(2);
    expect(commands[0]).toContain("DELETE");
    expect(commands[1]).toContain("POST");
    expect(result).toHaveLength(1);
    expect(result[0].host).toBe("myapp.example.com");
    expect(result[0].service).toBe("default");
    expect(result[0].port).toBe(3000);
    expect(result[0].caddy_id).toBe("myapp__default");
  });

  it("should delete existing route before posting new one", async () => {
    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };

    const routes = [
      { domain: "api.example.com", port: 8080, service: "api", tls: true },
    ] as RouteConfig[];

    const result = await registerRoutes(exec, "mystack", routes);

    expect(commands[0]).toContain("DELETE");
    expect(commands[0]).toContain("mystack__api");
    expect(commands[1]).toContain("POST");
    expect(commands[1]).toContain("api.example.com");
    expect(result[0].caddy_id).toBe("mystack__api");
  });
});

describe("deploy dry-run", () => {
  it("should exit after step 5 without executing steps 6-16", async () => {
    capturedDeployExecCommands.length = 0;

    await deploy({ skipPull: false, noHealthCheck: false, dryRun: true });

    // Step 6 would create stack directory: mkdir -p /opt/fleet/stacks/myapp
    const hasStackMkdir = capturedDeployExecCommands.some(
      (c) => c.includes("stacks/myapp") && c.includes("mkdir")
    );
    expect(hasStackMkdir).toBe(false);

    // No docker compose pull/up commands
    const hasComposeUp = capturedDeployExecCommands.some(
      (c) => c.includes("docker compose") && c.includes("up")
    );
    expect(hasComposeUp).toBe(false);

    // No docker network connect
    const hasNetworkConnect = capturedDeployExecCommands.some((c) =>
      c.includes("docker network connect fleet-proxy")
    );
    expect(hasNetworkConnect).toBe(false);
  });
});
