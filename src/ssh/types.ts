export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (command: string) => Promise<ExecResult>;

export interface StreamExecCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export type StreamExecFn = (
  command: string,
  callbacks: StreamExecCallbacks
) => Promise<ExecResult>;

export interface Connection {
  exec: ExecFn;
  streamExec: StreamExecFn;
  close: () => Promise<void>;
}
