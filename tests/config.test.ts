import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import yaml from "yaml";
import { fleetConfigSchema } from "../src/config/schema";
import { loadFleetConfig } from "../src/config/loader";

describe("fleetConfigSchema", () => {
  const minimalConfig = {
    version: "1" as const,
    server: { host: "192.168.1.1" },
    stack: { name: "myapp" },
    routes: [{ domain: "example.com", port: 3000 }],
  };

  describe("valid minimal config", () => {
    it("should parse a minimal valid config", () => {
      const result = fleetConfigSchema.parse(minimalConfig);

      expect(result.version).toBe("1");
      expect(result.server.host).toBe("192.168.1.1");
      expect(result.stack.name).toBe("myapp");
      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].domain).toBe("example.com");
      expect(result.routes[0].port).toBe(3000);
    });
  });

  describe("valid full config with all fields", () => {
    it("should parse a full config with all optional fields", () => {
      const fullConfig = {
        version: "1" as const,
        server: { host: "10.0.0.1", port: 2222, user: "deploy" },
        stack: { name: "web-app", compose_file: "compose.prod.yml" },
        env: {
          entries: [
            { key: "NODE_ENV", value: "production" },
            { key: "PORT", value: "3000" },
          ],
          infisical: { token: "$INFISICAL_TOKEN", project_id: "proj-123", environment: "prod" },
        },
        routes: [
          {
            domain: "app.example.com",
            port: 3000,
            tls: true,
            acme_email: "admin@example.com",
            health_check: {
              path: "/health",
              timeout_seconds: 60,
              interval_seconds: 10,
            },
          },
        ],
      };

      const result = fleetConfigSchema.parse(fullConfig);
      const env = result.env as { entries?: { key: string; value: string }[]; infisical?: { project_id: string; token: string; path: string } };

      expect(result.server.port).toBe(2222);
      expect(result.server.user).toBe("deploy");
      expect(result.stack.compose_file).toBe("compose.prod.yml");
      expect(env.entries).toHaveLength(2);
      expect(env.infisical!.project_id).toBe("proj-123");
      expect(env.infisical!.token).toBe("$INFISICAL_TOKEN");
      expect(env.infisical!.path).toBe("/");
      expect(result.routes[0].acme_email).toBe("admin@example.com");
      expect(result.routes[0].health_check!.timeout_seconds).toBe(60);
    });
  });

  describe("default value application", () => {
    it("should default server.port to 22", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.server.port).toBe(22);
    });

    it("should default server.user to 'root'", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.server.user).toBe("root");
    });

    it("should default stack.compose_file to 'docker-compose.yml'", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.stack.compose_file).toBe("docker-compose.yml");
    });

    it("should default route.tls to true", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.routes[0].tls).toBe(true);
    });

    it("should default health_check.timeout_seconds to 60", () => {
      const config = {
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, health_check: { path: "/health" } }],
      };
      const result = fleetConfigSchema.parse(config);
      expect(result.routes[0].health_check!.timeout_seconds).toBe(60);
    });

    it("should default health_check.interval_seconds to 2", () => {
      const config = {
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, health_check: { path: "/health" } }],
      };
      const result = fleetConfigSchema.parse(config);
      expect(result.routes[0].health_check!.interval_seconds).toBe(2);
    });

    it("should default health_check.path to '/'", () => {
      const config = {
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, health_check: {} }],
      };
      const result = fleetConfigSchema.parse(config);
      expect(result.routes[0].health_check!.path).toBe("/");
    });
  });

  describe("validation failures", () => {
    it("should reject config missing version", () => {
      const { version, ...noVersion } = minimalConfig;
      const result = fleetConfigSchema.safeParse(noVersion);
      expect(result.success).toBe(false);
    });

    it("should reject config missing server", () => {
      const { server, ...noServer } = minimalConfig;
      const result = fleetConfigSchema.safeParse(noServer);
      expect(result.success).toBe(false);
    });

    it("should reject config missing stack", () => {
      const { stack, ...noStack } = minimalConfig;
      const result = fleetConfigSchema.safeParse(noStack);
      expect(result.success).toBe(false);
    });

    it("should reject config missing routes", () => {
      const { routes, ...noRoutes } = minimalConfig;
      const result = fleetConfigSchema.safeParse(noRoutes);
      expect(result.success).toBe(false);
    });

    it("should reject config missing server.host", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        server: {},
      });
      expect(result.success).toBe(false);
    });

    it("should reject config missing stack.name", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        stack: {},
      });
      expect(result.success).toBe(false);
    });
  });

  describe("invalid stack name patterns", () => {
    it("should reject stack name starting with hyphen", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        stack: { name: "-myapp" },
      });
      expect(result.success).toBe(false);
    });

    it("should reject stack name with uppercase", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        stack: { name: "MyApp" },
      });
      expect(result.success).toBe(false);
    });

    it("should reject stack name with special characters", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        stack: { name: "my_app" },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("invalid email format", () => {
    it("should reject invalid acme_email", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, acme_email: "not-an-email" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("empty routes array", () => {
    it("should reject empty routes array", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        routes: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("wrong types", () => {
    it("should reject non-string server host", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        server: { host: 123 },
      });
      expect(result.success).toBe(false);
    });

    it("should reject non-number route port", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        routes: [{ domain: "x.com", port: "80" }],
      });
      expect(result.success).toBe(false);
    });

    it("should reject non-boolean tls", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        routes: [{ domain: "x.com", port: 80, tls: "yes" }],
      });
      expect(result.success).toBe(false);
    });

    it("should reject wrong version value", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        version: "2",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("route service field", () => {
    it("should parse when service is present", () => {
      const config = {
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, service: "web" }],
      };
      const result = fleetConfigSchema.parse(config);
      expect(result.routes[0].service).toBe("web");
    });

    it("should be undefined when service is absent", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.routes[0].service).toBeUndefined();
    });

    it("should reject non-string service value", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, service: 123 }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("server identity_file field", () => {
    it("should parse when identity_file is present", () => {
      const config = {
        ...minimalConfig,
        server: { host: "192.168.1.1", identity_file: "~/.ssh/id_rsa" },
      };
      const result = fleetConfigSchema.parse(config);
      expect(result.server.identity_file).toBe("~/.ssh/id_rsa");
    });

    it("should be undefined when identity_file is absent", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.server.identity_file).toBeUndefined();
    });
  });

  describe("error message content", () => {
    it("should include field path in error for missing server.host", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        server: {},
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path);
        expect(paths).toContainEqual(["server", "host"]);
      }
    });

    it("should include descriptive message for invalid stack name", () => {
      const result = fleetConfigSchema.safeParse({
        ...minimalConfig,
        stack: { name: "INVALID!" },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const stackIssue = result.error.issues.find(
          (i) => i.path[0] === "stack" && i.path[1] === "name"
        );
        expect(stackIssue).toBeDefined();
        expect(stackIssue!.message).toBeTruthy();
      }
    });
  });

  describe("env.infisical schema", () => {
    it("should parse a valid env.infisical block with all fields", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            token: "$INFISICAL_TOKEN",
            project_id: "proj-abc-123",
            environment: "production",
            path: "/backend",
          },
        },
      };
      const result = fleetConfigSchema.parse(config);
      const env = result.env as { entries?: unknown[]; infisical?: { token: string; project_id: string; environment: string; path: string } };
      expect(env.infisical!.token).toBe("$INFISICAL_TOKEN");
      expect(env.infisical!.project_id).toBe("proj-abc-123");
      expect(env.infisical!.environment).toBe("production");
      expect(env.infisical!.path).toBe("/backend");
    });

    it("should default infisical path to '/'", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            token: "$INFISICAL_TOKEN",
            project_id: "proj-123",
            environment: "dev",
          },
        },
      };
      const result = fleetConfigSchema.parse(config);
      const env = result.env as { infisical?: { path: string } };
      expect(env.infisical!.path).toBe("/");
    });

    it("should reject infisical block missing token", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            project_id: "proj-123",
            environment: "prod",
          },
        },
      };
      const result = fleetConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject infisical block missing project_id", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            token: "$TOKEN",
            environment: "prod",
          },
        },
      };
      const result = fleetConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject infisical block missing environment", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            token: "$TOKEN",
            project_id: "proj-123",
          },
        },
      };
      const result = fleetConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should accept token as env var reference starting with $", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            token: "$MY_SECRET_TOKEN",
            project_id: "proj-123",
            environment: "prod",
          },
        },
      };
      const result = fleetConfigSchema.parse(config);
      const env = result.env as { infisical?: { token: string } };
      expect(env.infisical!.token).toBe("$MY_SECRET_TOKEN");
    });

    it("should accept token as a literal string value", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            token: "st.abc123.xyz789",
            project_id: "proj-123",
            environment: "prod",
          },
        },
      };
      const result = fleetConfigSchema.parse(config);
      const env = result.env as { infisical?: { token: string } };
      expect(env.infisical!.token).toBe("st.abc123.xyz789");
    });

    it("should reject non-string token value", () => {
      const config = {
        ...minimalConfig,
        env: {
          infisical: {
            token: 12345,
            project_id: "proj-123",
            environment: "prod",
          },
        },
      };
      const result = fleetConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should parse env with only entries (no infisical)", () => {
      const config = {
        ...minimalConfig,
        env: {
          entries: [
            { key: "NODE_ENV", value: "production" },
            { key: "PORT", value: "3000" },
          ],
        },
      };
      const result = fleetConfigSchema.parse(config);
      const env = result.env as { entries?: { key: string; value: string }[]; infisical?: unknown };
      expect(env.entries).toHaveLength(2);
      expect(env.entries![0].key).toBe("NODE_ENV");
      expect(env.entries![0].value).toBe("production");
      expect(env.infisical).toBeUndefined();
    });

    it("should parse env with both entries and infisical", () => {
      const config = {
        ...minimalConfig,
        env: {
          entries: [{ key: "EXTRA_VAR", value: "extra-value" }],
          infisical: {
            token: "$TOKEN",
            project_id: "proj-123",
            environment: "staging",
          },
        },
      };
      const result = fleetConfigSchema.parse(config);
      const env = result.env as { entries?: unknown[]; infisical?: { project_id: string } };
      expect(env.entries).toHaveLength(1);
      expect(env.infisical).toBeDefined();
      expect(env.infisical!.project_id).toBe("proj-123");
    });

    it("should parse config without env field at all", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.env).toBeUndefined();
    });
  });

  describe("env field union", () => {
    it("should accept env as an array of key-value objects", () => {
      const config = {
        ...minimalConfig,
        env: [
          { key: "NODE_ENV", value: "production" },
          { key: "PORT", value: "3000" },
        ],
      };
      const result = fleetConfigSchema.parse(config);
      expect(Array.isArray(result.env)).toBe(true);
      expect(result.env).toHaveLength(2);
      if (Array.isArray(result.env)) {
        expect(result.env[0].key).toBe("NODE_ENV");
        expect(result.env[0].value).toBe("production");
      }
    });

    it("should accept env as an object with a file field", () => {
      const config = {
        ...minimalConfig,
        env: { file: ".env.production" },
      };
      const result = fleetConfigSchema.parse(config);
      expect(Array.isArray(result.env)).toBe(false);
      expect(result.env).toEqual({ file: ".env.production" });
    });

    it("should accept config without env field", () => {
      const result = fleetConfigSchema.parse(minimalConfig);
      expect(result.env).toBeUndefined();
    });

    it("should reject env as a plain string", () => {
      const config = {
        ...minimalConfig,
        env: "not-valid",
      };
      const result = fleetConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should reject env as an array with invalid objects", () => {
      const config = {
        ...minimalConfig,
        env: [{ key: "FOO" }],
      };
      const result = fleetConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it("should accept env as an empty array", () => {
      const config = {
        ...minimalConfig,
        env: [],
      };
      const result = fleetConfigSchema.parse(config);
      expect(Array.isArray(result.env)).toBe(true);
      expect(result.env).toHaveLength(0);
    });
  });
});

