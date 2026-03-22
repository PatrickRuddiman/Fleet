import { describe, it, expect } from "vitest";
import type { ExecResult, ExecFn } from "../src/ssh/types";
import { computeEnvHash } from "../src/deploy/hashes";

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
