export interface RouteState {
  host: string;
  service: string;
  port: number;
  caddy_id: string;
}

export interface StackState {
  path: string;
  compose_file: string;
  deployed_at: string;
  routes: RouteState[];
}

export interface FleetState {
  fleet_root: string;
  caddy_bootstrapped: boolean;
  stacks: Record<string, StackState>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (command: string) => Promise<ExecResult>;