describe("loadFleetConfig token expansion", () => {
  beforeEach(() => {
    vi.spyOn(fs, "readFileSync");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should expand $ENV_VAR token from process.env", () => {
    const yamlContent = yaml.stringify({
      version: "1",
      server: { host: "192.168.1.1" },
      stack: { name: "myapp" },
      env: {
        infisical: {
          token: "$MY_INFISICAL_TOKEN",
          project_id: "proj-123",
          environment: "prod",
        },
      },
      routes: [{ domain: "example.com", port: 3000 }],
    });
    vi.mocked(fs.readFileSync).mockReturnValue(yamlContent);

    process.env.MY_INFISICAL_TOKEN = "expanded-secret-token";
    try {
      const config = loadFleetConfig("fleet.yml");
      const env = config.env as { infisical?: { token: string } };
      expect(env.infisical!.token).toBe("expanded-secret-token");
    } finally {
      delete process.env.MY_INFISICAL_TOKEN;
    }
  });

  it("should throw when referenced env var is not set", () => {
    const yamlContent = yaml.stringify({
      version: "1",
      server: { host: "192.168.1.1" },
      stack: { name: "myapp" },
      env: {
        infisical: {
          token: "$MISSING_VAR",
          project_id: "proj-123",
          environment: "prod",
        },
      },
      routes: [{ domain: "example.com", port: 3000 }],
    });
    vi.mocked(fs.readFileSync).mockReturnValue(yamlContent);

    delete process.env.MISSING_VAR;
    expect(() => loadFleetConfig("fleet.yml")).toThrow(
      'Environment variable "MISSING_VAR" referenced by env.infisical.token in fleet.yml is not set'
    );
  });

  it("should not expand token that does not start with $", () => {
    const yamlContent = yaml.stringify({
      version: "1",
      server: { host: "192.168.1.1" },
      stack: { name: "myapp" },
      env: {
        infisical: {
          token: "literal-token-value",
          project_id: "proj-123",
          environment: "prod",
        },
      },
      routes: [{ domain: "example.com", port: 3000 }],
    });
    vi.mocked(fs.readFileSync).mockReturnValue(yamlContent);

    const config = loadFleetConfig("fleet.yml");
    const env = config.env as { infisical?: { token: string } };
    expect(env.infisical!.token).toBe("literal-token-value");
  });
});
