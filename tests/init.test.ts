import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import yaml from "yaml";
import { slugify, detectComposeFile, generateFleetYml } from "../src/init";
import { ParsedComposeFile } from "../src/compose/types";
import { createProgram } from "../src/cli";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-init-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("should handle normal directory names", () => {
    expect(slugify("my-project")).toBe("my-project");
    expect(slugify("app")).toBe("app");
  });

  it("should lowercase uppercase letters", () => {
    expect(slugify("MyProject")).toBe("myproject");
  });

  it("should replace special characters with hyphens", () => {
    expect(slugify("my_project!")).toBe("my-project");
  });

  it("should handle mixed uppercase and special characters", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
  });

  it("should preserve digits", () => {
    expect(slugify("app123")).toBe("app123");
    expect(slugify("123app")).toBe("123app");
  });

  it("should collapse consecutive non-matching characters into a single hyphen", () => {
    expect(slugify("a___b")).toBe("a-b");
  });

  it("should return null for all special characters", () => {
    expect(slugify("@#$%^&")).toBeNull();
  });

  it("should strip leading hyphens after slugification", () => {
    expect(slugify("---abc")).toBe("abc");
  });

  it("should return null for names that reduce to only hyphens", () => {
    expect(slugify("---")).toBeNull();
    expect(slugify("___")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(slugify("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectComposeFile
// ---------------------------------------------------------------------------

describe("detectComposeFile", () => {
  it("should detect compose.yml when present", () => {
    fs.writeFileSync(path.join(tmpDir, "compose.yml"), "", "utf-8");
    expect(detectComposeFile(tmpDir)).toBe("compose.yml");
  });

  it("should detect compose.yaml when present", () => {
    fs.writeFileSync(path.join(tmpDir, "compose.yaml"), "", "utf-8");
    expect(detectComposeFile(tmpDir)).toBe("compose.yaml");
  });

  it("should prefer compose.yml when both are present", () => {
    fs.writeFileSync(path.join(tmpDir, "compose.yml"), "", "utf-8");
    fs.writeFileSync(path.join(tmpDir, "compose.yaml"), "", "utf-8");
    expect(detectComposeFile(tmpDir)).toBe("compose.yml");
  });

  it("should default to compose.yml when neither is present", () => {
    expect(detectComposeFile(tmpDir)).toBe("compose.yml");
  });
});

// ---------------------------------------------------------------------------
// generateFleetYml
// ---------------------------------------------------------------------------

describe("generateFleetYml", () => {
  const multiServiceCompose: ParsedComposeFile = {
    services: {
      web: {
        hasImage: true,
        hasBuild: false,
        ports: [{ published: 8080, target: 80 }],
      },
      api: {
        hasImage: true,
        hasBuild: false,
        ports: [{ published: 3000, target: 3000 }],
      },
      db: {
        hasImage: true,
        hasBuild: false,
        ports: [],
      },
      redis: {
        hasImage: true,
        hasBuild: false,
        ports: [],
      },
    },
  };

  it("should generate correct structure from multi-service compose file", () => {
    const output = generateFleetYml({
      compose: multiServiceCompose,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });
    const result = yaml.parse(output);

    expect(result.version).toBe("1");
    expect(result.server.host).toBe("YOUR_SERVER_IP");
    expect(result.stack.name).toBe("myapp");
    expect(result.stack.compose_file).toBe("compose.yml");
    expect(result.routes).toHaveLength(2);
    expect(result.routes[0]).toEqual({
      domain: "web.myapp.example.com",
      port: 80,
      service: "web",
      acme_email: "you@example.com",
    });
    expect(result.routes[1]).toEqual({
      domain: "api.myapp.example.com",
      port: 3000,
      service: "api",
      acme_email: "you@example.com",
    });
  });

  it("should skip services without ports", () => {
    const output = generateFleetYml({
      compose: multiServiceCompose,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });
    const result = yaml.parse(output);

    const serviceNames = result.routes.map((r: any) => r.service);
    expect(serviceNames).not.toContain("db");
    expect(serviceNames).not.toContain("redis");
  });

  it("should produce TODO comments on placeholder fields", () => {
    const output = generateFleetYml({
      compose: multiServiceCompose,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });

    expect(output).toContain("TODO: Replace with your server IP or hostname");
    expect(output).toContain("TODO: Replace with actual public domain");
    expect(output).toContain("TODO: Replace with your ACME email for TLS certificates");
  });

  it("should set port to 0 with TODO for ambiguous ports", () => {
    const ambiguousCompose: ParsedComposeFile = {
      services: {
        app: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: null, target: 0 }],
        },
      },
    };
    const output = generateFleetYml({
      compose: ambiguousCompose,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });
    const result = yaml.parse(output);

    expect(result.routes[0].port).toBe(0);
    expect(output).toContain("TODO: Replace with the correct container port");
  });

  it("should generate correct domain placeholders", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 8080, target: 80 }],
        },
      },
    };
    const output = generateFleetYml({
      compose,
      stackName: "cool-app",
      composeFilename: "compose.yml",
    });
    const result = yaml.parse(output);

    expect(result.routes[0].domain).toBe("web.cool-app.example.com");
  });

  it("should include skipped-services comment", () => {
    const output = generateFleetYml({
      compose: multiServiceCompose,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });

    expect(output).toContain("Skipped services (no port mappings): db, redis");
  });

  it("should produce valid YAML that can be re-parsed", () => {
    const output = generateFleetYml({
      compose: multiServiceCompose,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });
    const result = yaml.parse(output);

    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("server");
    expect(result).toHaveProperty("stack");
    expect(result).toHaveProperty("routes");
  });

  it("should handle null compose (no compose file found)", () => {
    const output = generateFleetYml({
      compose: null,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });
    const result = yaml.parse(output);

    expect(output).toContain("No compose file found. Add your routes manually.");
    expect(result.routes).toEqual([]);
  });

  it("should handle compose with zero routed services and no skipped services", () => {
    const emptyCompose: ParsedComposeFile = {
      services: {},
    };
    const output = generateFleetYml({
      compose: emptyCompose,
      stackName: "myapp",
      composeFilename: "compose.yml",
    });
    const result = yaml.parse(output);

    expect(output).toContain("No services with port mappings found. Add your routes manually.");
    expect(result.routes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// init command handler
// ---------------------------------------------------------------------------

describe("init command handler", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(tmpDir, "my-project");
    fs.mkdirSync(projectDir);
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  it("should refuse to overwrite without --force", async () => {
    fs.writeFileSync(path.join(projectDir, "fleet.yml"), "existing", "utf-8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createProgram();
    await expect(program.parseAsync(["node", "fleet", "init"])).rejects.toThrow("process.exit(1)");

    expect(errorSpy).toHaveBeenCalledWith(
      "fleet.yml already exists. Use --force to overwrite."
    );
  });

  it("should overwrite with --force", async () => {
    fs.writeFileSync(path.join(projectDir, "fleet.yml"), "existing", "utf-8");
    fs.writeFileSync(
      path.join(projectDir, "compose.yml"),
      "services:\n  web:\n    image: nginx\n    ports:\n      - \"8080:80\"\n",
      "utf-8"
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "fleet", "init", "--force"]);

    const content = fs.readFileSync(path.join(projectDir, "fleet.yml"), "utf-8");
    expect(content).not.toBe("existing");
    const parsed = yaml.parse(content);
    expect(parsed.version).toBe("1");
    expect(parsed.stack.name).toBe("my-project");
  });

  it("should handle missing compose file gracefully", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram();
    await program.parseAsync(["node", "fleet", "init"]);

    const content = fs.readFileSync(path.join(projectDir, "fleet.yml"), "utf-8");
    expect(content).toContain("No compose file found. Add your routes manually.");
    const parsed = yaml.parse(content);
    expect(parsed.version).toBe("1");
    expect(parsed.stack.name).toBe("my-project");
    expect(parsed.routes).toEqual([]);
  });
});
