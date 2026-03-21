import { describe, it, expect } from "vitest";
import type { ExecResult, ExecFn } from "../src/ssh";
import { bootstrapInfisicalCli } from "../src/deploy/infisical";

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
const SUCCESS: ExecResult = { code: 0, stdout: "", stderr: "" };

describe("bootstrapInfisicalCli", () => {
  describe("when CLI is already present", () => {
    it("should skip installation and not run any further commands", async () => {
      const { exec, commands } = createMockExec({
        "infisical --version": {
          code: 0,
          stdout: "infisical/0.31.1",
          stderr: "",
        },
      });

      await bootstrapInfisicalCli(exec);

      // Only the version check should be issued — no install commands
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain("infisical --version");
    });
  });

  describe("when CLI is absent and installation succeeds", () => {
    it("should install the CLI and verify the installation", async () => {
      let versionCallCount = 0;
      const commands: string[] = [];

      const exec: ExecFn = async (command: string): Promise<ExecResult> => {
        commands.push(command);

        if (command.includes("infisical --version")) {
          versionCallCount++;
          if (versionCallCount === 1) {
            // First call: CLI not found
            return { code: 127, stdout: "", stderr: "command not found" };
          }
          // Second call (verification): CLI now installed
          return { code: 0, stdout: "infisical/0.31.1", stderr: "" };
        }

        if (command.includes("curl -1sLf")) {
          return SUCCESS;
        }

        return { code: 1, stdout: "", stderr: `unhandled: ${command}` };
      };

      await bootstrapInfisicalCli(exec);

      // Should have issued 3 commands: version check, install, verify
      expect(commands).toHaveLength(3);
      expect(commands[0]).toContain("infisical --version");
      expect(commands[1]).toContain("curl -1sLf");
      expect(commands[1]).toContain("apt-get install -y infisical");
      expect(commands[2]).toContain("infisical --version");
    });
  });

  describe("when installation fails", () => {
    it("should throw a descriptive error with stderr when install command fails", async () => {
      const { exec } = createMockExec({
        "infisical --version": {
          code: 127,
          stdout: "",
          stderr: "command not found",
        },
        "curl -1sLf": {
          code: 1,
          stdout: "",
          stderr: "E: Unable to locate package infisical",
        },
      });

      await expect(bootstrapInfisicalCli(exec)).rejects.toThrow(
        "Failed to install Infisical CLI"
      );
      await expect(
        bootstrapInfisicalCli(
          createMockExec({
            "infisical --version": {
              code: 127,
              stdout: "",
              stderr: "command not found",
            },
            "curl -1sLf": {
              code: 1,
              stdout: "",
              stderr: "E: Unable to locate package infisical",
            },
          }).exec
        )
      ).rejects.toThrow("code 1");
    });

    it("should throw a descriptive error when verification fails after install", async () => {
      let versionCallCount = 0;
      const commands: string[] = [];

      const exec: ExecFn = async (command: string): Promise<ExecResult> => {
        commands.push(command);

        if (command.includes("infisical --version")) {
          versionCallCount++;
          if (versionCallCount === 1) {
            // First call: CLI not found
            return { code: 127, stdout: "", stderr: "command not found" };
          }
          // Second call: verification fails (still not working)
          return {
            code: 1,
            stdout: "",
            stderr: "infisical: error while loading shared libraries",
          };
        }

        if (command.includes("curl -1sLf")) {
          return SUCCESS;
        }

        return { code: 1, stdout: "", stderr: `unhandled: ${command}` };
      };

      await expect(bootstrapInfisicalCli(exec)).rejects.toThrow(
        "Infisical CLI installation could not be verified"
      );

      expect(commands).toHaveLength(3);
    });

    it("should include stderr detail in installation error message", async () => {
      const { exec } = createMockExec({
        "infisical --version": {
          code: 127,
          stdout: "",
          stderr: "command not found",
        },
        "curl -1sLf": {
          code: 100,
          stdout: "",
          stderr: "network timeout",
        },
      });

      await expect(bootstrapInfisicalCli(exec)).rejects.toThrow(
        "network timeout"
      );
    });
  });
});
