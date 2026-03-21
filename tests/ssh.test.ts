import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";

const { mockConnect, mockExecCommand, mockDispose } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockExecCommand: vi.fn(),
  mockDispose: vi.fn(),
}));

vi.mock("node-ssh", () => {
  return {
    NodeSSH: class {
      connect = mockConnect;
      execCommand = mockExecCommand;
      dispose = mockDispose;
    },
  };
});

import { createLocalConnection } from "../src/ssh/local";
import { createSshConnection } from "../src/ssh/ssh";
import { createConnection } from "../src/ssh/factory";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLocalConnection", () => {
  describe("exec", () => {
    it("should execute a command and return stdout", async () => {
      const conn = createLocalConnection();
      const result = await conn.exec("echo hello");
      expect(result.stdout.trim()).toBe("hello");
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    });

    it("should capture stderr", async () => {
      const conn = createLocalConnection();
      const result = await conn.exec("echo error >&2");
      expect(result.stderr.trim()).toBe("error");
      expect(result.code).toBe(0);
    });

    it("should return non-zero exit code on failure", async () => {
      const conn = createLocalConnection();
      const result = await conn.exec("exit 42");
      expect(result.code).toBe(42);
    });
  });

  describe("streamExec", () => {
    it("should invoke onStdout callback with data", async () => {
      const conn = createLocalConnection();
      const chunks: string[] = [];
      const result = await conn.streamExec("echo streamed", {
        onStdout: (chunk) => chunks.push(chunk),
      });
      expect(chunks.join("")).toContain("streamed");
      expect(result.code).toBe(0);
    });

    it("should invoke onStderr callback with data", async () => {
      const conn = createLocalConnection();
      const chunks: string[] = [];
      const result = await conn.streamExec("echo streamerr >&2", {
        onStderr: (chunk) => chunks.push(chunk),
      });
      expect(chunks.join("")).toContain("streamerr");
      expect(result.code).toBe(0);
    });

    it("should return stdout and stderr in result", async () => {
      const conn = createLocalConnection();
      const result = await conn.streamExec("echo out && echo err >&2", {});
      expect(result.stdout).toContain("out");
      expect(result.stderr).toContain("err");
    });
  });

  describe("close", () => {
    it("should be a no-op and not throw", async () => {
      const conn = createLocalConnection();
      await conn.close();
    });
  });
});

