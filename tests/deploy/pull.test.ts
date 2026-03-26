import { describe, it, expect, vi } from "vitest";
import type { ExecResult, ExecFn } from "../../src/ssh/types";
import type { ParsedComposeFile, ParsedService } from "../../src/compose/types";
import { pullSelectiveImages } from "../../src/deploy/helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseService(overrides: Partial<ParsedService> = {}): ParsedService {
  return {
    hasImage: true,
    hasBuild: false,
    ports: [],
    ...overrides,
  };
}

function createCapturingExec(
  handlers: Record<string, ExecResult> = {}
): { exec: ExecFn; commands: string[] } {
  const commands: string[] = [];
  const exec: ExecFn = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    for (const [pattern, result] of Object.entries(handlers)) {
      if (command.includes(pattern)) return result;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, commands };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pullSelectiveImages", () => {
  const stackName = "myapp";
  const stackDir = "/opt/fleet/stacks/myapp";

  // -----------------------------------------------------------------------
  // 1. Force mode pulls all images
  // -----------------------------------------------------------------------
  it("should pull all images at once in force mode", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
        api: baseService({ image: "node:20" }),
        worker: baseService({ image: "redis:7" }),
      },
    };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, ["web"], true
    );

    // Force mode runs a single pull command without service names
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBe(
      "docker compose -p myapp -f /opt/fleet/stacks/myapp/compose.yml pull"
    );
    // Returns ALL service names regardless of toDeploy
    expect(result).toEqual(["web", "api", "worker"]);
  });

  // -----------------------------------------------------------------------
  // 2. Non-force mode pulls only toDeploy services
  // -----------------------------------------------------------------------
  it("should pull only toDeploy services in non-force mode", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
        api: baseService({ image: "node:20-alpine" }),
      },
    };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, ["web"], false
    );

    // Only "web" is in toDeploy, "api" has pinned tag and is not oneshot
    expect(result).toEqual(["web"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("pull web");
  });

  // -----------------------------------------------------------------------
  // 3. One-shot services are always pulled
  // -----------------------------------------------------------------------
  it("should always pull one-shot services even when not in toDeploy", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
        migrate: baseService({ image: "myapp:v2.0.0", restart: "no" }),
        seed: baseService({ image: "myapp:v2.0.0", restart: "on-failure" }),
      },
    };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, ["web"], false
    );

    // web is in toDeploy, migrate and seed are one-shots
    expect(result).toEqual(["web", "migrate", "seed"]);
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("pull web");
    expect(commands[1]).toContain("pull migrate");
    expect(commands[2]).toContain("pull seed");
  });

  // -----------------------------------------------------------------------
  // 4. Floating-tag services are always pulled
  // -----------------------------------------------------------------------
  it("should always pull floating-tag services regardless of toDeploy", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        "svc-latest": baseService({ image: "nginx:latest" }),
        "svc-no-tag": baseService({ image: "nginx" }),
        "svc-digest": baseService({ image: "nginx@sha256:abc123" }),
        "svc-pinned": baseService({ image: "nginx:1.25" }),
      },
    };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, [], false
    );

    // svc-latest, svc-no-tag, svc-digest are floating — always pulled
    // svc-pinned is pinned and not in toDeploy — skipped
    expect(result).toEqual(["svc-latest", "svc-no-tag", "svc-digest"]);
    expect(commands.filter(c => c.includes("pull svc-"))).toHaveLength(3);
    expect(commands.some(c => c.includes("pull svc-pinned"))).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. Skipped services are not pulled
  // -----------------------------------------------------------------------
  it("should not pull services that are not in toDeploy, not one-shot, and have pinned tags", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
        api: baseService({ image: "node:20-alpine" }),
        db: baseService({ image: "postgres:16.1" }),
      },
    };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, [], false
    );

    expect(result).toEqual([]);
    expect(commands).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 6. Skip log messages are emitted for skipped services
  // -----------------------------------------------------------------------
  it("should log skip messages for services that are not pulled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { exec } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
        api: baseService({ image: "node:20-alpine" }),
      },
    };

    await pullSelectiveImages(
      exec, compose, stackName, stackDir, [], false
    );

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("web")
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipped pull")
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("api")
    );

    logSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // 7a. Pull failures throw descriptive errors — force mode
  // -----------------------------------------------------------------------
  it("should throw a descriptive error when force pull fails", async () => {
    const { exec } = createCapturingExec({
      "compose.yml pull": { code: 1, stdout: "", stderr: "network timeout" },
    });
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
      },
    };

    await expect(
      pullSelectiveImages(
        exec, compose, stackName, stackDir, ["web"], true
      )
    ).rejects.toThrow("Failed to pull images: network timeout");
  });

  // -----------------------------------------------------------------------
  // 7b. Pull failures throw descriptive errors — per-service
  // -----------------------------------------------------------------------
  it("should throw a descriptive error when a per-service pull fails", async () => {
    const { exec } = createCapturingExec({
      "pull web": { code: 1, stdout: "", stderr: "image not found" },
    });
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
      },
    };

    await expect(
      pullSelectiveImages(
        exec, compose, stackName, stackDir, ["web"], false
      )
    ).rejects.toThrow("Failed to pull image for service web: image not found");
  });

  // -----------------------------------------------------------------------
  // 8. Floating-tag services do NOT trigger getImageDigest inside pullSelectiveImages
  //    (post-pull digest comparison is handled by deploy.ts, not pullSelectiveImages)
  // -----------------------------------------------------------------------
  it("should not call getImageDigest for floating-tag services inside pullSelectiveImages", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:latest" }),
      },
    };

    await pullSelectiveImages(
      exec, compose, stackName, stackDir, [], false
    );

    // pullSelectiveImages should only pull; digest inspection is done in deploy.ts
    const inspectCommands = commands.filter(c => c.includes("docker image inspect"));
    expect(inspectCommands).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 9. getImageDigest is NOT called for non-floating pulled services
  // -----------------------------------------------------------------------
  it("should not call getImageDigest for pinned-tag services", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService({ image: "nginx:1.25" }),
      },
    };

    await pullSelectiveImages(
      exec, compose, stackName, stackDir, ["web"], false
    );

    const inspectCommands = commands.filter(c => c.includes("docker image inspect"));
    expect(inspectCommands).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 10. Services with undefined image (floating tag) but no getImageDigest
  // -----------------------------------------------------------------------
  it("should pull services with undefined image (floating tag) but not call getImageDigest", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        web: baseService(), // no image field — hasFloatingTag(undefined) => true
      },
    };

    await pullSelectiveImages(
      exec, compose, stackName, stackDir, [], false
    );

    expect(commands.filter(c => c.includes("pull web"))).toHaveLength(1);
    // getImageDigest is only called if service.image is truthy
    const inspectCommands = commands.filter(c => c.includes("docker image inspect"));
    expect(inspectCommands).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 11. Empty services object returns empty array
  // -----------------------------------------------------------------------
  it("should return an empty array when compose has no services", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = { services: {} };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, [], false
    );

    expect(result).toEqual([]);
    expect(commands).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 12. Force mode with empty services
  // -----------------------------------------------------------------------
  it("should run bulk pull and return empty array in force mode with no services", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = { services: {} };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, [], true
    );

    expect(commands).toHaveLength(1);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // 13. Combined classification — no duplicate pulls
  // -----------------------------------------------------------------------
  it("should not duplicate services that match multiple criteria", async () => {
    const { exec, commands } = createCapturingExec();
    const compose: ParsedComposeFile = {
      services: {
        // In toDeploy AND is a oneShot AND has floating tag
        migrate: baseService({ image: "myapp:latest", restart: "no" }),
      },
    };

    const result = await pullSelectiveImages(
      exec, compose, stackName, stackDir, ["migrate"], false
    );

    // Should only be pulled once
    expect(result).toEqual(["migrate"]);
    const pullCommands = commands.filter(c => c.includes("pull migrate"));
    expect(pullCommands).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Note: --skip-pull is handled by the caller in deploy.ts (line 144:
  // `if (!options.skipPull)`) and is not part of pullSelectiveImages's
  // contract. No test needed here for that flag.
  // -----------------------------------------------------------------------
});
