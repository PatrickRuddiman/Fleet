import fs from "fs";
import yaml from "yaml";
import {
  NormalizedPort,
  ParsedService,
  ParsedComposeFile,
} from "./types";

function normalizePort(raw: unknown): NormalizedPort {
  if (typeof raw === "number") {
    return { published: null, target: raw };
  }

  if (typeof raw === "string") {
    // Strip trailing protocol suffix (e.g., /tcp, /udp)
    const withoutProtocol = raw.includes("/")
      ? raw.substring(0, raw.lastIndexOf("/"))
      : raw;
    const parts = withoutProtocol.split(":");

    if (parts.length === 1) {
      return { published: null, target: parseInt(parts[0], 10) };
    }
    if (parts.length === 2) {
      return {
        published: parseInt(parts[0], 10),
        target: parseInt(parts[1], 10),
      };
    }
    // 3 parts: IP:host:container
    return {
      published: parseInt(parts[1], 10),
      target: parseInt(parts[2], 10),
    };
  }

  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const target =
      typeof obj.target === "number"
        ? obj.target
        : typeof obj.target === "string"
          ? parseInt(obj.target, 10)
          : 0;
    let published: number | null = null;
    if (obj.published !== undefined && obj.published !== null) {
      published =
        typeof obj.published === "number"
          ? obj.published
          : parseInt(String(obj.published), 10);
    }
    return { published, target };
  }

  return { published: null, target: 0 };
}

function parseService(raw: Record<string, unknown>): ParsedService {
  const hasImage = typeof raw.image === "string" && raw.image.length > 0;
  const hasBuild = raw.build !== undefined && raw.build !== null;
  const rawPorts = Array.isArray(raw.ports) ? raw.ports : [];
  const ports: NormalizedPort[] = rawPorts.map(normalizePort);

  const image = typeof raw.image === "string" ? raw.image : undefined;
  const command = raw.command ?? undefined;
  const entrypoint = raw.entrypoint ?? undefined;
  const environment = raw.environment ?? undefined;
  const volumes = raw.volumes ?? undefined;
  const labels = raw.labels ?? undefined;
  const user = typeof raw.user === "string" ? raw.user : undefined;
  const working_dir = typeof raw.working_dir === "string" ? raw.working_dir : undefined;
  const healthcheck = raw.healthcheck ?? undefined;
  const restart = typeof raw.restart === "string" ? raw.restart : undefined;

  let restartPolicyMaxAttempts: number | undefined;
  if (
    raw.deploy !== null &&
    raw.deploy !== undefined &&
    typeof raw.deploy === "object"
  ) {
    const deploy = raw.deploy as Record<string, unknown>;
    if (
      deploy.restart_policy !== null &&
      deploy.restart_policy !== undefined &&
      typeof deploy.restart_policy === "object"
    ) {
      const restartPolicy = deploy.restart_policy as Record<string, unknown>;
      if (typeof restartPolicy.max_attempts === "number") {
        restartPolicyMaxAttempts = restartPolicy.max_attempts;
      }
    }
  }

  return {
    hasImage,
    hasBuild,
    ports,
    image,
    command,
    entrypoint,
    environment,
    volumes,
    labels,
    user,
    working_dir,
    healthcheck,
    restart,
    restartPolicyMaxAttempts,
  };
}

export function loadComposeFile(filePath: string): ParsedComposeFile {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Could not read compose file: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(content);
  } catch {
    throw new Error(`Invalid YAML in compose file: ${filePath}`);
  }

  const doc = parsed as Record<string, unknown> | null;
  const rawServices =
    doc && typeof doc === "object" && doc.services && typeof doc.services === "object"
      ? (doc.services as Record<string, unknown>)
      : {};

  const services: Record<string, ParsedService> = {};
  for (const [name, value] of Object.entries(rawServices)) {
    if (value && typeof value === "object") {
      services[name] = parseService(value as Record<string, unknown>);
    }
  }

  return { services };
}
