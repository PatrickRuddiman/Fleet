import { describe, it, expect } from "vitest";
import type { ExecResult, Exec } from "../src/ssh";
import { resolveFleetRoot, readFleetRoot } from "../src/fleet-root";

/**
 * Helper to create a mock exec function from a map of command patterns to results.
 * Commands are matched by checking if the command string includes the pattern key.
 */
function createMockExec(
  handlers: Record<string, ExecResult>
): Exec {
  return async (command: string): Promise<ExecResult> => {
    for (const [pattern, result] of Object.entries(handlers)) {
      if (command.includes(pattern)) {
        return result;
      }
    }
    return { exitCode: 1, stdout: "", stderr: `unhandled command: ${command}` };
  };
}

describe("resolveFleetRoot", () => {
  it("should resolve to /opt/fleet when mkdir succeeds", async () => {
    const exec = createMockExec({
      "mkdir -p /opt/fleet": { exitCode: 0, stdout: "", stderr: "" },
      "echo '/opt/fleet' > ~/.fleet-root": { exitCode: 0, stdout: "", stderr: "" },
    });

    const result = await resolveFleetRoot(exec);
    expect(result).toBe("/opt/fleet");
  });

  it("should fall back to ~/fleet on permission denied", async () => {
    const exec = createMockExec({
      "mkdir -p /opt/fleet": {
        exitCode: 1,
        stdout: "",
        stderr: "mkdir: cannot create directory '/opt/fleet': Permission denied",
      },
      "echo ~": { exitCode: 0, stdout: "/home/deploy\n", stderr: "" },
      "mkdir -p /home/deploy/fleet": { exitCode: 0, stdout: "", stderr: "" },
      "echo '/home/deploy/fleet' > ~/.fleet-root": {
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    });

    const result = await resolveFleetRoot(exec);
    expect(result).toBe("/home/deploy/fleet");
  });

  it("should fall back to ~/fleet on 'Operation not permitted'", async () => {
    const exec = createMockExec({
      "mkdir -p /opt/fleet": {
        exitCode: 1,
        stdout: "",
        stderr: "Operation not permitted",
      },
      "echo ~": { exitCode: 0, stdout: "/home/user\n", stderr: "" },
      "mkdir -p /home/user/fleet": { exitCode: 0, stdout: "", stderr: "" },
      "echo '/home/user/fleet' > ~/.fleet-root": {
        exitCode: 0,
        stdout: "",
        stderr: "",
      },
    });

    const result = await resolveFleetRoot(exec);
    expect(result).toBe("/home/user/fleet");
  });

  it("should throw when /opt/fleet fails with a non-permission error", async () => {
    const exec = createMockExec({
      "mkdir -p /opt/fleet": {
        exitCode: 1,
        stdout: "",
        stderr: "I/O error",
      },
    });

    await expect(resolveFleetRoot(exec)).rejects.toThrow(
      "Failed to create fleet root at /opt/fleet"
    );
    await expect(resolveFleetRoot(exec)).rejects.toThrow("I/O error");
  });

  it("should throw when both /opt/fleet and ~/fleet fail", async () => {
    const exec = createMockExec({
      "mkdir -p /opt/fleet": {
        exitCode: 1,
        stdout: "",
        stderr: "Permission denied",
      },
      "echo ~": { exitCode: 0, stdout: "/home/deploy\n", stderr: "" },
      "mkdir -p /home/deploy/fleet": {
        exitCode: 1,
        stdout: "",
        stderr: "Read-only file system",
      },
    });

    await expect(resolveFleetRoot(exec)).rejects.toThrow(
      "Failed to create fleet root at /home/deploy/fleet"
    );
  });
});

describe("readFleetRoot", () => {
  it("should return the path when .fleet-root file exists", async () => {
    const exec = createMockExec({
      "cat ~/.fleet-root": { exitCode: 0, stdout: "/opt/fleet", stderr: "" },
    });

    const result = await readFleetRoot(exec);
    expect(result).toBe("/opt/fleet");
  });

  it("should return null when .fleet-root file does not exist", async () => {
    const exec = createMockExec({
      "cat ~/.fleet-root": {
        exitCode: 1,
        stdout: "",
        stderr: "No such file or directory",
      },
    });

    const result = await readFleetRoot(exec);
    expect(result).toBeNull();
  });

  it("should trim whitespace from the returned path", async () => {
    const exec = createMockExec({
      "cat ~/.fleet-root": {
        exitCode: 0,
        stdout: "  /opt/fleet  \n",
        stderr: "",
      },
    });

    const result = await readFleetRoot(exec);
    expect(result).toBe("/opt/fleet");
  });
});
