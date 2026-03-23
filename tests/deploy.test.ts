import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { ExecResult, ExecFn } from "../src/ssh/types";
import type { FleetState } from "../src/state/types";
import type { FleetConfig, RouteConfig } from "../src/config/schema";
import {
  detectHostCollisions,
  bootstrapProxy,
  uploadFile,
  uploadFileBase64,
  resolveSecrets,
  attachNetworks,
  checkHealth,
  registerRoutes,
  configHasSecrets,
  hasFloatingTag,
} from "../src/deploy/helpers";
import { deploy } from "../src/deploy/deploy";

const mockInfisicalListSecrets = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ secrets: [] })
);
const mockInfisicalAccessToken = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const { mockDeployStateRef, mockDeployConfigRef } = vi.hoisted(() => ({
  mockDeployStateRef: {
    value: {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {},
    } as FleetState,
  },
  mockDeployConfigRef: {
    value: {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      routes: [
        { domain: "myapp.example.com", port: 3000, tls: true },
      ],
    } as FleetConfig,
  },
}));

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
    loadFleetConfig: () => mockDeployConfigRef.value,
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
            stdout: JSON.stringify(mockDeployStateRef.value),
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

vi.mock("@infisical/sdk", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  InfisicalSDK: vi.fn(function () {
    return {
      auth: () => ({ accessToken: mockInfisicalAccessToken }),
      secrets: () => ({ listSecrets: mockInfisicalListSecrets }),
    };
  }),
}));

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
    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };

    await uploadFile(exec, {
      content: "hello world",
      remotePath: "/opt/fleet/stacks/myapp/compose.yml",
    });

    expect(commands.some((c) => c.includes(".tmp"))).toBe(true);
    expect(commands.some((c) => c.includes("mv"))).toBe(true);
    expect(commands.some((c) => c.includes("hello world"))).toBe(true);
    expect(commands.some((c) => c.includes("mkdir -p"))).toBe(true);
  });

  it("should throw on non-zero exit code", async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd.includes("mv ")) {
        return { stdout: "", stderr: "permission denied", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(
      uploadFile(exec, { content: "x", remotePath: "/some/path" })
    ).rejects.toThrow("Failed to upload file");
  });
});

describe("uploadFileBase64", () => {
  it("should base64-encode content and use atomic write pattern", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (cmd) => {
      capturedCommand = cmd;
      return { stdout: "", stderr: "", code: 0 };
    };

    await uploadFileBase64(exec, {
      content: "DB_HOST=localhost\nDB_PORT=5432\n",
      remotePath: "/opt/fleet/stacks/myapp/.env",
      permissions: "0600",
    });

    const expectedBase64 = Buffer.from("DB_HOST=localhost\nDB_PORT=5432\n").toString("base64");

    // Verify the command contains the base64-encoded content
    expect(capturedCommand).toContain(expectedBase64);
    // Verify atomic .tmp + mv pattern
    expect(capturedCommand).toContain(".env.tmp");
    expect(capturedCommand).toContain("mv");
    // Verify base64 decoding on the remote side
    expect(capturedCommand).toContain("base64 -d");
    // Verify directory creation
    expect(capturedCommand).toContain("mkdir -p");
    // Verify permissions
    expect(capturedCommand).toContain("chmod 0600");
  });

  it("should handle content with shell metacharacters safely", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (cmd) => {
      capturedCommand = cmd;
      return { stdout: "", stderr: "", code: 0 };
    };

    const trickyContent = "PASSWORD=p@ss$w0rd!&echo 'hacked'\nFLEET_EOF\nKEY=val\"ue";
    await uploadFileBase64(exec, {
      content: trickyContent,
      remotePath: "/opt/fleet/stacks/myapp/.env",
      permissions: "0600",
    });

    const expectedBase64 = Buffer.from(trickyContent).toString("base64");

    // The raw content should NOT appear in the command (it's base64-encoded)
    expect(capturedCommand).not.toContain("FLEET_EOF");
    expect(capturedCommand).not.toContain("p@ss$w0rd");
    // The base64-encoded content should appear
    expect(capturedCommand).toContain(expectedBase64);
  });

  it("should omit chmod when permissions are not specified", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (cmd) => {
      capturedCommand = cmd;
      return { stdout: "", stderr: "", code: 0 };
    };

    await uploadFileBase64(exec, {
      content: "hello",
      remotePath: "/opt/fleet/stacks/myapp/config.txt",
    });

    expect(capturedCommand).not.toContain("chmod");
    expect(capturedCommand).toContain("base64 -d");
    expect(capturedCommand).toContain("mv");
  });

  it("should throw on non-zero exit code", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "permission denied",
      code: 1,
    });

    await expect(
      uploadFileBase64(exec, {
        content: "test",
        remotePath: "/some/path",
        permissions: "0600",
      })
    ).rejects.toThrow("Failed to upload file");
  });

  it("should include stderr detail in error message", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "disk full",
      code: 1,
    });

    await expect(
      uploadFileBase64(exec, {
        content: "test",
        remotePath: "/some/path",
      })
    ).rejects.toThrow("disk full");
  });
});

