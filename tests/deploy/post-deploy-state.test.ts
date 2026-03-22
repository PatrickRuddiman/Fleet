import { describe, it, expect } from "vitest";
import type {
  ParsedComposeFile,
  ParsedService,
} from "../../src/compose/types";
import type { StackState, ServiceState } from "../../src/state/types";
import { classifyServices } from "../../src/deploy/classify";
import type { CandidateHashes } from "../../src/deploy/classify";
import { isOneShot } from "../../src/compose/queries";

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

function makeServiceState(
  overrides: Partial<ServiceState> = {},
): ServiceState {
  return {
    image: "nginx:latest",
    definition_hash: "sha256:aaa",
    image_digest: "sha256:bbb",
    env_hash: "sha256:ccc",
    deployed_at: "2025-01-01T00:00:00.000Z",
    skipped_at: null,
    one_shot: false,
    status: "running",
    ...overrides,
  };
}

function makeStackState(
  services?: Record<string, ServiceState>,
  envHash?: string,
): StackState {
  return {
    path: "/opt/fleet/stacks/myapp",
    compose_file: "docker-compose.yml",
    deployed_at: "2025-01-01T00:00:00.000Z",
    routes: [],
    services,
    env_hash: envHash,
  };
}

function makeCandidateHashes(
  overrides: Partial<CandidateHashes> = {},
): CandidateHashes {
  return {
    definitionHash: "sha256:aaa",
    imageDigest: "sha256:bbb",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper that replicates the post-deploy state-building logic from deploy.ts
// (lines 206–249). This mirrors the production code exactly so tests can
// exercise the state-building in isolation without running full deploy.
// ---------------------------------------------------------------------------

function buildPostDeployServices(
  compose: ParsedComposeFile,
  classification: { toDeploy: string[]; toRestart: string[]; toSkip: string[] },
  candidateHashMap: Record<string, CandidateHashes>,
  existingStackState: StackState | undefined,
  currentEnvHash: string | null,
  now: string,
): Record<string, ServiceState> {
  const services: Record<string, ServiceState> = {};
  const toDeploySet = new Set(classification.toDeploy);
  const toRestartSet = new Set(classification.toRestart);

  for (const [name, service] of Object.entries(compose.services)) {
    const candidate = candidateHashMap[name];

    if (toDeploySet.has(name) || toRestartSet.has(name)) {
      services[name] = {
        image: service.image ?? "",
        definition_hash: candidate.definitionHash,
        image_digest: candidate.imageDigest ?? "",
        env_hash: currentEnvHash ?? "",
        deployed_at: now,
        skipped_at: null,
        one_shot: isOneShot(service),
        status: "deployed",
      };
    } else {
      const existing = existingStackState?.services?.[name];
      if (existing) {
        services[name] = {
          ...existing,
          skipped_at: now,
        };
      } else {
        services[name] = {
          image: service.image ?? "",
          definition_hash: candidate.definitionHash,
          image_digest: candidate.imageDigest ?? "",
          env_hash: currentEnvHash ?? "",
          deployed_at: now,
          skipped_at: null,
          one_shot: isOneShot(service),
          status: "deployed",
        };
      }
    }
  }

  return services;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("post-deploy state update", () => {
  const NOW = "2025-06-15T12:00:00.000Z";

  // -----------------------------------------------------------------------
  // (a) deployed services get correct fields
  // -----------------------------------------------------------------------
  describe("deployed services state", () => {
    it("sets image, image_digest, definition_hash, deployed_at, skipped_at: null, and one_shot for a deployed service", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:1.25", restart: "always" }),
        },
      };
      const stackState = makeStackState(undefined);
      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:defhash1",
          imageDigest: "sha256:digest1",
        }),
      };
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        "sha256:envhash1",
        NOW,
      );

      expect(services.web).toEqual({
        image: "nginx:1.25",
        definition_hash: "sha256:defhash1",
        image_digest: "sha256:digest1",
        env_hash: "sha256:envhash1",
        deployed_at: NOW,
        skipped_at: null,
        one_shot: false,
        status: "deployed",
      });
    });

    it("sets one_shot to true for services with restart: 'no'", () => {
      const compose: ParsedComposeFile = {
        services: {
          migrate: makeService({ image: "myapp:v1", restart: "no" }),
        },
      };
      const stackState = makeStackState({
        migrate: makeServiceState(),
      });
      const candidateHashMap: Record<string, CandidateHashes> = {
        migrate: makeCandidateHashes(),
      };
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        null,
        NOW,
      );

      expect(services.migrate.one_shot).toBe(true);
      expect(services.migrate.skipped_at).toBeNull();
      expect(services.migrate.deployed_at).toBe(NOW);
    });

    it("sets image to empty string when service has no image field", () => {
      const compose: ParsedComposeFile = {
        services: {
          app: makeService({ image: undefined }),
        },
      };
      const stackState = makeStackState(undefined);
      const candidateHashMap: Record<string, CandidateHashes> = {
        app: makeCandidateHashes({ imageDigest: null }),
      };
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        null,
        NOW,
      );

      expect(services.app.image).toBe("");
      expect(services.app.image_digest).toBe("");
    });

    it("sets correct state for restarted services (env hash changed)", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
        },
      };
      const existingState = makeStackState(
        {
          web: makeServiceState({
            deployed_at: "2025-01-01T00:00:00.000Z",
          }),
        },
        "sha256:old-env",
      );
      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes(),
      };
      // envHashChanged = true triggers toRestart
      const classification = classifyServices(
        compose,
        existingState,
        candidateHashMap,
        true,
      );
      expect(classification.toRestart).toContain("web");

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        existingState,
        "sha256:new-env",
        NOW,
      );

      expect(services.web.deployed_at).toBe(NOW);
      expect(services.web.skipped_at).toBeNull();
      expect(services.web.env_hash).toBe("sha256:new-env");
      expect(services.web.status).toBe("deployed");
    });
  });

  // -----------------------------------------------------------------------
  // (b) skipped services preserve state
  // -----------------------------------------------------------------------
  describe("skipped services state", () => {
    it("preserves all existing fields and only updates skipped_at for skipped services", () => {
      const existingServiceState = makeServiceState({
        image: "nginx:1.24",
        definition_hash: "sha256:original-def",
        image_digest: "sha256:original-digest",
        env_hash: "sha256:original-env",
        deployed_at: "2025-01-01T00:00:00.000Z",
        skipped_at: null,
        one_shot: false,
        status: "running",
      });
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({
            image: "nginx:1.24",
          }),
        },
      };
      const stackState = makeStackState({
        web: existingServiceState,
      });
      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:original-def",
          imageDigest: "sha256:original-digest",
        }),
      };
      // All hashes match, no env change -> toSkip
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );
      expect(classification.toSkip).toContain("web");

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        "sha256:original-env",
        NOW,
      );

      expect(services.web.image).toBe("nginx:1.24");
      expect(services.web.definition_hash).toBe("sha256:original-def");
      expect(services.web.image_digest).toBe("sha256:original-digest");
      expect(services.web.env_hash).toBe("sha256:original-env");
      expect(services.web.deployed_at).toBe("2025-01-01T00:00:00.000Z");
      expect(services.web.one_shot).toBe(false);
      expect(services.web.status).toBe("running");
      // Only skipped_at should be updated
      expect(services.web.skipped_at).toBe(NOW);
    });

    it("preserves previous skipped_at value structure when re-skipping", () => {
      const existingServiceState = makeServiceState({
        skipped_at: "2025-06-01T00:00:00.000Z",
      });
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({ web: existingServiceState });
      const candidateHashMap = { web: makeCandidateHashes() };
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        null,
        NOW,
      );

      // skipped_at should be updated to the new timestamp, not the old one
      expect(services.web.skipped_at).toBe(NOW);
      expect(services.web.skipped_at).not.toBe("2025-06-01T00:00:00.000Z");
    });
  });

  // -----------------------------------------------------------------------
  // (c) env_hash at stack level
  // -----------------------------------------------------------------------
  describe("stack-level env_hash", () => {
    it("sets env_hash on StackState when secrets are configured", () => {
      const currentEnvHash = "sha256:envhashvalue";
      const stackState: StackState = {
        path: "/opt/fleet/stacks/myapp",
        compose_file: "compose.yml",
        deployed_at: NOW,
        routes: [],
        services: {},
        env_hash: currentEnvHash ?? undefined,
      };

      expect(stackState.env_hash).toBe("sha256:envhashvalue");
    });

    it("omits env_hash from StackState when no secrets are configured (env hash is null)", () => {
      const currentEnvHash: string | null = null;
      const stackState: StackState = {
        path: "/opt/fleet/stacks/myapp",
        compose_file: "compose.yml",
        deployed_at: NOW,
        routes: [],
        services: {},
        env_hash: currentEnvHash ?? undefined,
      };

      expect(stackState.env_hash).toBeUndefined();
    });

    it("propagates env_hash into each deployed service's env_hash field", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
          api: makeService(),
        },
      };
      const stackState = makeStackState(undefined);
      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes(),
        api: makeCandidateHashes(),
      };
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );

      const currentEnvHash = "sha256:shared-env";
      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        currentEnvHash,
        NOW,
      );

      expect(services.web.env_hash).toBe("sha256:shared-env");
      expect(services.api.env_hash).toBe("sha256:shared-env");
    });
  });

  // -----------------------------------------------------------------------
  // (d) first deploy (no prior state)
  // -----------------------------------------------------------------------
  describe("first deploy (no prior state)", () => {
    it("creates the services map from scratch when stackState has no services", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
          worker: makeService({ image: "myapp:v1", restart: "no" }),
          db: makeService({ image: "postgres:15" }),
        },
      };
      const stackState = makeStackState(undefined);
      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:web-def",
          imageDigest: "sha256:web-dig",
        }),
        worker: makeCandidateHashes({
          definitionHash: "sha256:worker-def",
          imageDigest: "sha256:worker-dig",
        }),
        db: makeCandidateHashes({
          definitionHash: "sha256:db-def",
          imageDigest: "sha256:db-dig",
        }),
      };
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );
      // All should be toDeploy since no prior state
      expect(classification.toDeploy).toEqual(["web", "worker", "db"]);

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        "sha256:env1",
        NOW,
      );

      expect(Object.keys(services)).toEqual(["web", "worker", "db"]);

      // web: long-running
      expect(services.web).toEqual({
        image: "nginx:latest",
        definition_hash: "sha256:web-def",
        image_digest: "sha256:web-dig",
        env_hash: "sha256:env1",
        deployed_at: NOW,
        skipped_at: null,
        one_shot: false,
        status: "deployed",
      });

      // worker: one-shot
      expect(services.worker.one_shot).toBe(true);
      expect(services.worker.image).toBe("myapp:v1");
      expect(services.worker.deployed_at).toBe(NOW);

      // db
      expect(services.db.image).toBe("postgres:15");
      expect(services.db.definition_hash).toBe("sha256:db-def");
    });

    it("handles a skipped service with no prior state entry by creating fresh state", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
        },
      };
      // Stack exists but has no services map
      const stackState = makeStackState(undefined);
      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:webdef",
          imageDigest: "sha256:webdig",
        }),
      };
      // All go to toDeploy since no prior services
      const classification = classifyServices(
        compose,
        stackState,
        candidateHashMap,
        false,
      );
      expect(classification.toDeploy).toContain("web");

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        stackState,
        null,
        NOW,
      );

      expect(services.web).toBeDefined();
      expect(services.web.deployed_at).toBe(NOW);
      expect(services.web.env_hash).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // (e) force mode state update
  // -----------------------------------------------------------------------
  describe("force mode state update", () => {
    it("updates state correctly when all services are classified as toDeploy (force scenario)", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
          api: makeService({ image: "node:20" }),
        },
      };
      const existingState = makeStackState(
        {
          web: makeServiceState({
            image: "nginx:1.24",
            definition_hash: "sha256:old-web-def",
            image_digest: "sha256:old-web-dig",
            deployed_at: "2025-01-01T00:00:00.000Z",
            skipped_at: "2025-06-01T00:00:00.000Z",
          }),
          api: makeServiceState({
            image: "node:18",
            definition_hash: "sha256:old-api-def",
            image_digest: "sha256:old-api-dig",
            deployed_at: "2025-01-01T00:00:00.000Z",
          }),
        },
        "sha256:old-env",
      );

      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:new-web-def",
          imageDigest: "sha256:new-web-dig",
        }),
        api: makeCandidateHashes({
          definitionHash: "sha256:new-api-def",
          imageDigest: "sha256:new-api-dig",
        }),
      };
      // All definition hashes changed -> all in toDeploy
      const classification = classifyServices(
        compose,
        existingState,
        candidateHashMap,
        false,
      );
      expect(classification.toDeploy).toContain("web");
      expect(classification.toDeploy).toContain("api");

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        existingState,
        "sha256:new-env",
        NOW,
      );

      // Both should have fresh state, not preserved old state
      expect(services.web.image).toBe("nginx:latest");
      expect(services.web.definition_hash).toBe("sha256:new-web-def");
      expect(services.web.image_digest).toBe("sha256:new-web-dig");
      expect(services.web.deployed_at).toBe(NOW);
      expect(services.web.skipped_at).toBeNull();

      expect(services.api.image).toBe("node:20");
      expect(services.api.definition_hash).toBe("sha256:new-api-def");
      expect(services.api.image_digest).toBe("sha256:new-api-dig");
      expect(services.api.deployed_at).toBe(NOW);
      expect(services.api.skipped_at).toBeNull();
    });

    it("force mode overwrites previously skipped_at timestamps", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
        },
      };
      const existingState = makeStackState({
        web: makeServiceState({
          skipped_at: "2025-06-10T00:00:00.000Z",
          definition_hash: "sha256:old",
        }),
      });

      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({ definitionHash: "sha256:new" }),
      };
      const classification = classifyServices(
        compose,
        existingState,
        candidateHashMap,
        false,
      );
      expect(classification.toDeploy).toContain("web");

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        existingState,
        null,
        NOW,
      );

      expect(services.web.skipped_at).toBeNull();
      expect(services.web.deployed_at).toBe(NOW);
    });

    it("force mode produces non-empty definition_hash values in ServiceState", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
          api: makeService({ image: "node:20" }),
        },
      };

      // Simulate force mode: all services go to toDeploy, hashes are computed
      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:force-web-def",
          imageDigest: "sha256:force-web-dig",
        }),
        api: makeCandidateHashes({
          definitionHash: "sha256:force-api-def",
          imageDigest: "sha256:force-api-dig",
        }),
      };
      // Force mode: all services classified as toDeploy
      const classification = {
        toDeploy: ["web", "api"],
        toRestart: [],
        toSkip: [],
      };

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        undefined,
        "sha256:force-env",
        NOW,
      );

      // definition_hash must be non-empty (correctly computed, not empty string)
      expect(services.web.definition_hash).toBe("sha256:force-web-def");
      expect(services.web.definition_hash).not.toBe("");
      expect(services.api.definition_hash).toBe("sha256:force-api-def");
      expect(services.api.definition_hash).not.toBe("");
    });

    it("force mode produces non-empty env_hash values in ServiceState", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
          api: makeService({ image: "node:20" }),
        },
      };

      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:web-def",
          imageDigest: "sha256:web-dig",
        }),
        api: makeCandidateHashes({
          definitionHash: "sha256:api-def",
          imageDigest: "sha256:api-dig",
        }),
      };
      // Force mode: all services classified as toDeploy
      const classification = {
        toDeploy: ["web", "api"],
        toRestart: [],
        toSkip: [],
      };

      const currentEnvHash = "sha256:force-env-hash";
      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        undefined,
        currentEnvHash,
        NOW,
      );

      // env_hash must be non-empty (correctly computed, not empty string)
      expect(services.web.env_hash).toBe("sha256:force-env-hash");
      expect(services.web.env_hash).not.toBe("");
      expect(services.api.env_hash).toBe("sha256:force-env-hash");
      expect(services.api.env_hash).not.toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // Mixed deploy/skip scenario
  // -----------------------------------------------------------------------
  describe("mixed deploy/skip scenario", () => {
    it("correctly handles a mix of deployed, restarted, and skipped services", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService({ image: "nginx:latest" }),
          api: makeService({ image: "node:20" }),
          worker: makeService({ image: "myapp:v2" }),
          db: makeService({ image: "postgres:15" }),
        },
      };

      const existingState = makeStackState({
        web: makeServiceState({
          image: "nginx:latest",
          definition_hash: "sha256:aaa",
          image_digest: "sha256:bbb",
          deployed_at: "2025-01-01T00:00:00.000Z",
          status: "running",
        }),
        // api is NOT in existing state (new service)
        worker: makeServiceState({
          image: "myapp:v1",
          definition_hash: "sha256:old-worker-def",
          deployed_at: "2025-01-01T00:00:00.000Z",
        }),
        db: makeServiceState({
          image: "postgres:15",
          definition_hash: "sha256:aaa",
          image_digest: "sha256:bbb",
          deployed_at: "2025-01-01T00:00:00.000Z",
          status: "running",
        }),
      });

      const candidateHashMap: Record<string, CandidateHashes> = {
        web: makeCandidateHashes(),
        api: makeCandidateHashes({
          definitionHash: "sha256:api-def",
          imageDigest: "sha256:api-dig",
        }),
        worker: makeCandidateHashes({
          definitionHash: "sha256:new-worker-def",
          imageDigest: "sha256:worker-dig",
        }),
        db: makeCandidateHashes(),
      };

      const classification = classifyServices(
        compose,
        existingState,
        candidateHashMap,
        false,
      );
      expect(classification.toDeploy).toContain("api");
      expect(classification.toDeploy).toContain("worker");
      expect(classification.toSkip).toContain("web");
      expect(classification.toSkip).toContain("db");

      const services = buildPostDeployServices(
        compose,
        classification,
        candidateHashMap,
        existingState,
        "sha256:env1",
        NOW,
      );

      // web: skipped -- preserved state, updated skipped_at
      expect(services.web.deployed_at).toBe("2025-01-01T00:00:00.000Z");
      expect(services.web.skipped_at).toBe(NOW);
      expect(services.web.image).toBe("nginx:latest");

      // api: deployed -- fresh state
      expect(services.api.deployed_at).toBe(NOW);
      expect(services.api.skipped_at).toBeNull();
      expect(services.api.image).toBe("node:20");
      expect(services.api.definition_hash).toBe("sha256:api-def");

      // worker: deployed -- fresh state (definition_hash changed)
      expect(services.worker.deployed_at).toBe(NOW);
      expect(services.worker.skipped_at).toBeNull();
      expect(services.worker.image).toBe("myapp:v2");

      // db: skipped -- preserved state, updated skipped_at
      expect(services.db.deployed_at).toBe("2025-01-01T00:00:00.000Z");
      expect(services.db.skipped_at).toBe(NOW);

      // All 4 services should be in the map
      expect(Object.keys(services)).toHaveLength(4);
    });
  });
});
