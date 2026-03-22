import { describe, it, expect } from "vitest";
import type { ExecFn, ExecResult } from "../../src/ssh/types";
import type {
  ParsedComposeFile,
  ParsedService,
} from "../../src/compose/types";
import type { StackState } from "../../src/state/types";
import type { FleetState } from "../../src/state/types";
import type { CandidateHashes } from "../../src/deploy/classify";
import { computeDefinitionHash, computeEnvHash } from "../../src/deploy/hashes";
import { configHasSecrets } from "../../src/deploy/helpers";
import type { FleetConfig } from "../../src/config";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeService(overrides: Partial<ParsedService> = {}): ParsedService {
  return {
    hasImage: true,
    hasBuild: false,
    ports: [],
    image: "nginx:latest",
    restart: "always",
    ...overrides,
  };
}

function makeStackState(
  overrides: Partial<StackState> = {},
): StackState {
  return {
    path: "/opt/fleet/stacks/myapp",
    compose_file: "docker-compose.yml",
    deployed_at: "2025-01-01T00:00:00.000Z",
    routes: [],
    ...overrides,
  };
}

function makeFleetState(
  stacks: Record<string, StackState> = {},
): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks,
  };
}

/**
 * Minimal FleetConfig factory for testing configHasSecrets.
 * Only the `env` field matters; other fields are filled with valid stubs.
 */
function makeConfig(env?: FleetConfig["env"]): FleetConfig {
  return {
    version: "1" as const,
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "docker-compose.yml" },
    routes: [{ domain: "example.com", port: 3000, tls: true }],
    env,
  };
}

function makeExec(hash: string): ExecFn {
  return async (_command: string): Promise<ExecResult> => ({
    code: 0,
    stdout: `${hash}  /opt/fleet/stacks/myapp/.env\n`,
    stderr: "",
  });
}

/**
 * Replicates the Step 10 logic from deploy.ts to build candidateHashes.
 */
function buildCandidateHashes(
  compose: ParsedComposeFile,
): Record<string, CandidateHashes> {
  const candidateHashes: Record<string, CandidateHashes> = {};
  for (const [serviceName, service] of Object.entries(compose.services)) {
    candidateHashes[serviceName] = {
      definitionHash: computeDefinitionHash(service),
      imageDigest: null,
    };
  }
  return candidateHashes;
}

/**
 * Replicates the Step 10 env hash comparison logic from deploy.ts.
 */
