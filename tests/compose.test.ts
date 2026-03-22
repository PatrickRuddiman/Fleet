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

describe("new ParsedService fields", () => {
  it("should capture all new service fields when present", () => {
    const filePath = writeCompose(`
services:
  app:
    image: "node:18"
    build: "."
    command: "npm start"
    entrypoint: "/entrypoint.sh"
    environment:
      NODE_ENV: production
      PORT: "3000"
    restart: "unless-stopped"
    volumes:
      - "data:/app/data"
      - "/host/path:/container/path"
    labels:
      com.example.description: "My app"
      com.example.env: "production"
    user: "node"
    working_dir: "/app"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000"]
      interval: "30s"
      timeout: "10s"
      retries: 3
    ports:
      - "3000:3000"
`);
    const result = loadComposeFile(filePath);
    const app = result.services.app;
    expect(app.image).toBe("node:18");
    expect(app.command).toBe("npm start");
    expect(app.entrypoint).toBe("/entrypoint.sh");
    expect(app.environment).toEqual({ NODE_ENV: "production", PORT: "3000" });
    expect(app.restart).toBe("unless-stopped");
    expect(app.volumes).toEqual(["data:/app/data", "/host/path:/container/path"]);
    expect(app.labels).toEqual({ "com.example.description": "My app", "com.example.env": "production" });
    expect(app.user).toBe("node");
    expect(app.working_dir).toBe("/app");
    expect(app.healthcheck).toEqual({ test: ["CMD", "curl", "-f", "http://localhost:3000"], interval: "30s", timeout: "10s", retries: 3 });
    expect(app.hasImage).toBe(true);
    expect(app.hasBuild).toBe(true);
    expect(app.ports).toEqual([{ published: 3000, target: 3000 }]);
  });

  it("should return undefined for absent optional fields", () => {
    const filePath = writeCompose(`
services:
  minimal:
    image: nginx
`);
    const result = loadComposeFile(filePath);
    const minimal = result.services.minimal;
    expect(minimal.hasImage).toBe(true);
    expect(minimal.image).toBe("nginx");
    expect(minimal.command).toBeUndefined();
    expect(minimal.entrypoint).toBeUndefined();
    expect(minimal.environment).toBeUndefined();
    expect(minimal.restart).toBeUndefined();
    expect(minimal.volumes).toBeUndefined();
    expect(minimal.labels).toBeUndefined();
    expect(minimal.user).toBeUndefined();
    expect(minimal.working_dir).toBeUndefined();
    expect(minimal.healthcheck).toBeUndefined();
  });

  it("should parse command and entrypoint as string form", () => {
    const filePath = writeCompose(`
services:
  str:
    image: nginx
    command: "nginx -g 'daemon off;'"
    entrypoint: "/docker-entrypoint.sh"
`);
    const result = loadComposeFile(filePath);
    const str = result.services.str;
    expect(str.command).toBe("nginx -g 'daemon off;'");
    expect(str.entrypoint).toBe("/docker-entrypoint.sh");
  });

  it("should parse command and entrypoint as array form", () => {
    const filePath = writeCompose(`
services:
  arr:
    image: nginx
    command: ["nginx", "-g", "daemon off;"]
    entrypoint: ["/docker-entrypoint.sh", "nginx"]
`);
    const result = loadComposeFile(filePath);
    const arr = result.services.arr;
    expect(arr.command).toEqual(["nginx", "-g", "daemon off;"]);
    expect(arr.entrypoint).toEqual(["/docker-entrypoint.sh", "nginx"]);
  });

  it("should parse environment as map form", () => {
    const filePath = writeCompose(`
services:
  mapenv:
    image: nginx
    environment:
      FOO: bar
      BAZ: "123"
`);
    const result = loadComposeFile(filePath);
    const mapenv = result.services.mapenv;
    expect(mapenv.environment).toEqual({ FOO: "bar", BAZ: "123" });
  });

  it("should parse environment as array form", () => {
    const filePath = writeCompose(`
services:
  arrenv:
    image: nginx
    environment:
      - FOO=bar
      - BAZ=123
`);
    const result = loadComposeFile(filePath);
    const arrenv = result.services.arrenv;
    expect(arrenv.environment).toEqual(["FOO=bar", "BAZ=123"]);
  });
});
