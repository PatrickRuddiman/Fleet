export { ExecResult, ExecFn } from "../ssh/types";

export interface RouteState {
  host: string;
  service: string;
  port: number;
  caddy_id: string;
}

export interface ServiceState {
  definition_hash: string;
  image_digest: string;
  env_hash: string;
  deployed_at: string;
  one_shot: boolean;
  status: string;
}

export interface StackState {
  path: string;
  compose_file: string;
  deployed_at: string;
  routes: RouteState[];
  env_hash?: string;
  services?: Record<string, ServiceState>;
}

export interface FleetState {
  fleet_root: string;
  caddy_bootstrapped: boolean;
  stacks: Record<string, StackState>;
}