describe("resolveSecrets", () => {
  it("should upload .env file when config has env entries", async () => {
    const config = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      env: {
        entries: [
          { key: "DB_HOST", value: "localhost" },
          { key: "DB_PORT", value: "5432" },
        ],
      },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };

    await resolveSecrets(exec, config, "/opt/fleet/stacks/myapp");

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((c) => c.includes("DB_HOST=localhost"))).toBe(true);
    expect(commands.some((c) => c.includes("DB_PORT=5432"))).toBe(true);
    expect(commands.some((c) => c.includes(".env"))).toBe(true);
    expect(commands.some((c) => c.includes("0600"))).toBe(true);
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

  it("should fetch secrets via SDK and upload .env file", async () => {
    mockInfisicalListSecrets.mockResolvedValueOnce({
      secrets: [
        { secretKey: "API_KEY", secretValue: "abc123", id: "", workspaceId: "", environment: "", secretValueHidden: false, isRotatedSecret: false, tags: [], type: "shared", createdAt: "", updatedAt: "", version: 1 },
        { secretKey: "DB_URL", secretValue: "postgres://localhost/db", id: "", workspaceId: "", environment: "", secretValueHidden: false, isRotatedSecret: false, tags: [], type: "shared", createdAt: "", updatedAt: "", version: 1 },
      ],
    });

    const config = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      env: {
        infisical: {
          token: "my-secret-token",
          project_id: "proj-456",
          environment: "production",
          path: "/backend",
        },
      },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "", stderr: "", code: 0 };
    };

    await resolveSecrets(exec, config, "/opt/fleet/stacks/myapp");

    expect(mockInfisicalListSecrets).toHaveBeenCalledWith({
      projectId: "proj-456",
      environment: "production",
      secretPath: "/backend",
    });
    const expectedBase64 = Buffer.from(
      "API_KEY=abc123\nDB_URL=postgres://localhost/db\n"
    ).toString("base64");
    expect(commands.some((c) => c.includes(expectedBase64))).toBe(true);
    expect(commands.some((c) => c.includes(".env"))).toBe(true);
    expect(commands.some((c) => c.includes("0600"))).toBe(true);
  });

  it("should propagate SDK errors when fetching secrets fails", async () => {
    mockInfisicalListSecrets.mockRejectedValueOnce(
      new Error("Infisical API error: 404 Folder not found")
    );

    const config = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      env: {
        infisical: {
          token: "bad-token",
          project_id: "proj-789",
          environment: "staging",
          path: "/",
        },
      },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    const exec: ExecFn = async () => ({ stdout: "", stderr: "", code: 0 });

    await expect(
      resolveSecrets(exec, config, "/opt/fleet/stacks/myapp")
    ).rejects.toThrow("Infisical API error: 404 Folder not found");
  });

  describe("env.file", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should upload env file content via base64 with correct permissions", async () => {
      const envContent = "DB_HOST=localhost\nDB_PORT=5432\n";
      const envFilePath = path.join(tmpDir, ".env.production");
      fs.writeFileSync(envFilePath, envContent);

      const config = {
        version: "1" as const,
        server: { host: "example.com", port: 22, user: "root" },
        stack: { name: "myapp", compose_file: "compose.yml" },
        env: { file: ".env.production" },
        routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
      } as FleetConfig;

      const commands: string[] = [];
      const exec: ExecFn = async (cmd) => {
        commands.push(cmd);
        return { stdout: "", stderr: "", code: 0 };
      };

      await resolveSecrets(exec, config, "/opt/fleet/stacks/myapp", tmpDir);

      expect(commands).toHaveLength(1);
      // Verify base64 encoding is used
      const expectedBase64 = Buffer.from(envContent).toString("base64");
      expect(commands[0]).toContain(expectedBase64);
      expect(commands[0]).toContain("base64 -d");
      expect(commands[0]).toContain("/opt/fleet/stacks/myapp/.env");
      expect(commands[0]).toContain("0600");
    });

    it("should throw a descriptive error when env file is missing", async () => {
      const config = {
        version: "1" as const,
        server: { host: "example.com", port: 22, user: "root" },
        stack: { name: "myapp", compose_file: "compose.yml" },
        env: { file: "nonexistent.env" },
        routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
      } as FleetConfig;

      const exec: ExecFn = async () => ({
        stdout: "",
        stderr: "",
        code: 0,
      });

      await expect(
        resolveSecrets(exec, config, "/opt/fleet/stacks/myapp", tmpDir)
      ).rejects.toThrow("env.file not found");

      // Verify error includes the resolved absolute path
      await expect(
        resolveSecrets(exec, config, "/opt/fleet/stacks/myapp", tmpDir)
      ).rejects.toThrow(path.resolve(tmpDir, "nonexistent.env"));
    });

    it("should set correct 0600 permissions on uploaded file", async () => {
      const envContent = "SECRET=value\n";
      const envFilePath = path.join(tmpDir, "secrets.env");
      fs.writeFileSync(envFilePath, envContent);

      const config = {
        version: "1" as const,
        server: { host: "example.com", port: 22, user: "root" },
        stack: { name: "myapp", compose_file: "compose.yml" },
        env: { file: "secrets.env" },
        routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
      } as FleetConfig;

      const commands: string[] = [];
      const exec: ExecFn = async (cmd) => {
        commands.push(cmd);
        return { stdout: "", stderr: "", code: 0 };
      };

      await resolveSecrets(exec, config, "/opt/fleet/stacks/myapp", tmpDir);

      expect(commands[0]).toContain("chmod 0600");
    });
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
      "docker exec": { stdout: "200", stderr: "", code: 0 },
    });

    const result = await checkHealth(exec, "myapp", "web", 3000, {
      path: "/health",
      timeout_seconds: 10,
      interval_seconds: 5,
    });

    expect(result).toBeNull();
  });

  it("should return a warning string when health check times out", async () => {
    const exec = createMockExec({
      "docker exec": { stdout: "503", stderr: "", code: 0 },
      sleep: { stdout: "", stderr: "", code: 0 },
    });

    const result = await checkHealth(exec, "myapp", "web", 3000, {
      path: "/health",
      timeout_seconds: 10,
      interval_seconds: 5,
    });

    expect(result).toBeTypeOf("string");
    expect(result).toContain("timed out");
    expect(result).toContain("myapp-web-1");
    expect(result).toContain("/health");
    expect(result).toContain("last status:");
    expect(result).toContain("HTTP 503");
  });

  it("should include error details when docker exec fails", async () => {
    const exec = createMockExec({
      "docker exec": { stdout: "", stderr: "curl not found", code: 126 },
      sleep: { stdout: "", stderr: "", code: 0 },
    });

    const result = await checkHealth(exec, "myapp", "api", 8080, {
      path: "/",
      timeout_seconds: 4,
      interval_seconds: 2,
    });

    expect(result).toBeTypeOf("string");
    expect(result).toContain("timed out");
    expect(result).toContain("myapp-api-1");
    expect(result).toContain("last status:");
    expect(result).toContain("curl not found");
  });

  it("should use docker exec to poll the container directly", async () => {
    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: "200", stderr: "", code: 0 };
    };

    await checkHealth(exec, "mystack", "web", 3000, {
      path: "/health",
      timeout_seconds: 10,
      interval_seconds: 5,
    });

    expect(commands[0]).toContain("docker exec mystack-web-1");
    expect(commands[0]).toContain("http://localhost:3000/health");
  });
});

