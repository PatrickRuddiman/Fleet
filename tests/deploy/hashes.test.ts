import { describe, it, expect } from "vitest";
import type { ExecFn, ExecResult } from "../../src/ssh/types";
import { getImageDigest } from "../../src/deploy/hashes";

describe("getImageDigest", () => {
  it("should return the digest from a full digest reference", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      stdout: "ghcr.io/org/app@sha256:abc123",
      stderr: "",
      code: 0,
    });

    const result = await getImageDigest(exec, "ghcr.io/org/app:latest");
    expect(result).toBe("sha256:abc123");
  });

  it("should return null when stdout is empty", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      code: 0,
    });

    const result = await getImageDigest(exec, "myapp:latest");
    expect(result).toBeNull();
  });

  it("should return null when stdout contains '<no value>'", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      stdout: "<no value>",
      stderr: "",
      code: 0,
    });

    const result = await getImageDigest(exec, "locally-built:latest");
    expect(result).toBeNull();
  });

  it("should return null on non-zero exit code", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      stdout: "",
      stderr: "No such image: missing:latest",
      code: 1,
    });

    const result = await getImageDigest(exec, "missing:latest");
    expect(result).toBeNull();
  });

  it("should trim trailing newline and whitespace from stdout", async () => {
    const exec: ExecFn = async (_command: string): Promise<ExecResult> => ({
      stdout: "ghcr.io/org/app@sha256:def456\n",
      stderr: "",
      code: 0,
    });

    const result = await getImageDigest(exec, "ghcr.io/org/app:main");
    expect(result).toBe("sha256:def456");
  });
});
