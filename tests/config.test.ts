import { describe, it, expect } from "vitest";
import { fleetConfigSchema } from "../src/config/schema";

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
        env: [
          { key: "NODE_ENV", value: "production" },
          { key: "PORT", value: "3000" },
        ],
        infisical: { project_id: "proj-123", environment: "prod" },
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

      expect(result.server.port).toBe(2222);
      expect(result.server.user).toBe("deploy");
      expect(result.stack.compose_file).toBe("compose.prod.yml");
      expect(result.env).toHaveLength(2);
      expect(result.infisical!.project_id).toBe("proj-123");
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

    it("should default health_check.timeout_seconds to 30", () => {
      const config = {
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, health_check: { path: "/health" } }],
      };
      const result = fleetConfigSchema.parse(config);
      expect(result.routes[0].health_check!.timeout_seconds).toBe(30);
    });

    it("should default health_check.interval_seconds to 5", () => {
      const config = {
        ...minimalConfig,
        routes: [{ domain: "example.com", port: 3000, health_check: { path: "/health" } }],
      };
      const result = fleetConfigSchema.parse(config);
      expect(result.routes[0].health_check!.interval_seconds).toBe(5);
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
});