const emptyState = (): FleetState => ({
  fleet_root: "/opt/fleet",
  caddy_bootstrapped: true,
  stacks: {},
});

const fullCaddyConfig = JSON.stringify({
  apps: { http: { servers: { fleet: { listen: [":443", ":80"], protocols: ["h1", "h2"], routes: [] } } } },
});

describe("registerRoutes", () => {
  it("should GET full config then POST /load with new routes", async () => {
    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: cmd.includes("-X") ? "" : fullCaddyConfig, stderr: "", code: 0 };
    };

    const routes = [
      { domain: "myapp.example.com", port: 3000, tls: true },
    ] as RouteConfig[];

    const result = await registerRoutes(exec, "myapp", routes, emptyState());

    expect(commands).toHaveLength(2);
    // First: GET /config/ (no -X flag)
    expect(commands[0]).not.toContain("-X");
    expect(commands[0]).toContain("/config/");
    // Second: POST /load
    expect(commands[1]).toContain("-X POST");
    expect(commands[1]).toContain("/load");
    expect(commands[1]).toContain("myapp.example.com");
    expect(result).toHaveLength(1);
    expect(result[0].host).toBe("myapp.example.com");
    expect(result[0].service).toBe("default");
    expect(result[0].port).toBe(3000);
    expect(result[0].caddy_id).toBe("myapp__myapp-example-com");
  });

  it("should include other stacks' routes from state (not from Caddy config)", async () => {
    const stateWithOtherStack: FleetState = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {
        other: {
          path: "/opt/fleet/stacks/other",
          compose_file: "compose.yml",
          deployed_at: "2025-01-01T00:00:00.000Z",
          routes: [{ host: "other.example.com", service: "web", port: 4000, caddy_id: "other__web" }],
        },
      },
    };

    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      return { stdout: cmd.includes("-X") ? "" : fullCaddyConfig, stderr: "", code: 0 };
    };

    const routes = [
      { domain: "api.example.com", port: 8080, service: "api", tls: true },
    ] as RouteConfig[];

    const result = await registerRoutes(exec, "mystack", routes, stateWithOtherStack);

    expect(commands[1]).toContain("-X POST");
    expect(commands[1]).toContain("/load");
    // New route for this stack
    expect(commands[1]).toContain("api.example.com");
    expect(commands[1]).toContain("mystack__api-example-com");
    // Other stack's route from state
    expect(commands[1]).toContain("other__other-example-com");
    expect(result[0].caddy_id).toBe("mystack__api-example-com");
  });

  it("should fall back to empty config if GET /config/ fails", async () => {
    const commands: string[] = [];
    const exec: ExecFn = async (cmd) => {
      commands.push(cmd);
      if (!cmd.includes("-X")) {
        return { stdout: "", stderr: "connection refused", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const routes = [
      { domain: "myapp.example.com", port: 3000, tls: true },
    ] as RouteConfig[];

    const result = await registerRoutes(exec, "myapp", routes, emptyState());

    // Should still attempt /load despite GET failure
    expect(commands[1]).toContain("-X POST");
    expect(commands[1]).toContain("/load");
    expect(commands[1]).toContain("myapp.example.com");
    expect(result[0].caddy_id).toBe("myapp__myapp-example-com");
  });
});

describe("configHasSecrets", () => {
  const baseConfig = {
    version: "1" as const,
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  } as FleetConfig;

  it("should return true when env is an object with a file field", () => {
    const config = { ...baseConfig, env: { file: ".env.production" } } as FleetConfig;
    expect(configHasSecrets(config)).toBe(true);
  });

  it("should return true when env is a non-empty array of key-value pairs", () => {
    const config = {
      ...baseConfig,
      env: [{ key: "DB_HOST", value: "localhost" }],
    } as FleetConfig;
    expect(configHasSecrets(config)).toBe(true);
  });

  it("should return true when infisical is configured via env.infisical", () => {
    const config = {
      ...baseConfig,
      env: { infisical: { token: "tok", project_id: "proj123", environment: "production", path: "/" } },
    } as FleetConfig;
    expect(configHasSecrets(config)).toBe(true);
  });

  it("should return false when no env and no infisical", () => {
    expect(configHasSecrets(baseConfig)).toBe(false);
  });

  it("should return false when env is an empty array", () => {
    const config = { ...baseConfig, env: [] } as FleetConfig;
    expect(configHasSecrets(config)).toBe(false);
  });

  it("should return true when both env.file and env.infisical are present", () => {
    // Note: env can only be one type at a time in the union, so test with infisical in env object
    const config = {
      ...baseConfig,
      env: { infisical: { token: "tok", project_id: "proj123", environment: "staging", path: "/" } },
    } as FleetConfig;
    expect(configHasSecrets(config)).toBe(true);
  });
});

describe("hasFloatingTag", () => {
  it("should return true when image is undefined", () => {
    expect(hasFloatingTag(undefined)).toBe(true);
  });

  it("should return true when image is empty string", () => {
    expect(hasFloatingTag("")).toBe(true);
  });

  it("should return true when image has no tag (defaults to latest)", () => {
    expect(hasFloatingTag("nginx")).toBe(true);
  });

  it("should return true when image has explicit :latest tag", () => {
    expect(hasFloatingTag("nginx:latest")).toBe(true);
  });

  it("should return true for registry image with no tag", () => {
    expect(hasFloatingTag("ghcr.io/org/repo")).toBe(true);
  });

  it("should return true for registry image with :latest tag", () => {
    expect(hasFloatingTag("myregistry.com/myapp:latest")).toBe(true);
  });

  it("should return true when image contains @sha256: digest", () => {
    expect(hasFloatingTag("nginx@sha256:abc123def456")).toBe(true);
  });

  it("should return true for registry image with @sha256: digest", () => {
    expect(hasFloatingTag("ghcr.io/org/repo@sha256:abc123")).toBe(true);
  });

  it("should return false when image has a pinned non-latest tag", () => {
    expect(hasFloatingTag("nginx:1.25")).toBe(false);
  });

  it("should return false for registry image with pinned tag", () => {
    expect(hasFloatingTag("ghcr.io/org/repo:v2.0.0")).toBe(false);
  });

  it("should return false for image with specific version tag", () => {
    expect(hasFloatingTag("node:20-alpine")).toBe(false);
  });

  it("should not confuse registry port with a tag", () => {
    // myregistry.com:5000/myapp has no tag — should be floating
    expect(hasFloatingTag("myregistry.com:5000/myapp")).toBe(true);
  });

  it("should not confuse registry port when image has a pinned tag", () => {
    expect(hasFloatingTag("myregistry.com:5000/myapp:1.0")).toBe(false);
  });

  it("should handle registry with port and :latest tag", () => {
    expect(hasFloatingTag("myregistry.com:5000/myapp:latest")).toBe(true);
  });
});

describe("deploy dry-run", () => {
  it("should exit after step 5 without executing steps 6-16", async () => {
    capturedDeployExecCommands.length = 0;

    await deploy({ skipPull: false, noHealthCheck: false, dryRun: true, force: false });

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

describe("deploy force mode warning banner", () => {
  beforeEach(() => {
    capturedDeployExecCommands.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should print the force mode warning banner when force is true", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      });

    try {
      await deploy({ skipPull: true, noHealthCheck: true, dryRun: false, force: true });
    } catch {
      // deploy may call process.exit(1) which throws; ignore
    }

    expect(logSpy).toHaveBeenCalledWith("⚠ Force mode — all services will be redeployed");
  });

  it("should not print the force mode warning banner when force is false", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      });

    try {
      await deploy({ skipPull: true, noHealthCheck: true, dryRun: false, force: false });
    } catch {
      // deploy may call process.exit(1) which throws; ignore
    }

    expect(logSpy).not.toHaveBeenCalledWith("⚠ Force mode — all services will be redeployed");
  });
});

describe("deploy collision aborts before proxy bootstrap", () => {
  beforeEach(() => {
    capturedDeployExecCommands.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset refs to defaults so other tests are not affected
    mockDeployStateRef.value = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {},
    };
    mockDeployConfigRef.value = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;
  });

  it("should abort deploy and skip proxy bootstrap when host collision exists", async () => {
    // Set up state with an existing stack that owns "shared.example.com"
    mockDeployStateRef.value = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: false,
      stacks: {
        "existing-app": {
          path: "/opt/fleet/stacks/existing-app",
          compose_file: "docker-compose.yml",
          deployed_at: "2025-01-15T10:30:00.000Z",
          routes: [
            {
              host: "shared.example.com",
              service: "web",
              port: 3000,
              caddy_id: "existing-app__web",
            },
          ],
        },
      },
    };

    // Configure a different stack that claims the same hostname
    mockDeployConfigRef.value = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "new-app", compose_file: "compose.yml" },
      routes: [{ domain: "shared.example.com", port: 8080, tls: true }],
    } as FleetConfig;

    // Intercept process.exit so the test doesn't actually terminate
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      deploy({ skipPull: false, noHealthCheck: false, dryRun: false, force: false })
    ).rejects.toThrow("process.exit(1)");

    // Verify process.exit was called with code 1
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Verify NO bootstrap-related commands were executed.
    // Bootstrap commands include: docker network create, docker compose (for proxy),
    // Caddy API calls (docker exec ... curl), and proxy compose file writes.
    const hasDockerNetworkCreate = capturedDeployExecCommands.some((c) =>
      c.includes("docker network create")
    );
    const hasProxyComposeUp = capturedDeployExecCommands.some(
      (c) => c.includes("docker compose") && c.includes("up")
    );
    const hasCaddyApiCall = capturedDeployExecCommands.some((c) =>
      c.includes("docker exec")
    );
    const hasComposeFileWrite = capturedDeployExecCommands.some(
      (c) => c.includes("FLEET_EOF") || (c.includes("cat") && c.includes("compose.yml") && !c.includes("state.json"))
    );

    expect(hasDockerNetworkCreate).toBe(false);
    expect(hasProxyComposeUp).toBe(false);
    expect(hasCaddyApiCall).toBe(false);
    expect(hasComposeFileWrite).toBe(false);

    // The only command that should have been captured is the state.json read
    expect(capturedDeployExecCommands).toHaveLength(1);
    expect(capturedDeployExecCommands[0]).toContain("state.json");
  });
});
