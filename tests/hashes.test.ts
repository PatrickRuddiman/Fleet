import { describe, it, expect } from "vitest";
import type { ExecResult, ExecFn } from "../src/ssh/types";
import type { ParsedService } from "../src/compose/types";
import { computeEnvHash } from "../src/deploy/hashes";
import {
  computeDefinitionHash,
  removeNullAndEmpty,
  sortKeysDeep,
} from "../src/deploy/hashes";

describe("computeEnvHash", () => {
  it("should return sha256-prefixed hash for a valid sha256sum output", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      code: 0,
      stdout: "abc123def456  /path/to/.env\n",
      stderr: "",
    });

    const result = await computeEnvHash(exec, "/path/to/.env");
    expect(result).toBe("sha256:abc123def456");
  });

  it("should return null when file is missing (non-zero exit code)", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      code: 1,
      stdout: "",
      stderr: "sha256sum: /path/to/.env: No such file or directory",
    });

    const result = await computeEnvHash(exec, "/path/to/.env");
    expect(result).toBeNull();
  });

  it("should return null when stdout is empty despite exit code 0", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await computeEnvHash(exec, "/path/to/.env");
    expect(result).toBeNull();
  });

  it("should parse correctly with extra whitespace in output", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      code: 0,
      stdout: "  a1b2c3d4e5f6  /path/to/.env  \n",
      stderr: "",
    });

    const result = await computeEnvHash(exec, "/path/to/.env");
    expect(result).toBe("sha256:a1b2c3d4e5f6");
  });

  it("should parse correctly with varying path formats", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      code: 0,
      stdout: "deadbeef01234567  ./relative/.env\n",
      stderr: "",
    });

    const result = await computeEnvHash(exec, "./relative/.env");
    expect(result).toBe("sha256:deadbeef01234567");
  });

  it("should pass the correct sha256sum command to exec", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string): Promise<ExecResult> => {
      capturedCommand = command;
      return {
        code: 0,
        stdout: "abc123  /opt/fleet/stacks/myapp/.env\n",
        stderr: "",
      };
    };

    await computeEnvHash(exec, "/opt/fleet/stacks/myapp/.env");
    expect(capturedCommand).toContain("sha256sum");
    expect(capturedCommand).toContain("/opt/fleet/stacks/myapp/.env");
  });
});

function baseService(): ParsedService {
  return {
    hasImage: true,
    hasBuild: false,
    image: "nginx:latest",
    command: "/bin/sh -c 'echo hello'",
    entrypoint: "/docker-entrypoint.sh",
    environment: { NODE_ENV: "production", PORT: "3000" },
    ports: [{ published: 8080, target: 80 }],
    volumes: ["/data:/app/data"],
    labels: { "com.example.team": "backend", "com.example.env": "prod" },
    user: "node",
    working_dir: "/app",
    healthcheck: { test: ["CMD", "curl", "-f", "http://localhost/"], interval: "30s" },
    restart: "unless-stopped",
  };
}

describe("computeDefinitionHash", () => {
  it("should produce the same hash for the same input (idempotency)", () => {
    const service = baseService();
    const hash1 = computeDefinitionHash(service);
    const hash2 = computeDefinitionHash(service);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("should produce the same hash regardless of key order in environment and labels", () => {
    const service1 = baseService();

    const service2 = baseService();
    // Reverse the key order for environment
    service2.environment = { PORT: "3000", NODE_ENV: "production" };
    // Reverse the key order for labels
    service2.labels = { "com.example.env": "prod", "com.example.team": "backend" };

    expect(computeDefinitionHash(service1)).toBe(computeDefinitionHash(service2));
  });

  it("should produce a different hash when image changes", () => {
    const service1 = baseService();
    const service2 = baseService();
    service2.image = "nginx:alpine";

    expect(computeDefinitionHash(service1)).not.toBe(computeDefinitionHash(service2));
  });

  it("should produce the same hash when only restart changes (excluded field)", () => {
    const service1 = baseService();
    const service2 = baseService();
    service2.restart = "always";

    expect(computeDefinitionHash(service1)).toBe(computeDefinitionHash(service2));
  });

  it("should produce the same hash when command is null vs absent (null-cleaning)", () => {
    const service1 = baseService();
    service1.command = null;

    const service2 = baseService();
    delete service2.command;

    expect(computeDefinitionHash(service1)).toBe(computeDefinitionHash(service2));
  });
});

describe("removeNullAndEmpty", () => {
  it("should strip null, undefined, and empty-string values from objects", () => {
    const input = { a: 1, b: null, c: undefined, d: "", e: "keep" };
    const result = removeNullAndEmpty(input);
    expect(result).toEqual({ a: 1, e: "keep" });
  });

  it("should filter null/undefined/empty-string from arrays", () => {
    const input = [1, null, undefined, "", "keep"];
    const result = removeNullAndEmpty(input);
    expect(result).toEqual([1, "keep"]);
  });

  it("should recurse into nested objects", () => {
    const input = { outer: { inner: null, keep: "yes" } };
    const result = removeNullAndEmpty(input);
    expect(result).toEqual({ outer: { keep: "yes" } });
  });
});

describe("sortKeysDeep", () => {
  it("should sort object keys alphabetically", () => {
    const input = { z: 1, a: 2, m: 3 };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
  });

  it("should preserve array element order", () => {
    const input = [3, 1, 2];
    expect(sortKeysDeep(input)).toEqual([3, 1, 2]);
  });

  it("should recursively sort nested objects", () => {
    const input = { b: { z: 1, a: 2 }, a: 1 };
    const result = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.b as Record<string, unknown>)).toEqual(["a", "z"]);
  });
});
