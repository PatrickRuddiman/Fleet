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

  return { hasImage, hasBuild, ports };
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
