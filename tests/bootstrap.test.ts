import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExecResult, ExecFn } from "../src/ssh";
import { bootstrap } from "../src/bootstrap";
import { buildBootstrapCommand } from "../src/caddy";

/**
 * Helper to create a mock exec function from a map of command patterns to results.
 * Commands are matched by checking if the command string includes the pattern key.
 * Also captures all commands issued into an array for assertion.
 *
 * IMPORTANT: Pattern order matters — more specific patterns must come before
 * general ones to avoid false matches on overlapping substrings.
 */
function createMockExec(
  handlers: Record<string, ExecResult>
): { exec: ExecFn; commands: string[] } {
  const commands: string[] = [];
  const exec: ExecFn = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    for (const [pattern, result] of Object.entries(handlers)) {
      if (command.includes(pattern)) {
        return result;
      }
    }
    return { code: 1, stdout: "", stderr: `unhandled command: ${command}` };
  };
  return { exec, commands };
}

// Common ExecResult constants

const DEFAULT_STATE: ExecResult = {
  code: 1,
  stdout: "",
  stderr: "No such file or directory",
};

const BOOTSTRAPPED_STATE: ExecResult = {
  code: 0,
  stdout: JSON.stringify({
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {},
  }),
  stderr: "",
};

const UNBOOTSTRAPPED_STATE: ExecResult = {
  code: 0,
  stdout: JSON.stringify({
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: false,
    stacks: {},
  }),
  stderr: "",
};

const SUCCESS: ExecResult = { code: 0, stdout: "", stderr: "" };

