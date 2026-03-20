export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Exec = (command: string) => Promise<ExecResult>;
