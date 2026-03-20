import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  loadComposeFile,
  getServiceNames,
  serviceExists,
  findServicesWithoutImageOrBuild,
  findHostPortBindings,
  findReservedPortConflicts,
} from "../src/compose";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-compose-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCompose(content: string): string {
  const filePath = path.join(tmpDir, "docker-compose.yml");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("loadComposeFile", () => {
  it("should parse a minimal compose file", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web).toBeDefined();
    expect(result.services.web.hasImage).toBe(true);
    expect(result.services.web.hasBuild).toBe(false);
    expect(result.services.web.ports).toEqual([]);
  });

  it("should parse a service with image only", () => {
    const filePath = writeCompose(`
services:
  app:
    image: "node:18"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.app.hasImage).toBe(true);
    expect(result.services.app.hasBuild).toBe(false);
  });

  it("should parse a service with build as string", () => {
    const filePath = writeCompose(`
services:
  app:
    build: "."
`);
    const result = loadComposeFile(filePath);
    expect(result.services.app.hasImage).toBe(false);
    expect(result.services.app.hasBuild).toBe(true);
  });

  it("should parse a service with build as object", () => {
    const filePath = writeCompose(`
services:
  app:
    build:
      context: "."
      dockerfile: Dockerfile
`);
    const result = loadComposeFile(filePath);
    expect(result.services.app.hasImage).toBe(false);
    expect(result.services.app.hasBuild).toBe(true);
  });

  it("should parse a service with both image and build", () => {
    const filePath = writeCompose(`
services:
  app:
    image: "myapp:latest"
    build: "."
`);
    const result = loadComposeFile(filePath);
    expect(result.services.app.hasImage).toBe(true);
    expect(result.services.app.hasBuild).toBe(true);
  });

  it("should parse a service with neither image nor build", () => {
    const filePath = writeCompose(`
services:
  app:
    ports:
      - "3000"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.app.hasImage).toBe(false);
    expect(result.services.app.hasBuild).toBe(false);
  });

  it("should parse multiple services", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
  api:
    image: "node:18"
  db:
    image: "postgres:15"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web).toBeDefined();
    expect(result.services.api).toBeDefined();
    expect(result.services.db).toBeDefined();
  });
});

describe("port normalization", () => {
  it("should normalize string shorthand host:container", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web.ports[0]).toEqual({ published: 8080, target: 80 });
  });

  it("should normalize string shorthand container only", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web.ports[0]).toEqual({ published: null, target: 80 });
  });

  it("should normalize string with host_ip prefix", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "127.0.0.1:8080:80"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web.ports[0]).toEqual({ published: 8080, target: 80 });
  });

  it("should normalize string with protocol suffix", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "8080:80/tcp"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web.ports[0]).toEqual({ published: 8080, target: 80 });
  });

  it("should normalize long-form object ports", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - target: 80
        published: 8080
        protocol: tcp
        host_ip: "0.0.0.0"
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web.ports[0]).toEqual({ published: 8080, target: 80 });
  });

  it("should handle service with no ports field", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
`);
    const result = loadComposeFile(filePath);
    expect(result.services.web.ports).toEqual([]);
  });
});

describe("getServiceNames", () => {
  it("should return all service names", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
  api:
    image: "node:18"
  db:
    image: "postgres:15"
`);
    const compose = loadComposeFile(filePath);
    const names = getServiceNames(compose);
    expect(names.sort()).toEqual(["api", "db", "web"]);
  });
});

describe("serviceExists", () => {
  it("should return true for an existing service", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
`);
    const compose = loadComposeFile(filePath);
    expect(serviceExists(compose, "web")).toBe(true);
  });

  it("should return false for a non-existing service", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
`);
    const compose = loadComposeFile(filePath);
    expect(serviceExists(compose, "nonexistent")).toBe(false);
  });
});

describe("findServicesWithoutImageOrBuild", () => {
  it("should find services missing both image and build", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
  worker:
    ports:
      - "3000"
`);
    const compose = loadComposeFile(filePath);
    const result = findServicesWithoutImageOrBuild(compose);
    expect(result).toContain("worker");
    expect(result).not.toContain("web");
  });

  it("should return empty array when all services have image or build", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
  app:
    build: "."
`);
    const compose = loadComposeFile(filePath);
    const result = findServicesWithoutImageOrBuild(compose);
    expect(result).toEqual([]);
  });
});

describe("findHostPortBindings", () => {
  it("should find host port bindings", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
  api:
    image: "node:18"
    ports:
      - "3000:3000"
`);
    const compose = loadComposeFile(filePath);
    const bindings = findHostPortBindings(compose);
    expect(bindings).toContainEqual({ service: "web", hostPort: 8080 });
    expect(bindings).toContainEqual({ service: "api", hostPort: 3000 });
  });

  it("should return empty array when no host ports are bound", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80"
`);
    const compose = loadComposeFile(filePath);
    const bindings = findHostPortBindings(compose);
    expect(bindings).toEqual([]);
  });
});

describe("findReservedPortConflicts", () => {
  it("should identify port 80 as reserved conflict", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80:80"
`);
    const compose = loadComposeFile(filePath);
    const conflicts = findReservedPortConflicts(compose);
    expect(conflicts).toContainEqual(expect.objectContaining({ hostPort: 80 }));
  });

  it("should identify port 443 as reserved conflict", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "443:443"
`);
    const compose = loadComposeFile(filePath);
    const conflicts = findReservedPortConflicts(compose);
    expect(conflicts).toContainEqual(expect.objectContaining({ hostPort: 443 }));
  });

  it("should not flag non-reserved ports", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
`);
    const compose = loadComposeFile(filePath);
    const conflicts = findReservedPortConflicts(compose);
    expect(conflicts).toEqual([]);
  });

  it("should identify multiple reserved port conflicts", () => {
    const filePath = writeCompose(`
services:
  web:
    image: nginx
    ports:
      - "80:80"
  proxy:
    image: nginx
    ports:
      - "443:443"
`);
    const compose = loadComposeFile(filePath);
    const conflicts = findReservedPortConflicts(compose);
    expect(conflicts).toHaveLength(2);
    expect(conflicts).toContainEqual(expect.objectContaining({ hostPort: 80 }));
    expect(conflicts).toContainEqual(expect.objectContaining({ hostPort: 443 }));
  });
});

describe("error cases", () => {
  it("should throw when file is not found", () => {
    const nonExistentPath = path.join(tmpDir, "nonexistent.yml");
    expect(() => loadComposeFile(nonExistentPath)).toThrow("Could not read compose file");
  });

  it("should throw on invalid YAML", () => {
    const filePath = writeCompose(`
services:
  web:
    - invalid: [unterminated
`);
    expect(() => loadComposeFile(filePath)).toThrow("Invalid YAML in compose file");
  });

  it("should return empty services when services key is missing", () => {
    const filePath = writeCompose(`
version: "3"
`);
    const result = loadComposeFile(filePath);
    expect(result.services).toEqual({});
  });
});
