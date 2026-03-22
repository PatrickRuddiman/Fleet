import { FleetConfig } from "../config";
import { ParsedComposeFile } from "../compose";
import { Connection } from "../ssh";
import { FleetState } from "../state";

export interface DeployOptions {
  skipPull: boolean;
  noHealthCheck: boolean;
  dryRun: boolean;
  force: boolean;
}

export interface DeployContext {
  config: FleetConfig;
  compose: ParsedComposeFile;
  connection: Connection;
  state: FleetState;
  fleetRoot: string;
  stackDir: string;
  warnings: string[];
}

export interface HostCollision {
  host: string;
  ownedByStack: string;
}

export interface UploadFileOptions {
  content: string;
  remotePath: string;
  permissions?: string;
}
