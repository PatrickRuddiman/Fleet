import { describe, it, expect } from "vitest";
import type {
  ParsedComposeFile,
  ParsedService,
} from "../../src/compose/types";
import type { StackState, ServiceState } from "../../src/state/types";
import {
  classifyServices,
} from "../../src/deploy/classify";
import type {
  CandidateHashes,
  ServiceClassification,
} from "../../src/deploy/classify";

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
): StackState {
  return {
    path: "/opt/fleet/myapp",
    compose_file: "docker-compose.yml",
    deployed_at: "2025-01-01T00:00:00.000Z",
    routes: [],
    services,
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
// Tests
// ---------------------------------------------------------------------------

describe("classifyServices", () => {
  // -----------------------------------------------------------------------
  // toDeploy classification
  // -----------------------------------------------------------------------
  describe("toDeploy classification", () => {
    it("classifies a one-shot service into toDeploy regardless of hash matches", () => {
      const compose: ParsedComposeFile = {
        services: {
          migrate: makeService({ restart: "no" }),
        },
      };
      const stackState = makeStackState({
        migrate: makeServiceState(),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        migrate: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).toContain("migrate");
      expect(result.toRestart).not.toContain("migrate");
      expect(result.toSkip).not.toContain("migrate");
    });

    it("classifies a new service (not in stackState) into toDeploy", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({
        other: makeServiceState(),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).toContain("web");
      expect(result.toRestart).not.toContain("web");
      expect(result.toSkip).not.toContain("web");
    });

    it("classifies a service with changed definition_hash into toDeploy", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({
        web: makeServiceState({ definition_hash: "sha256:old" }),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({ definitionHash: "sha256:new" }),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).toContain("web");
      expect(result.toRestart).not.toContain("web");
      expect(result.toSkip).not.toContain("web");
    });

    it("classifies a service with changed image_digest into toDeploy", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({
        web: makeServiceState({
          definition_hash: "sha256:aaa",
          image_digest: "sha256:old-digest",
        }),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:aaa",
          imageDigest: "sha256:new-digest",
        }),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).toContain("web");
      expect(result.toRestart).not.toContain("web");
      expect(result.toSkip).not.toContain("web");
    });
  });

  // -----------------------------------------------------------------------
  // toRestart classification
  // -----------------------------------------------------------------------
  describe("toRestart classification", () => {
    it("classifies a service into toRestart when only envHashChanged is true", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({
        web: makeServiceState(),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, true);

      expect(result.toRestart).toContain("web");
      expect(result.toDeploy).not.toContain("web");
      expect(result.toSkip).not.toContain("web");
    });
  });

  // -----------------------------------------------------------------------
  // toSkip classification
  // -----------------------------------------------------------------------
  describe("toSkip classification", () => {
    it("classifies a service with no changes into toSkip", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({
        web: makeServiceState(),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toSkip).toContain("web");
      expect(result.toDeploy).not.toContain("web");
      expect(result.toRestart).not.toContain("web");
    });
  });

  // -----------------------------------------------------------------------
  // null image_digest handling
  // -----------------------------------------------------------------------
  describe("null image_digest handling", () => {
    it("does not trigger deploy when image_digest is null on both sides", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({
        web: makeServiceState({
          definition_hash: "sha256:aaa",
          image_digest: "sha256:something",
        }),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:aaa",
          imageDigest: null,
        }),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).not.toContain("web");
      expect(result.toSkip).toContain("web");
    });

    it("does not trigger deploy when candidate imageDigest is null even if stored differs", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };
      const stackState = makeStackState({
        web: makeServiceState({
          definition_hash: "sha256:aaa",
          image_digest: "sha256:stored-digest",
        }),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes({
          definitionHash: "sha256:aaa",
          imageDigest: null,
        }),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).not.toContain("web");
      expect(result.toSkip).toContain("web");
    });
  });

  // -----------------------------------------------------------------------
  // missing services block on StackState
  // -----------------------------------------------------------------------
  describe("missing services block on StackState", () => {
    it("treats all services as new when stackState.services is undefined", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
          api: makeService(),
          worker: makeService(),
        },
      };
      const stackState = makeStackState(undefined);
      const candidateHashes: Record<string, CandidateHashes> = {
        web: makeCandidateHashes(),
        api: makeCandidateHashes(),
        worker: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).toContain("web");
      expect(result.toDeploy).toContain("api");
      expect(result.toDeploy).toContain("worker");
      expect(result.toRestart).toHaveLength(0);
      expect(result.toSkip).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // empty compose file
  // -----------------------------------------------------------------------
  describe("empty compose file", () => {
    it("returns empty arrays when compose has no services", () => {
      const compose: ParsedComposeFile = {
        services: {},
      };
      const stackState = makeStackState({
        web: makeServiceState(),
      });
      const candidateHashes: Record<string, CandidateHashes> = {};

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).toHaveLength(0);
      expect(result.toRestart).toHaveLength(0);
      expect(result.toSkip).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // mixed classification
  // -----------------------------------------------------------------------
  describe("mixed classification", () => {
    it("correctly classifies multiple services with envHashChanged true", () => {
      const compose: ParsedComposeFile = {
        services: {
          migrate: makeService({ restart: "no" }),
          web: makeService(),
          api: makeService(),
          worker: makeService(),
        },
      };
      const stackState = makeStackState({
        migrate: makeServiceState(),
        web: makeServiceState({ definition_hash: "sha256:old" }),
        // api is NOT in stackState → new service
        worker: makeServiceState(),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        migrate: makeCandidateHashes(),
        web: makeCandidateHashes({ definitionHash: "sha256:new" }),
        api: makeCandidateHashes(),
        worker: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, true);

      // one-shot → toDeploy
      expect(result.toDeploy).toContain("migrate");
      // definition_hash changed → toDeploy
      expect(result.toDeploy).toContain("web");
      // new service → toDeploy
      expect(result.toDeploy).toContain("api");
      // all hashes match, envHashChanged=true → toRestart
      expect(result.toRestart).toContain("worker");
      // nothing should be skipped
      expect(result.toSkip).toHaveLength(0);
    });

    it("correctly classifies multiple services with envHashChanged false", () => {
      const compose: ParsedComposeFile = {
        services: {
          migrate: makeService({ restart: "on-failure:3" }),
          web: makeService(),
          db: makeService(),
        },
      };
      const stackState = makeStackState({
        migrate: makeServiceState(),
        web: makeServiceState({ definition_hash: "sha256:old" }),
        db: makeServiceState(),
      });
      const candidateHashes: Record<string, CandidateHashes> = {
        migrate: makeCandidateHashes(),
        web: makeCandidateHashes({ definitionHash: "sha256:new" }),
        db: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      // one-shot (on-failure:3) → toDeploy
      expect(result.toDeploy).toContain("migrate");
      // definition_hash changed → toDeploy
      expect(result.toDeploy).toContain("web");
      // all match, envHashChanged=false → toSkip
      expect(result.toSkip).toContain("db");
      // nothing should be restarted
      expect(result.toRestart).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // deterministic output ordering
  // -----------------------------------------------------------------------
  describe("deterministic output ordering", () => {
    it("returns service names in Object.keys order of compose.services", () => {
      const compose: ParsedComposeFile = {
        services: {
          alpha: makeService(),
          bravo: makeService(),
          charlie: makeService(),
          delta: makeService(),
        },
      };
      // All services are new (stackState has no services) → all go to toDeploy
      const stackState = makeStackState(undefined);
      const candidateHashes: Record<string, CandidateHashes> = {
        alpha: makeCandidateHashes(),
        bravo: makeCandidateHashes(),
        charlie: makeCandidateHashes(),
        delta: makeCandidateHashes(),
      };

      const result = classifyServices(compose, stackState, candidateHashes, false);

      expect(result.toDeploy).toEqual(["alpha", "bravo", "charlie", "delta"]);
    });
  });
});
