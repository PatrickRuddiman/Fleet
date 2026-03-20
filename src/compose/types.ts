export interface NormalizedPort {
  published: number | null;
  target: number;
}

export interface ParsedService {
  hasImage: boolean;
  hasBuild: boolean;
  ports: NormalizedPort[];
}

export interface ParsedComposeFile {
  services: Record<string, ParsedService>;
}

export interface HostPortBinding {
  service: string;
  hostPort: number;
}
