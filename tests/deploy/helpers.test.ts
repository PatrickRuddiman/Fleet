import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRelativeTime, printSummary } from "../../src/deploy/helpers";
import type { ParsedComposeFile, ParsedService } from "../../src/compose/types";
import type { ServiceClassification } from "../../src/deploy/classify";
import type { StackState, ServiceState } from "../../src/state/types";
import type { RouteConfig } from "../../src/config/schema";

describe("formatRelativeTime", () => {
  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe("edge cases", () => {
    it("returns 'unknown' for an invalid timestamp", () => {
      expect(formatRelativeTime("not-a-date")).toBe("unknown");
    });

    it("returns 'unknown' for an empty string", () => {
      expect(formatRelativeTime("")).toBe("unknown");
    });

    it("returns 'in the future' for a future timestamp", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T13:00:00.000Z")).toBe("in the future");
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Recent times
  // ---------------------------------------------------------------------------
  describe("recent times", () => {
    it("returns 'just now' for a timestamp less than 60 seconds ago", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:00:30.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("just now");
      vi.useRealTimers();
    });

    it("returns 'just now' for a timestamp exactly now", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("just now");
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Minutes
  // ---------------------------------------------------------------------------
  describe("minutes", () => {
    it("returns '1 minute ago' for exactly 60 seconds", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:01:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("1 minute ago");
      vi.useRealTimers();
    });

    it("returns '5 minutes ago' for 5 minutes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:05:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("5 minutes ago");
      vi.useRealTimers();
    });

    it("returns '59 minutes ago' for 59 minutes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:59:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("59 minutes ago");
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Hours
  // ---------------------------------------------------------------------------
  describe("hours", () => {
    it("returns '1 hour ago' for exactly 60 minutes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T13:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("1 hour ago");
      vi.useRealTimers();
    });

    it("returns '2 hours ago' for 2 hours", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T14:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("2 hours ago");
      vi.useRealTimers();
    });

    it("returns '23 hours ago' for 23 hours", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-02T11:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("23 hours ago");
      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // Days
  // ---------------------------------------------------------------------------
  describe("days", () => {
    it("returns '1 day ago' for exactly 24 hours", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-02T12:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("1 day ago");
      vi.useRealTimers();
    });

    it("returns '4 days ago' for 4 days", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-05T12:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("4 days ago");
      vi.useRealTimers();
    });

    it("returns '30 days ago' for 30 days", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-07-01T12:00:00.000Z"));
      expect(formatRelativeTime("2025-06-01T12:00:00.000Z")).toBe("30 days ago");
      vi.useRealTimers();
    });
  });
});

// ---------------------------------------------------------------------------
// Factory helpers (printSummary)
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

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------

describe("printSummary", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  /** Collect all console.log calls into a single joined string. */
  function getOutput(): string {
    return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
  }

  // ---------------------------------------------------------------------------
  // Selective mode with mixed deploy/restart/skip services
  // ---------------------------------------------------------------------------
  describe("selective mode", () => {
    it("shows correct status for deploy, restart, skip, and one-shot services", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"));

      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
          worker: makeService(),
          cache: makeService(),
          migrate: makeService({ restart: "no" }),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: ["web", "migrate"],
        toRestart: ["worker"],
        toSkip: ["cache"],
        reasons: {
          web: "image changed (sha256a → sha256b)",
          worker: "env changed",
          cache: "no changes",
          migrate: "one-shot",
        },
      };

      const existingStackState = makeStackState({
        cache: makeServiceState({
          deployed_at: "2025-06-01T10:00:00.000Z",
        }),
      });

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        existingStackState,
        5,
        [],
        [],
      );

      const output = getOutput();
      expect(output).toContain("--- Deploy Summary ---");
      expect(output).toContain("Services:");
      expect(output).toContain("image changed (sha256a → sha256b) → deployed");
      expect(output).toContain("env changed → restarted");
      expect(output).toContain("no changes → skipped (last deployed 2 hours ago)");
      expect(output).toContain("one-shot → run");
      expect(output).not.toContain("⚠ Force mode");
      expect(output).toContain("1 deployed, 1 restarted, 1 run (one-shot), 1 skipped");
      expect(output).toContain("Deploy complete in 5s");
    });
  });

  // ---------------------------------------------------------------------------
  // Force mode with banner and forced tags
  // ---------------------------------------------------------------------------
  describe("force mode", () => {
    it("shows force banner and forced tags for all services", () => {
      const compose: ParsedComposeFile = {
        services: {
          api: makeService(),
          db: makeService(),
          migrate: makeService({ restart: "on-failure" }),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: ["api", "db", "migrate"],
        toRestart: [],
        toSkip: [],
        reasons: { api: "forced", db: "forced", migrate: "forced" },
      };

      printSummary(
        classification,
        compose,
        classification.reasons,
        true,
        undefined,
        12,
        [],
        [],
      );

      const output = getOutput();
      expect(output).toContain("⚠ Force mode — all services will be redeployed");
      expect(output).toContain("api");
      expect(output).toContain("deployed (forced)");
      expect(output).toContain("db");
      expect(output).toContain("migrate");
      expect(output).toContain("run (forced)");
      expect(output).toContain("2 deployed, 1 run (one-shot)");
      expect(output).not.toContain("restarted");
      expect(output).not.toContain("skipped");
      expect(output).toContain("Deploy complete in 12s");
    });
  });

  // ---------------------------------------------------------------------------
  // Nothing-changed mode with all services skipped
  // ---------------------------------------------------------------------------
  describe("nothing-changed mode", () => {
    it("shows all services as skipped with relative times", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"));

      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
          api: makeService(),
          worker: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: [],
        toRestart: [],
        toSkip: ["web", "api", "worker"],
        reasons: { web: "no changes", api: "no changes", worker: "no changes" },
      };

      const existingStackState = makeStackState({
        web: makeServiceState({ deployed_at: "2025-06-01T10:00:00.000Z" }),
        api: makeServiceState({ deployed_at: "2025-06-01T11:00:00.000Z" }),
        worker: makeServiceState({ deployed_at: "2025-05-31T12:00:00.000Z" }),
      });

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        existingStackState,
        2,
        [],
        [],
      );

      const output = getOutput();
      expect(output).not.toContain("⚠ Force mode");
      expect(output).toContain("no changes → skipped (last deployed 2 hours ago)");
      expect(output).toContain("no changes → skipped (last deployed 1 hour ago)");
      expect(output).toContain("no changes → skipped (last deployed 1 day ago)");
      expect(output).toContain("3 skipped");
      // Summary counts should not include deploy/restart/one-shot categories
      expect(output).not.toMatch(/\d+ deployed/);
      expect(output).not.toMatch(/\d+ restarted/);
      expect(output).not.toContain("one-shot");
      expect(output).toContain("Deploy complete in 2s");
    });
  });

  // ---------------------------------------------------------------------------
  // Summary counts line correctness
  // ---------------------------------------------------------------------------
  describe("summary counts", () => {
    it("omits zero-count categories", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: ["web"],
        toRestart: [],
        toSkip: [],
        reasons: { web: "image changed" },
      };

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        undefined,
        1,
        [],
        [],
      );

      const output = getOutput();
      expect(output).toContain("1 deployed");
      expect(output).not.toContain("restarted");
      expect(output).not.toContain("skipped");
      expect(output).not.toContain("one-shot");
    });

    it("includes all non-zero categories", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
          worker: makeService(),
          cache: makeService(),
          migrate: makeService({ restart: "no" }),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: ["web", "migrate"],
        toRestart: ["worker"],
        toSkip: ["cache"],
        reasons: {
          web: "image changed",
          worker: "env changed",
          cache: "no changes",
          migrate: "one-shot",
        },
      };

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        undefined,
        3,
        [],
        [],
      );

      const output = getOutput();
      expect(output).toContain("1 deployed, 1 restarted, 1 run (one-shot), 1 skipped");
    });
  });

  // ---------------------------------------------------------------------------
  // Relative time display for skipped services
  // ---------------------------------------------------------------------------
  describe("relative time for skipped services", () => {
    it("shows relative time when deployed_at is available for skipped service", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-05T12:00:00.000Z"));

      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: [],
        toRestart: [],
        toSkip: ["web"],
        reasons: { web: "no changes" },
      };

      const existingStackState = makeStackState({
        web: makeServiceState({ deployed_at: "2025-06-01T12:00:00.000Z" }),
      });

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        existingStackState,
        1,
        [],
        [],
      );

      const output = getOutput();
      expect(output).toContain("(last deployed 4 days ago)");
    });

    it("omits relative time when no existing stack state", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: [],
        toRestart: [],
        toSkip: ["web"],
        reasons: { web: "no changes" },
      };

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        undefined,
        1,
        [],
        [],
      );

      const output = getOutput();
      expect(output).not.toContain("(last deployed");
    });

    it("omits relative time when service has no deployed_at in state", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: [],
        toRestart: [],
        toSkip: ["web"],
        reasons: { web: "no changes" },
      };

      // Stack state exists but does not include "web"
      const existingStackState = makeStackState({
        api: makeServiceState(),
      });

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        existingStackState,
        1,
        [],
        [],
      );

      const output = getOutput();
      expect(output).not.toContain("(last deployed");
    });
  });

  // ---------------------------------------------------------------------------
  // Column alignment with varying service name lengths
  // ---------------------------------------------------------------------------
  describe("column alignment", () => {
    it("aligns detail columns based on longest service name", () => {
      const compose: ParsedComposeFile = {
        services: {
          a: makeService(),
          "web-server-long-name": makeService(),
          db: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: ["a", "web-server-long-name", "db"],
        toRestart: [],
        toSkip: [],
        reasons: { a: "forced", "web-server-long-name": "forced", db: "forced" },
      };

      printSummary(
        classification,
        compose,
        classification.reasons,
        true,
        undefined,
        1,
        [],
        [],
      );

      // Find service detail lines (they start with two spaces and contain "deployed" or "run")
      const serviceLines = logSpy.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.startsWith("  ") && line.includes("(forced)"));

      expect(serviceLines).toHaveLength(3);

      // maxWidth is 20 ("web-server-long-name".length)
      // Each line should be: "  <name.padEnd(20)>  <detail>"
      const maxWidth = "web-server-long-name".length;
      for (const line of serviceLines) {
        // Remove leading two spaces
        const content = line.slice(2);
        // The detail should start at position maxWidth + 2 (padEnd + two spaces)
        const detailStart = maxWidth + 2;
        const detailPart = content.slice(detailStart);
        expect(detailPart).toMatch(/^(deployed|run) \(forced\)$/);
      }

      // Specifically verify "a" is padded correctly
      const aLine = serviceLines.find((l) => l.includes("  a"));
      expect(aLine).toBe(`  ${"a".padEnd(maxWidth)}  deployed (forced)`);
    });
  });

  // ---------------------------------------------------------------------------
  // Routes and warnings output
  // ---------------------------------------------------------------------------
  describe("routes and warnings", () => {
    it("prints routes with correct protocol", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: ["web"],
        toRestart: [],
        toSkip: [],
        reasons: { web: "image changed" },
      };

      const routes = [
        { domain: "example.com", port: 3000, service: "web", tls: true },
        { domain: "api.example.com", port: 8080, service: "api", tls: false },
      ] as RouteConfig[];

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        undefined,
        3,
        routes,
        [],
      );

      const output = getOutput();
      expect(output).toContain("Routes:");
      expect(output).toContain("https://example.com → web:3000");
      expect(output).toContain("http://api.example.com → api:8080");
    });

    it("prints warnings with ⚠ prefix", () => {
      const compose: ParsedComposeFile = {
        services: {
          web: makeService(),
        },
      };

      const classification: ServiceClassification = {
        toDeploy: ["web"],
        toRestart: [],
        toSkip: [],
        reasons: { web: "image changed" },
      };

      printSummary(
        classification,
        compose,
        classification.reasons,
        false,
        undefined,
        2,
        [],
        ["Port 8080 is already in use", "No health check configured"],
      );

      const output = getOutput();
      expect(output).toContain("Warnings:");
      expect(output).toContain("⚠ Port 8080 is already in use");
      expect(output).toContain("⚠ No health check configured");
    });
  });
});