describe("bootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("when caddy_bootstrapped is already true", () => {
    it("should skip bootstrap and not execute any further commands", async () => {
      const { exec, commands } = createMockExec({
        "cat ~/.fleet/state.json": BOOTSTRAPPED_STATE,
      });

      await bootstrap(exec, { acme_email: "admin@example.com" });

      // Only command issued should be the state read
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain("cat ~/.fleet/state.json");
    });
  });

  describe("happy path", () => {
    it("should execute all eight steps in order on fresh server", async () => {
      // Pattern order: compose.yml.tmp before mkdir -p /opt/fleet/proxy
      // because writeProxyCompose command contains both patterns
      const { exec, commands } = createMockExec({
        "cat ~/.fleet/state.json": DEFAULT_STATE,
        "mkdir -p /opt/fleet": SUCCESS,
        "echo '/opt/fleet' > ~/.fleet-root": SUCCESS,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": SUCCESS,
        "docker exec fleet-caddy curl -s -f http://localhost:2019/config/": {
          code: 0,
          stdout: "{}",
          stderr: "",
        },
        "docker exec -i fleet-caddy": SUCCESS,
      });

      await bootstrap(exec, { acme_email: "admin@example.com" });

      // Verify key commands were issued
      expect(
        commands.some((c) => c.includes("docker network create fleet-proxy"))
      ).toBe(true);
      expect(
        commands.some((c) => c.includes("mkdir -p /opt/fleet/proxy"))
      ).toBe(true);
      expect(commands.some((c) => c.includes("docker compose -f"))).toBe(true);
      expect(
        commands.some((c) => c.includes("docker exec fleet-caddy curl"))
      ).toBe(true);

      // Verify order: network create comes before compose up, compose up comes before health check
      const networkIdx = commands.findIndex((c) =>
        c.includes("docker network create")
      );
      const composeUpIdx = commands.findIndex((c) =>
        c.includes("docker compose -f")
      );
      const healthIdx = commands.findIndex((c) =>
        c.includes("docker exec fleet-caddy curl")
      );
      const bootstrapCmdIdx = commands.findIndex((c) =>
        c.includes("docker exec -i fleet-caddy")
      );
      expect(networkIdx).toBeLessThan(composeUpIdx);
      expect(composeUpIdx).toBeLessThan(healthIdx);
      expect(healthIdx).toBeLessThan(bootstrapCmdIdx);
    });

    it("should skip resolveFleetRoot when fleet_root is already set", async () => {
      const { exec, commands } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": SUCCESS,
        "docker exec fleet-caddy curl -s -f http://localhost:2019/config/": {
          code: 0,
          stdout: "{}",
          stderr: "",
        },
        "docker exec -i fleet-caddy": SUCCESS,
      });

      await bootstrap(exec, {});

      // Should NOT have called resolveFleetRoot (no "mkdir -p /opt/fleet" without /proxy suffix)
      expect(commands.some((c) => c === "mkdir -p /opt/fleet")).toBe(false);
      // But should have /opt/fleet/proxy
      expect(
        commands.some((c) => c.includes("mkdir -p /opt/fleet/proxy"))
      ).toBe(true);
    });
  });

  describe("Docker network creation", () => {
    it("should tolerate 'already exists' error on network creation", async () => {
      const { exec, commands } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": {
          code: 0,
          stdout: "",
          stderr: "network with name fleet-proxy already exists",
        },
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": SUCCESS,
        "docker exec fleet-caddy curl -s -f http://localhost:2019/config/": {
          code: 0,
          stdout: "{}",
          stderr: "",
        },
        "docker exec -i fleet-caddy": SUCCESS,
      });

      // Should complete without throwing
      await expect(bootstrap(exec, {})).resolves.toBeUndefined();
      expect(
        commands.some((c) => c.includes("docker network create fleet-proxy"))
      ).toBe(true);
    });
  });

  describe("Admin API health check", () => {
    it("should retry health check and succeed after initial failures", async () => {
      let healthCheckAttempts = 0;
      const commands: string[] = [];

      const exec: ExecFn = async (command: string): Promise<ExecResult> => {
        commands.push(command);

        if (command.includes("cat ~/.fleet/state.json"))
          return UNBOOTSTRAPPED_STATE;
        if (command.includes("state.json.tmp")) return SUCCESS;
        if (command.includes("docker network create fleet-proxy"))
          return SUCCESS;
        if (command.includes("compose.yml.tmp")) return SUCCESS;
        if (command.includes("mkdir -p /opt/fleet/proxy")) return SUCCESS;
        if (command.includes("docker compose -f")) return SUCCESS;
        if (
          command.includes(
            "docker exec fleet-caddy curl -s -f http://localhost:2019/config/"
          )
        ) {
          healthCheckAttempts++;
          if (healthCheckAttempts < 3) {
            return { code: 7, stdout: "", stderr: "Connection refused" };
          }
          return { code: 0, stdout: "{}", stderr: "" };
        }
        if (command.includes("docker exec -i fleet-caddy")) return SUCCESS;

        return { code: 1, stdout: "", stderr: `unhandled: ${command}` };
      };

      const promise = bootstrap(exec, {});

      // Advance past the 2 sleep(3000) calls (one after each failed attempt)
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);

      await promise;

      expect(healthCheckAttempts).toBe(3);
      // Verify health check commands were issued multiple times
      const healthChecks = commands.filter((c) =>
        c.includes(
          "docker exec fleet-caddy curl -s -f http://localhost:2019/config/"
        )
      );
      expect(healthChecks).toHaveLength(3);
    });

    it("should throw timeout error when health check exhausts all retries", async () => {
      const exec: ExecFn = async (command: string): Promise<ExecResult> => {
        if (command.includes("cat ~/.fleet/state.json"))
          return UNBOOTSTRAPPED_STATE;
        if (command.includes("state.json.tmp")) return SUCCESS;
        if (command.includes("docker network create fleet-proxy"))
          return SUCCESS;
        if (command.includes("compose.yml.tmp")) return SUCCESS;
        if (command.includes("mkdir -p /opt/fleet/proxy")) return SUCCESS;
        if (command.includes("docker compose -f")) return SUCCESS;
        if (
          command.includes(
            "docker exec fleet-caddy curl -s -f http://localhost:2019/config/"
          )
        ) {
          return { code: 7, stdout: "", stderr: "Connection refused" };
        }
        return { code: 1, stdout: "", stderr: `unhandled: ${command}` };
      };

      const promise = bootstrap(exec, {});

      // Attach a no-op catch to prevent Node from reporting unhandled rejection
      // while we advance timers — the real assertion happens below
      promise.catch(() => {});

      // Advance through all 9 sleep intervals (sleep is called after attempts 1-9, not after attempt 10)
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow(
        "Caddy Admin API did not become healthy after 10 attempts (30s timeout)"
      );
    });
  });

  describe("individual step failures", () => {
    it("should throw descriptive error when proxy directory creation fails", async () => {
      const { exec } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "mkdir -p /opt/fleet/proxy": {
          code: 1,
          stdout: "",
          stderr: "Permission denied",
        },
      });

      await expect(bootstrap(exec, {})).rejects.toThrow(
        "Failed to create proxy directory"
      );

      const { exec: exec2 } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "mkdir -p /opt/fleet/proxy": {
          code: 1,
          stdout: "",
          stderr: "Permission denied",
        },
      });
      await expect(bootstrap(exec2, {})).rejects.toThrow("code 1");
    });

    it("should throw descriptive error when proxy compose write fails", async () => {
      // compose.yml.tmp MUST come before mkdir -p /opt/fleet/proxy
      // because writeProxyCompose command contains both substrings
      const { exec } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": {
          code: 1,
          stdout: "",
          stderr: "disk full",
        },
        "mkdir -p /opt/fleet/proxy": SUCCESS,
      });

      await expect(bootstrap(exec, {})).rejects.toThrow(
        "Failed to write proxy compose file"
      );
    });

    it("should throw descriptive error when Caddy container start fails", async () => {
      const { exec } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": {
          code: 1,
          stdout: "",
          stderr: "no such image",
        },
      });

      await expect(bootstrap(exec, {})).rejects.toThrow(
        "Failed to start Caddy container"
      );

      const { exec: exec2 } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": {
          code: 1,
          stdout: "",
          stderr: "no such image",
        },
      });
      await expect(bootstrap(exec2, {})).rejects.toThrow("no such image");
    });

    it("should throw descriptive error when initial Caddy configuration fails", async () => {
      const { exec } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": SUCCESS,
        "docker exec fleet-caddy curl -s -f http://localhost:2019/config/": {
          code: 0,
          stdout: "{}",
          stderr: "",
        },
        "docker exec -i fleet-caddy": {
          code: 1,
          stdout: "",
          stderr: "bad config",
        },
      });

      await expect(bootstrap(exec, {})).rejects.toThrow(
        "Failed to post initial Caddy configuration"
      );
    });

    it("should throw descriptive error when final state write fails", async () => {
      // writeState is called TWICE (initial state write + final state write).
      // Both commands contain "state.json.tmp". We need the first to succeed and the second to fail.
      let stateWriteCount = 0;
      const exec: ExecFn = async (command: string): Promise<ExecResult> => {
        if (command.includes("cat ~/.fleet/state.json"))
          return UNBOOTSTRAPPED_STATE;
        if (command.includes("state.json.tmp")) {
          stateWriteCount++;
          if (stateWriteCount <= 1) return SUCCESS;
          return { code: 1, stdout: "", stderr: "read-only filesystem" };
        }
        if (command.includes("docker network create fleet-proxy"))
          return SUCCESS;
        if (command.includes("compose.yml.tmp")) return SUCCESS;
        if (command.includes("mkdir -p /opt/fleet/proxy")) return SUCCESS;
        if (command.includes("docker compose -f")) return SUCCESS;
        if (
          command.includes(
            "docker exec fleet-caddy curl -s -f http://localhost:2019/config/"
          )
        ) {
          return { code: 0, stdout: "{}", stderr: "" };
        }
        if (command.includes("docker exec -i fleet-caddy")) return SUCCESS;
        return { code: 1, stdout: "", stderr: `unhandled: ${command}` };
      };

      await expect(bootstrap(exec, {})).rejects.toThrow(
        "Failed to write state file"
      );
    });
  });

  describe("bootstrap command ACME email", () => {
    it("should execute buildBootstrapCommand with the provided acme_email", async () => {
      const { exec, commands } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": SUCCESS,
        "docker exec fleet-caddy curl -s -f http://localhost:2019/config/": {
          code: 0,
          stdout: "{}",
          stderr: "",
        },
        "docker exec -i fleet-caddy": SUCCESS,
      });

      await bootstrap(exec, { acme_email: "test@example.com" });

      const expectedCommand = buildBootstrapCommand({
        acme_email: "test@example.com",
      });
      const bootstrapCmd = commands.find((c) =>
        c.includes("docker exec -i fleet-caddy")
      );
      expect(bootstrapCmd).toBe(expectedCommand);
    });

    it("should execute buildBootstrapCommand without acme_email when not provided", async () => {
      const { exec, commands } = createMockExec({
        "cat ~/.fleet/state.json": UNBOOTSTRAPPED_STATE,
        "state.json.tmp": SUCCESS,
        "docker network create fleet-proxy": SUCCESS,
        "compose.yml.tmp": SUCCESS,
        "mkdir -p /opt/fleet/proxy": SUCCESS,
        "docker compose -f": SUCCESS,
        "docker exec fleet-caddy curl -s -f http://localhost:2019/config/": {
          code: 0,
          stdout: "{}",
          stderr: "",
        },
        "docker exec -i fleet-caddy": SUCCESS,
      });

      await bootstrap(exec, {});

      const expectedCommand = buildBootstrapCommand({
        acme_email: undefined,
      });
      const bootstrapCmd = commands.find((c) =>
        c.includes("docker exec -i fleet-caddy")
      );
      expect(bootstrapCmd).toBe(expectedCommand);
    });
  });
});
