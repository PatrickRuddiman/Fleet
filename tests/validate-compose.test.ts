import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import yaml from "yaml";
import { loadFleetConfig } from "../src/config";
import { loadComposeFile } from "../src/compose";
import { runAllChecks, Finding, Codes } from "../src/validation";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-validate-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFleetConfig(config: object): string {
  const filePath = path.join(tmpDir, "fleet.yml");
  fs.writeFileSync(filePath, yaml.stringify(config), "utf-8");
  return filePath;
}

function writeComposeFile(content: string, filename = "docker-compose.yml"): string {
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function runValidation(config: any, compose: any) {
  const findings = runAllChecks(config, compose);
  const errors = findings.filter((f: Finding) => f.severity === "error");
  const warnings = findings.filter((f: Finding) => f.severity === "warning");
  return { errors, warnings, findings };
}

describe("validate compose integration", () => {
  it("valid compose file with matching services produces no errors", () => {
    const fleetPath = writeFleetConfig({
      version: "1",
      server: { host: "192.168.1.1" },
      stack: { name: "myapp" },
      routes: [
        { domain: "example.com", port: 3000, service: "web" },
        { domain: "api.example.com", port: 8080, service: "api" },
      ],
    });

    writeComposeFile(
      `services:
  web:
    image: nginx
  api:
    image: "node:18"
`
    );

    const config = loadFleetConfig(fleetPath);
    const composePath = path.resolve(path.dirname(fleetPath), config.stack.compose_file);
    const compose = loadComposeFile(composePath);
    const { errors, warnings } = runValidation(config, compose);

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("compose file missing a referenced service produces an error", () => {
    const fleetPath = writeFleetConfig({
      version: "1",
      server: { host: "192.168.1.1" },
      stack: { name: "myapp" },
      routes: [
        { domain: "example.com", port: 3000, service: "web" },
        { domain: "worker.example.com", port: 4000, service: "worker" },
      ],
    });

    writeComposeFile(
      `services:
  web:
    image: nginx
`
    );

    const config = loadFleetConfig(fleetPath);
    const composePath = path.resolve(path.dirname(fleetPath), config.stack.compose_file);
    const compose = loadComposeFile(composePath);
    const { errors } = runValidation(config, compose);

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(Codes.SERVICE_NOT_FOUND);
    expect(errors[0].message).toContain("worker");
  });

  it("compose file with port 80/443 bindings produces errors", () => {
    const fleetPath = writeFleetConfig({
      version: "1",
      server: { host: "192.168.1.1" },
      stack: { name: "myapp" },
      routes: [{ domain: "example.com", port: 3000 }],
    });

    writeComposeFile(
      `services:
  web:
    image: nginx
    ports:
      - "80:80"
  proxy:
    image: nginx
    ports:
      - "443:443"
`
    );

    const config = loadFleetConfig(fleetPath);
    const composePath = path.resolve(path.dirname(fleetPath), config.stack.compose_file);
    const compose = loadComposeFile(composePath);
    const { errors } = runValidation(config, compose);

    expect(errors).toHaveLength(2);
    expect(errors.some((e: Finding) => e.code === Codes.PORT_80_CONFLICT)).toBe(true);
    expect(errors.some((e: Finding) => e.code === Codes.PORT_443_CONFLICT)).toBe(true);
  });

  it("compose file with other host port bindings produces warnings", () => {
    const fleetPath = writeFleetConfig({
      version: "1",
      server: { host: "192.168.1.1" },
      stack: { name: "myapp" },
      routes: [{ domain: "example.com", port: 3000 }],
    });

    writeComposeFile(
      `services:
  web:
    image: nginx
    ports:
      - "8080:80"
  api:
    image: "node:18"
    ports:
      - "3000:3000"
`
    );

    const config = loadFleetConfig(fleetPath);
    const composePath = path.resolve(path.dirname(fleetPath), config.stack.compose_file);
    const compose = loadComposeFile(composePath);
    const { errors, warnings } = runValidation(config, compose);

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w: Finding) => w.code === Codes.PORT_EXPOSED && w.message.includes("8080"))).toBe(true);
    expect(warnings.some((w: Finding) => w.code === Codes.PORT_EXPOSED && w.message.includes("3000"))).toBe(true);
  });
});