describe("createConnection", () => {
  it("should return a local connection for host \"localhost\"", async () => {
    const conn = await createConnection({ host: "localhost", port: 22, user: "root" });
    const result = await conn.exec("echo factory_test");
    expect(result.stdout.trim()).toBe("factory_test");
    expect(result.code).toBe(0);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("should return a local connection for host \"127.0.0.1\"", async () => {
    const conn = await createConnection({ host: "127.0.0.1", port: 22, user: "root" });
    const result = await conn.exec("echo loopback_test");
    expect(result.stdout.trim()).toBe("loopback_test");
    expect(result.code).toBe(0);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("should return an SSH connection for a remote host", async () => {
    mockExecCommand.mockResolvedValue({ stdout: "remote", stderr: "", code: 0, signal: null });
    const conn = await createConnection({ host: "10.0.0.1", port: 22, user: "root" });
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "10.0.0.1", port: 22, username: "root" })
    );
    const result = await conn.exec("echo remote");
    expect(result.stdout).toBe("remote");
    expect(result.code).toBe(0);
  });
});

describe("createSshConnection", () => {
  describe("connect", () => {
    it("should connect with host, port, and username", async () => {
      await createSshConnection({ host: "10.0.0.1", port: 2222, user: "deploy" });
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "10.0.0.1", port: 2222, username: "deploy" })
      );
    });

    it("should use privateKeyPath when identity_file is provided", async () => {
      await createSshConnection({
        host: "10.0.0.1",
        port: 22,
        user: "root",
        identity_file: "/home/user/.ssh/id_rsa",
      });
      const callArg = mockConnect.mock.calls[0][0];
      expect(callArg.privateKeyPath).toBe("/home/user/.ssh/id_rsa");
      expect(callArg.agent).toBeUndefined();
    });

    it("should expand tilde in identity_file", async () => {
      vi.spyOn(os, "homedir").mockReturnValue("/home/testuser");
      await createSshConnection({
        host: "10.0.0.1",
        port: 22,
        user: "root",
        identity_file: "~/.ssh/id_ed25519",
      });
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ privateKeyPath: "/home/testuser/.ssh/id_ed25519" })
      );
    });

    it("should use SSH agent when no identity_file is provided", async () => {
      const originalSock = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
      try {
        await createSshConnection({ host: "10.0.0.1", port: 22, user: "root" });
        expect(mockConnect).toHaveBeenCalledWith(
          expect.objectContaining({ agent: "/tmp/ssh-agent.sock" })
        );
      } finally {
        if (originalSock === undefined) {
          delete process.env.SSH_AUTH_SOCK;
        } else {
          process.env.SSH_AUTH_SOCK = originalSock;
        }
      }
    });
  });

  describe("exec", () => {
    it("should return mapped result from execCommand", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "hello", stderr: "", code: 0, signal: null });
      const conn = await createSshConnection({ host: "10.0.0.1", port: 22, user: "root" });
      const result = await conn.exec("echo hello");
      expect(result).toEqual({ stdout: "hello", stderr: "", code: 0 });
      expect(mockExecCommand).toHaveBeenCalledWith("echo hello");
    });

    it("should default code to 0 when null", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "", stderr: "", code: null, signal: null });
      const conn = await createSshConnection({ host: "10.0.0.1", port: 22, user: "root" });
      const result = await conn.exec("some command");
      expect(result.code).toBe(0);
    });
  });

  describe("streamExec", () => {
    it("should pass onStdout and onStderr callbacks", async () => {
      mockExecCommand.mockResolvedValue({ stdout: "out", stderr: "err", code: 0, signal: null });
      const conn = await createSshConnection({ host: "10.0.0.1", port: 22, user: "root" });
      const onStdout = vi.fn();
      const onStderr = vi.fn();
      await conn.streamExec("cmd", { onStdout, onStderr });
      expect(mockExecCommand).toHaveBeenCalledWith("cmd", expect.objectContaining({
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      }));
    });

    it("should convert Buffer to string in callbacks", async () => {
      mockExecCommand.mockImplementation((_cmd: string, options?: any) => {
        if (options?.onStdout) options.onStdout(Buffer.from("buffered-out"));
        if (options?.onStderr) options.onStderr(Buffer.from("buffered-err"));
        return Promise.resolve({ stdout: "buffered-out", stderr: "buffered-err", code: 0, signal: null });
      });
      const conn = await createSshConnection({ host: "10.0.0.1", port: 22, user: "root" });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      await conn.streamExec("cmd", {
        onStdout: (chunk) => stdoutChunks.push(chunk),
        onStderr: (chunk) => stderrChunks.push(chunk),
      });
      expect(stdoutChunks).toContain("buffered-out");
      expect(stderrChunks).toContain("buffered-err");
      expect(typeof stdoutChunks[0]).toBe("string");
      expect(typeof stderrChunks[0]).toBe("string");
    });
  });

  describe("close", () => {
    it("should call ssh.dispose()", async () => {
      const conn = await createSshConnection({ host: "10.0.0.1", port: 22, user: "root" });
      await conn.close();
      expect(mockDispose).toHaveBeenCalledOnce();
    });
  });

  describe("tilde expansion", () => {
    it("should not expand tilde if path does not start with ~", async () => {
      await createSshConnection({
        host: "10.0.0.1",
        port: 22,
        user: "root",
        identity_file: "/absolute/path/key",
      });
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ privateKeyPath: "/absolute/path/key" })
      );
    });

    it("should expand tilde at start only", async () => {
      vi.spyOn(os, "homedir").mockReturnValue("/home/user");
      await createSshConnection({
        host: "10.0.0.1",
        port: 22,
        user: "root",
        identity_file: "~/path/to/key",
      });
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ privateKeyPath: "/home/user/path/to/key" })
      );
    });
  });
});