async function computeEnvHashChanged(
  exec: ExecFn,
  config: FleetConfig,
  stackDir: string,
  state: FleetState,
): Promise<{ newEnvHash: string | null; envHashChanged: boolean }> {
  const newEnvHash = configHasSecrets(config)
    ? await computeEnvHash(exec, stackDir + "/.env")
    : null;

  const existingStackState = state.stacks[config.stack.name];
  const envHashChanged = newEnvHash !== existingStackState?.env_hash;

  return { newEnvHash, envHashChanged };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hash computation step (Step 10)", () => {
  const stackDir = "/opt/fleet/stacks/myapp";

  // -----------------------------------------------------------------------
  // (a) candidateHashes is correctly built for multiple services
  // -----------------------------------------------------------------------
  describe("candidateHashes construction", () => {
    it("should build candidateHashes with correct definitionHash and null imageDigest for each service", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:1.25" }),
          api: makeService({ image: "node:20", environment: { PORT: "3000" } }),
          worker: makeService({ image: "redis:7" }),
        },
      };

      const candidateHashes = buildCandidateHashes(compose);

      // All services should be present
      expect(Object.keys(candidateHashes)).toEqual(["web", "api", "worker"]);

      // Each entry should have a valid definitionHash and null imageDigest
      for (const [_name, hashes] of Object.entries(candidateHashes)) {
        expect(hashes.definitionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(hashes.imageDigest).toBeNull();
      }
    });

    it("should produce different definitionHash values for services with different definitions", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:1.25" }),
          api: makeService({ image: "node:20", environment: { PORT: "3000" } }),
        },
      };

      const candidateHashes = buildCandidateHashes(compose);

      expect(candidateHashes.web.definitionHash).not.toBe(
        candidateHashes.api.definitionHash,
      );
    });

    it("should produce the same definitionHash for identical services", () => {
      const compose: ParsedComposeFile = {
        services: {
          web1: makeService({ image: "nginx:1.25" }),
          web2: makeService({ image: "nginx:1.25" }),
        },
      };

      const candidateHashes = buildCandidateHashes(compose);

      expect(candidateHashes.web1.definitionHash).toBe(
        candidateHashes.web2.definitionHash,
      );
    });

    it("should handle an empty services object", () => {
      const compose: ParsedComposeFile = { services: {} };

      const candidateHashes = buildCandidateHashes(compose);

      expect(Object.keys(candidateHashes)).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // (b) envHashChanged is true when computed env hash differs from stored
  // -----------------------------------------------------------------------
  describe("envHashChanged — hash differs", () => {
    it("should set envHashChanged to true when the computed env hash differs from stored state", async () => {
      const config = makeConfig([{ key: "SECRET", value: "val" }]);
      const exec = makeExec("aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222");
      const state = makeFleetState({
        myapp: makeStackState({ env_hash: "sha256:oldoldhash0000000000000000000000000000000000000000000000000000" }),
      });

      const { envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(envHashChanged).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // (c) envHashChanged is false when hashes match
  // -----------------------------------------------------------------------
  describe("envHashChanged — hashes match", () => {
    it("should set envHashChanged to false when the computed env hash matches stored state", async () => {
      const hash = "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";
      const config = makeConfig([{ key: "SECRET", value: "val" }]);
      const exec = makeExec(hash);
      const state = makeFleetState({
        myapp: makeStackState({ env_hash: `sha256:${hash}` }),
      });

      const { envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(envHashChanged).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // (d) envHashChanged is true when there is no prior state (first deploy)
  // -----------------------------------------------------------------------
  describe("envHashChanged — no prior state (first deploy)", () => {
    it("should set envHashChanged to true when the stack has no prior state", async () => {
      const config = makeConfig([{ key: "SECRET", value: "val" }]);
      const exec = makeExec("abc123def456abc123def456abc123def456abc123def456abc123def456abcd");
      const state = makeFleetState({}); // no stacks at all

      const { envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(envHashChanged).toBe(true);
    });

    it("should set envHashChanged to true when the stack exists but has no env_hash", async () => {
      const config = makeConfig([{ key: "SECRET", value: "val" }]);
      const exec = makeExec("abc123def456abc123def456abc123def456abc123def456abc123def456abcd");
      const state = makeFleetState({
        myapp: makeStackState(), // env_hash is undefined by default
      });

      const { envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(envHashChanged).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // (e) env hash computation is skipped when config has no secrets
  // -----------------------------------------------------------------------
  describe("envHashChanged — no secrets in config", () => {
    it("should skip env hash computation when config has no env", async () => {
      const config = makeConfig(undefined); // no env at all
      let execCalled = false;
      const exec: ExecFn = async (_command: string): Promise<ExecResult> => {
        execCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      };
      // Stack has no env_hash either — null !== undefined => true
      const state = makeFleetState({
        myapp: makeStackState(),
      });

      const { newEnvHash, envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(newEnvHash).toBeNull();
      expect(execCalled).toBe(false); // exec should not have been called
      // null !== undefined => true in JS
      expect(envHashChanged).toBe(true);
    });

    it("should not call exec when no secrets exist and no prior state", async () => {
      const config = makeConfig(undefined);
      let execCalled = false;
      const exec: ExecFn = async (): Promise<ExecResult> => {
        execCalled = true;
        return { code: 0, stdout: "", stderr: "" };
      };
      const state = makeFleetState({});

      const { newEnvHash, envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(newEnvHash).toBeNull();
      expect(execCalled).toBe(false);
      // null !== undefined => true
      expect(envHashChanged).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // (f) handles missing/undefined stackState.env_hash gracefully
  // -----------------------------------------------------------------------
  describe("envHashChanged — missing/undefined stackState.env_hash", () => {
    it("should handle stackState with explicitly undefined env_hash when secrets exist", async () => {
      const config = makeConfig([{ key: "DB_URL", value: "postgres://..." }]);
      const exec = makeExec("abc123def456abc123def456abc123def456abc123def456abc123def456abcd");
      const state = makeFleetState({
        myapp: makeStackState({ env_hash: undefined }),
      });

      const { envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      // "sha256:abc123..." !== undefined => true
      expect(envHashChanged).toBe(true);
    });

    it("should handle completely missing stack in state", async () => {
      const config = makeConfig([{ key: "API_KEY", value: "secret" }]);
      const exec = makeExec("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
      const state = makeFleetState({}); // stack "myapp" does not exist

      const { envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      // "sha256:1234..." !== undefined => true
      expect(envHashChanged).toBe(true);
    });

    it("should handle computeEnvHash returning null (remote file missing) with no prior state", async () => {
      const config = makeConfig([{ key: "SECRET", value: "val" }]);
      // Simulate sha256sum failing (file not found)
      const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
        code: 1,
        stdout: "",
        stderr: "sha256sum: /opt/fleet/stacks/myapp/.env: No such file or directory",
      });
      const state = makeFleetState({});

      const { newEnvHash, envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(newEnvHash).toBeNull();
      // null !== undefined => true
      expect(envHashChanged).toBe(true);
    });

    it("should handle computeEnvHash returning null when prior state also has no env_hash", async () => {
      const config = makeConfig([{ key: "SECRET", value: "val" }]);
      const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
        code: 1,
        stdout: "",
        stderr: "sha256sum: file not found",
      });
      const state = makeFleetState({
        myapp: makeStackState({ env_hash: undefined }),
      });

      const { newEnvHash, envHashChanged } = await computeEnvHashChanged(
        exec, config, stackDir, state,
      );

      expect(newEnvHash).toBeNull();
      // null !== undefined => true
      expect(envHashChanged).toBe(true);
    });
  });
});
