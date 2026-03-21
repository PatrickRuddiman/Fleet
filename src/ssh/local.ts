import { exec as cpExec, spawn } from "child_process";
import { Connection, ExecResult, StreamExecCallbacks } from "./types";

export function createLocalConnection(): Connection {
  const exec = (command: string): Promise<ExecResult> => {
    return new Promise((resolve) => {
      cpExec(command, (error, stdout, stderr) => {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: error ? error.code ?? 1 : 0,
        });
      });
    });
  };

  const streamExec = (
    command: string,
    callbacks: StreamExecCallbacks
  ): Promise<ExecResult> => {
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        stdout += str;
        callbacks.onStdout?.(str);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const str = chunk.toString();
        stderr += str;
        callbacks.onStderr?.(str);
      });

      child.on("close", (code: number | null) => {
        resolve({
          stdout,
          stderr,
          code: code ?? 0,
        });
      });
    });
  };

  const close = async (): Promise<void> => {
    // No-op for local connections
  };

  return { exec, streamExec, close };
}
