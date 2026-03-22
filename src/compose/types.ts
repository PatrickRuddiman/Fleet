export interface NormalizedPort {
  published: number | null;
  target: number;
}

export interface ParsedService {
  hasImage: boolean;
  hasBuild: boolean;
  ports: NormalizedPort[];
  image?: string;
  command?: unknown;
  entrypoint?: unknown;
  environment?: unknown;
  volumes?: unknown;
  labels?: unknown;
  user?: string;
  working_dir?: string;
  healthcheck?: unknown;
  restart?: string;
  restartPolicyMaxAttempts?: number;
}

export interface ParsedComposeFile {
  services: Record<string, ParsedService>;
}

export interface HostPortBinding {
  service: string;
  hostPort: number;
}
