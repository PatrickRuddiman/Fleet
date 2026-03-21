import os from "os";
import { NodeSSH } from "node-ssh";
import type { Config } from "node-ssh";
import { ServerConfig } from "../config";
import { Connection, ExecResult, StreamExecCallbacks } from "./types";

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return os.homedir() + filePath.slice(1);
  }
  return filePath;
}

export async function createSshConnection(config: ServerConfig): Promise<Connection> {
  const ssh = new NodeSSH();

  const connectConfig: Config = {
    host: config.host,
    port: config.port,
    username: config.user,
  };

  if (config.identity_file) {
    connectConfig.privateKeyPath = expandTilde(config.identity_file);
  } else {
    connectConfig.agent = process.env.SSH_AUTH_SOCK;
  }

  await ssh.connect(connectConfig);

  const exec = async (command: string): Promise<ExecResult> => {
    const result = await ssh.execCommand(command);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 0,
    };
  };

  const streamExec = async (
    command: string,
    callbacks: StreamExecCallbacks
  ): Promise<ExecResult> => {
    const result = await ssh.execCommand(command, {
      onStdout: callbacks.onStdout
        ? (chunk: Buffer) => callbacks.onStdout!(chunk.toString())
        : undefined,
      onStderr: callbacks.onStderr
        ? (chunk: Buffer) => callbacks.onStderr!(chunk.toString())
        : undefined,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 0,
    };
  };

  const close = async (): Promise<void> => {
    ssh.dispose();
  };

  return { exec, streamExec, close };
}
