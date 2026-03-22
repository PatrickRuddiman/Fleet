import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExecResult } from "../../src/ssh/types";
import type { FleetState } from "../../src/state/types";
import type { FleetConfig } from "../../src/config/schema";
import type { ParsedComposeFile, ParsedService } from "../../src/compose/types";
import { computeDefinitionHash } from "../../src/deploy/hashes";

// ---------------------------------------------------------------------------
// Hoisted refs — mutated per-test to control mocked behaviour
// ---------------------------------------------------------------------------

const {
  mockStateRef,
  mockConfigRef,
  mockComposeRef,
  capturedCommands,
  mockExecOverrides,
} = vi.hoisted(() => ({
  mockStateRef: { value: {} as FleetState },
  mockConfigRef: { value: {} as FleetConfig },
  mockComposeRef: { value: {} as ParsedComposeFile },
  capturedCommands: [] as string[],
  mockExecOverrides: { value: {} as Record<string, ExecResult> },
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/config", async () => {
  const actual = await vi.importActual<typeof import("../../src/config")>(
    "../../src/config"
  );
  return { ...actual, loadFleetConfig: () => mockConfigRef.value };
});

vi.mock("../../src/compose", async () => {
  const actual = await vi.importActual<typeof import("../../src/compose")>(
    "../../src/compose"
  );
  return {
    ...actual,
    loadComposeFile: () => mockComposeRef.value,
    getServiceNames: () => Object.keys(mockComposeRef.value.services),
  };
});

vi.mock("../../src/validation", () => ({ runAllChecks: () => [] }));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (filePath: string, _encoding?: string) => {
        if (typeof filePath === "string" && filePath.endsWith("compose.yml")) {
          return "services:\n  web:\n    image: nginx:1.25\n";
        }
        if (typeof filePath === "string" && filePath.endsWith("fleet.yml")) {
          return "version: '1'\nserver:\n  host: example.com\nstack:\n  name: myapp\nroutes:\n  - domain: myapp.example.com\n    port: 3000\n";
        }
        return actual.readFileSync(filePath, _encoding as BufferEncoding);
      },
    },
  };
});

vi.mock("../../src/ssh", async () => {
  const actual = await vi.importActual<typeof import("../../src/ssh")>(
    "../../src/ssh"
  );
  return {
    ...actual,
    createConnection: async () => ({
      exec: async (cmd: string) => {
        capturedCommands.push(cmd);
        // Check per-test overrides first
        for (const [pattern, result] of Object.entries(
          mockExecOverrides.value
        )) {
          if (cmd.includes(pattern)) return result;
        }
        // Default handlers
        if (cmd.includes("cat") && cmd.includes("state.json")) {
          return {
            stdout: JSON.stringify(mockStateRef.value),
            stderr: "",
            code: 0,
          };
        }
        if (cmd.includes("sha256sum")) {
          return { stdout: "", stderr: "No such file", code: 1 };
        }
        if (cmd.includes("docker image inspect")) {
          return { stdout: "", stderr: "", code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      streamExec: async () => ({ stdout: "", stderr: "", code: 0 }),
      close: async () => {},
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseService(overrides: Partial<ParsedService> = {}): ParsedService {
  return {
    hasImage: true,
    hasBuild: false,
    ports: [],
    image: "nginx:1.25",
    restart: "always",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("selective deploy execution (step 11)", () => {
  const stackName = "myapp";
  const stackDir = "/opt/fleet/stacks/myapp";

  beforeEach(() => {
    capturedCommands.length = 0;
    mockExecOverrides.value = {};

    mockConfigRef.value = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: stackName, compose_file: "compose.yml" },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    mockStateRef.value = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {},
    };

    mockComposeRef.value = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
        api: baseService({ image: "node:20-alpine" }),
        db: baseService({ image: "postgres:16" }),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Lazy-load deploy to ensure mocks are in place
  // -----------------------------------------------------------------------
  async function runDeploy(options: {
    skipPull: boolean;
    noHealthCheck: boolean;
    dryRun: boolean;
    force: boolean;
  }) {
    const { deploy } = await import("../../src/deploy/deploy");
    return deploy(options);
  }

  // -----------------------------------------------------------------------
  // 1. Force mode runs blanket `docker compose up -d --remove-orphans`
  // -----------------------------------------------------------------------
  it("force mode runs the blanket docker compose up -d --remove-orphans command", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runDeploy({
      skipPull: true,
      noHealthCheck: true,
      dryRun: false,
      force: true,
    });

    // Find the up -d --remove-orphans command
    const upCmd = capturedCommands.find((c) =>
      c.includes("up -d --remove-orphans")
    );
    expect(upCmd).toBeDefined();
    expect(upCmd).toContain(`docker compose -p ${stackName}`);
    expect(upCmd).toContain(`-f ${stackDir}/compose.yml`);
    expect(upCmd).toContain("up -d --remove-orphans");

    // Should NOT have per-service up commands
    const perServiceUp = capturedCommands.filter(
      (c) =>
        c.includes("up -d") &&
        !c.includes("--remove-orphans") &&
        c.includes("docker compose")
    );
    expect(perServiceUp).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 2. Selective mode runs per-service `up -d <service>` for toDeploy
  // -----------------------------------------------------------------------
  it("selective mode runs per-service docker compose up -d for toDeploy services", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    // No existing stack state => all services are "new" => toDeploy
    await runDeploy({
      skipPull: true,
      noHealthCheck: true,
      dryRun: false,
      force: false,
    });

    // Should have per-service up commands for each service
    const upCommands = capturedCommands.filter(
      (c) =>
        c.includes("up -d") && c.includes(`docker compose -p ${stackName}`)
    );
    expect(upCommands.some((c) => c.includes("up -d web"))).toBe(true);
    expect(upCommands.some((c) => c.includes("up -d api"))).toBe(true);
    expect(upCommands.some((c) => c.includes("up -d db"))).toBe(true);

    // Should NOT have blanket --remove-orphans
    const blanketUp = capturedCommands.find((c) =>
      c.includes("--remove-orphans")
    );
    expect(blanketUp).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 3. Selective mode runs `docker compose restart <service>` for toRestart
  // -----------------------------------------------------------------------
  it("selective mode runs docker compose restart for toRestart services", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const webService = baseService({ image: "nginx:1.25" });
    const apiService = baseService({ image: "node:20-alpine" });

    mockComposeRef.value = {
      services: { web: webService, api: apiService },
    };

    // Set up stack state with matching definition hashes so services are NOT new
    mockStateRef.value = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {
        myapp: {
          path: stackDir,
          compose_file: "compose.yml",
          deployed_at: "2025-01-01T00:00:00.000Z",
          routes: [],
          env_hash: "sha256:oldhash",
          services: {
            web: {
              definition_hash: computeDefinitionHash(webService),
              image_digest: "sha256:bbb",
              env_hash: "sha256:ccc",
              deployed_at: "2025-01-01T00:00:00.000Z",
              one_shot: false,
              status: "running",
            },
            api: {
              definition_hash: computeDefinitionHash(apiService),
              image_digest: "sha256:ddd",
              env_hash: "sha256:ccc",
              deployed_at: "2025-01-01T00:00:00.000Z",
              one_shot: false,
              status: "running",
            },
          },
        },
      },
    };

    // Make sha256sum return a DIFFERENT hash so envHashChanged = true
    mockExecOverrides.value = {
      sha256sum: {
        stdout: "newhash  /opt/fleet/stacks/myapp/.env\n",
        stderr: "",
        code: 0,
      },
    };

    await runDeploy({
      skipPull: true,
      noHealthCheck: true,
      dryRun: false,
      force: false,
    });

    // Both services should be restarted (matching hashes + envHashChanged)
    const restartCommands = capturedCommands.filter(
      (c) =>
        c.includes("restart") &&
        c.includes(`docker compose -p ${stackName}`)
    );
    expect(restartCommands.some((c) => c.includes("restart web"))).toBe(true);
    expect(restartCommands.some((c) => c.includes("restart api"))).toBe(true);

    // Should NOT have per-service up commands (no toDeploy services)
    const upCommands = capturedCommands.filter(
      (c) => c.includes("up -d") && !c.includes("--remove-orphans")
    );
    expect(upCommands).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 4. Selective mode logs skip messages for toSkip services
  // -----------------------------------------------------------------------
  it("selective mode logs skip messages for toSkip services", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const dbService = baseService({ image: "postgres:16" });
    const cacheService = baseService({ image: "redis:7" });

    mockComposeRef.value = {
      services: { db: dbService, cache: cacheService },
    };

    // Set up state with matching hashes
    mockStateRef.value = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {
        myapp: {
          path: stackDir,
          compose_file: "compose.yml",
          deployed_at: "2025-01-01T00:00:00.000Z",
          routes: [],
          services: {
            db: {
              definition_hash: computeDefinitionHash(dbService),
              image_digest: "sha256:aaa",
              env_hash: "sha256:ccc",
              deployed_at: "2025-01-01T00:00:00.000Z",
              one_shot: false,
              status: "running",
            },
            cache: {
              definition_hash: computeDefinitionHash(cacheService),
              image_digest: "sha256:bbb",
              env_hash: "sha256:ccc",
              deployed_at: "2025-01-01T00:00:00.000Z",
              one_shot: false,
              status: "running",
            },
          },
        },
      },
    };

    // sha256sum returns error (default), so envHashChanged = false
    // All hashes match => toSkip

    await runDeploy({
      skipPull: true,
      noHealthCheck: true,
      dryRun: false,
      force: false,
    });

    // Check log messages for skip
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("⊘ db — no changes detected, skipped")
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("⊘ cache — no changes detected, skipped")
    );

    // No up or restart commands for these services in step 11
    const upCommands = capturedCommands.filter(
      (c) =>
        c.includes("up -d") &&
        c.includes(`docker compose -p ${stackName}`) &&
        !c.includes("--remove-orphans")
    );
    expect(upCommands).toHaveLength(0);
    const restartCommands = capturedCommands.filter(
      (c) =>
        c.includes("restart") &&
        c.includes(`docker compose -p ${stackName}`)
    );
    expect(restartCommands).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 5a. --env-file flag is included when config has secrets
  // -----------------------------------------------------------------------
  it("includes --env-file flag in selective up commands when config has secrets", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockConfigRef.value = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      env: [{ key: "DB_HOST", value: "localhost" }],
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    mockComposeRef.value = {
      services: { web: baseService({ image: "nginx:1.25" }) },
    };

    // No existing stack state => web is toDeploy
    await runDeploy({
      skipPull: true,
      noHealthCheck: true,
      dryRun: false,
      force: false,
    });

    const upCmd = capturedCommands.find(
      (c) => c.includes("up -d web") && c.includes("docker compose")
    );
    expect(upCmd).toBeDefined();
    expect(upCmd).toContain("--env-file");
    expect(upCmd).toContain(`${stackDir}/.env`);
  });

  // -----------------------------------------------------------------------
  // 5b. --env-file flag is excluded when config has no secrets
  // -----------------------------------------------------------------------
  it("excludes --env-file flag in selective up commands when config has no secrets", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockConfigRef.value = {
      version: "1" as const,
      server: { host: "example.com", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "compose.yml" },
      routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
    } as FleetConfig;

    mockComposeRef.value = {
      services: { web: baseService({ image: "nginx:1.25" }) },
    };

    await runDeploy({
      skipPull: true,
      noHealthCheck: true,
      dryRun: false,
      force: false,
    });

    const upCmd = capturedCommands.find(
      (c) => c.includes("up -d web") && c.includes("docker compose")
    );
    expect(upCmd).toBeDefined();
    expect(upCmd).not.toContain("--env-file");
  });

  // -----------------------------------------------------------------------
  // 6a. Error from per-service up command is properly thrown
  // -----------------------------------------------------------------------
  it("throws error when a per-service up command fails", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    mockComposeRef.value = {
      services: { web: baseService({ image: "nginx:1.25" }) },
    };

    // Make the up command fail
    mockExecOverrides.value = {
      "up -d web": {
        stdout: "",
        stderr: "container start failed",
        code: 1,
      },
    };

    await expect(
      runDeploy({
        skipPull: true,
        noHealthCheck: true,
        dryRun: false,
        force: false,
      })
    ).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to deploy service web: container start failed"
      )
    );
  });

  // -----------------------------------------------------------------------
  // 6b. Error from restart command is properly thrown
  // -----------------------------------------------------------------------
  it("throws error when a restart command fails", async () => {
    vi.spyOn(process, "exit").mockImplementation(
      (() => {
        throw new Error("process.exit");
      }) as never
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const webService = baseService({ image: "nginx:1.25" });
    mockComposeRef.value = {
      services: { web: webService },
    };

    // Set up matching state so web goes to toRestart (need envHashChanged = true)
    mockStateRef.value = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {
        myapp: {
          path: stackDir,
          compose_file: "compose.yml",
          deployed_at: "2025-01-01T00:00:00.000Z",
          routes: [],
          env_hash: "sha256:oldhash",
          services: {
            web: {
              definition_hash: computeDefinitionHash(webService),
              image_digest: "sha256:bbb",
              env_hash: "sha256:ccc",
              deployed_at: "2025-01-01T00:00:00.000Z",
              one_shot: false,
              status: "running",
            },
          },
        },
      },
    };

    mockExecOverrides.value = {
      sha256sum: {
        stdout: "newhash  /opt/fleet/stacks/myapp/.env\n",
        stderr: "",
        code: 0,
      },
      "restart web": {
        stdout: "",
        stderr: "service unresponsive",
        code: 1,
      },
    };

    await expect(
      runDeploy({
        skipPull: true,
        noHealthCheck: true,
        dryRun: false,
        force: false,
      })
    ).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to restart service web: service unresponsive"
      )
    );
  });
});
