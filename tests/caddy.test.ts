import { describe, it, expect } from "vitest";
import {
  buildCaddyId,
  buildBootstrapCommand,
  buildAddRouteCommand,
  buildRemoveRouteCommand,
  buildListRoutesCommand,
  buildGetConfigCommand,
} from "../src/caddy";

function extractJsonPayload(command: string): unknown {
  const marker = "<< 'FLEET_JSON'\n";
  const start = command.indexOf(marker);
  if (start === -1) throw new Error("No heredoc marker found in command");
  const jsonPart = command.slice(start + marker.length);
  const end = jsonPart.lastIndexOf("\nFLEET_JSON");
  if (end === -1) throw new Error("No closing FLEET_JSON marker found");
  return JSON.parse(jsonPart.slice(0, end));
}

describe("buildCaddyId", () => {
  it("should join stack name and domain slug with double underscore", () => {
    expect(buildCaddyId("myapp", "app.example.com")).toBe("myapp__app-example-com");
  });

  it("should produce unique IDs for different domains on the same service", () => {
    const id1 = buildCaddyId("myapp", "app.example.com");
    const id2 = buildCaddyId("myapp", "www.example.com");
    expect(id1).toBe("myapp__app-example-com");
    expect(id2).toBe("myapp__www-example-com");
    expect(id1).not.toBe(id2);
  });

  it("should handle numeric-like stack names", () => {
    expect(buildCaddyId("app1", "api.example.com")).toBe("app1__api-example-com");
  });

  it("should handle hyphenated stack names", () => {
    expect(buildCaddyId("my-app", "my-domain.example.com")).toBe("my-app__my-domain-example-com");
  });
});

describe("buildBootstrapCommand", () => {
  describe("without options", () => {
    it("should target the fleet-proxy container with docker exec", () => {
      const result = buildBootstrapCommand();
      expect(result).toContain("docker exec -i fleet-proxy");
    });

    it("should use curl with silent and fail flags", () => {
      const result = buildBootstrapCommand();
      expect(result).toContain("curl -s -f");
    });

    it("should use POST method", () => {
      const result = buildBootstrapCommand();
      expect(result).toContain("-X POST");
    });

    it("should include Content-Type application/json header", () => {
      const result = buildBootstrapCommand();
      expect(result).toContain("Content-Type: application/json");
    });

    it("should POST to the /load endpoint", () => {
      const result = buildBootstrapCommand();
      expect(result).toContain("http://localhost:2019/load");
    });

    it("should include a valid JSON payload with HTTP server config", () => {
      const result = buildBootstrapCommand();
      const payload = extractJsonPayload(result) as Record<string, any>;
      expect(payload.apps.http.servers.fleet.listen).toEqual([":443", ":80"]);
      expect(payload.apps.http.servers.fleet.routes).toEqual([]);
    });

    it("should not include TLS config when no acme_email is provided", () => {
      const result = buildBootstrapCommand();
      const payload = extractJsonPayload(result) as Record<string, any>;
      expect(payload.apps.tls).toBeUndefined();
    });

    it("should use heredoc for stdin piping", () => {
      const result = buildBootstrapCommand();
      expect(result).toContain("<< 'FLEET_JSON'");
      expect(result).toMatch(/FLEET_JSON$/);
    });
  });

  describe("with acme_email option", () => {
    it("should include TLS automation config when acme_email is provided", () => {
      const result = buildBootstrapCommand({ acme_email: "admin@example.com" });
      const payload = extractJsonPayload(result) as Record<string, any>;
      expect(payload.apps.tls.automation.policies[0].issuers[0].module).toBe(
        "acme",
      );
      expect(payload.apps.tls.automation.policies[0].issuers[0].email).toBe(
        "admin@example.com",
      );
    });

    it("should still include HTTP server config when acme_email is provided", () => {
      const result = buildBootstrapCommand({ acme_email: "admin@example.com" });
      const payload = extractJsonPayload(result) as Record<string, any>;
      expect(payload.apps.http.servers.fleet.listen).toEqual([":443", ":80"]);
      expect(payload.apps.http.servers.fleet.routes).toEqual([]);
    });
  });
});

describe("buildAddRouteCommand", () => {
  const defaultOptions = {
    stackName: "myapp",
    serviceName: "web",
    domain: "myapp.example.com",
    upstreamHost: "myapp-web",
    upstreamPort: 3000,
  };

  it("should target the fleet-proxy container with docker exec", () => {
    const result = buildAddRouteCommand(defaultOptions);
    expect(result).toContain("docker exec -i fleet-proxy");
  });

  it("should use curl with silent and fail flags", () => {
    const result = buildAddRouteCommand(defaultOptions);
    expect(result).toContain("curl -s -f");
  });

  it("should use POST method", () => {
    const result = buildAddRouteCommand(defaultOptions);
    expect(result).toContain("-X POST");
  });

  it("should include Content-Type application/json header", () => {
    const result = buildAddRouteCommand(defaultOptions);
    expect(result).toContain("Content-Type: application/json");
  });

  it("should POST to the routes API path", () => {
    const result = buildAddRouteCommand(defaultOptions);
    expect(result).toContain(
      "http://localhost:2019/config/apps/http/servers/fleet/routes",
    );
  });

  it("should set @id using stack name and domain slug", () => {
    const result = buildAddRouteCommand(defaultOptions);
    const payload = extractJsonPayload(result) as Record<string, any>;
    expect(payload["@id"]).toBe("myapp__myapp-example-com");
  });

  it("should include host match for the domain", () => {
    const result = buildAddRouteCommand(defaultOptions);
    const payload = extractJsonPayload(result) as Record<string, any>;
    expect(payload.match[0].host).toEqual(["myapp.example.com"]);
  });

  it("should configure reverse_proxy handler", () => {
    const result = buildAddRouteCommand(defaultOptions);
    const payload = extractJsonPayload(result) as Record<string, any>;
    expect(payload.handle[0].handler).toBe("reverse_proxy");
  });

  it("should set upstream dial address with host and port", () => {
    const result = buildAddRouteCommand(defaultOptions);
    const payload = extractJsonPayload(result) as Record<string, any>;
    expect(payload.handle[0].upstreams[0].dial).toBe("myapp-web:3000");
  });

  it("should use heredoc for stdin piping", () => {
    const result = buildAddRouteCommand(defaultOptions);
    expect(result).toContain("<< 'FLEET_JSON'");
    expect(result).toMatch(/FLEET_JSON$/);
  });

  it("should handle domain names with subdomains and hyphens", () => {
    const result = buildAddRouteCommand({
      ...defaultOptions,
      domain: "sub-domain.my-app.example.co.uk",
    });
    const payload = extractJsonPayload(result) as Record<string, any>;
    expect(payload.match[0].host[0]).toBe("sub-domain.my-app.example.co.uk");
  });

  it("should produce unique @id for different domains regardless of service name", () => {
    const result1 = buildAddRouteCommand({ ...defaultOptions, domain: "app.example.com" });
    const result2 = buildAddRouteCommand({ ...defaultOptions, domain: "www.example.com" });
    const payload1 = extractJsonPayload(result1) as Record<string, any>;
    const payload2 = extractJsonPayload(result2) as Record<string, any>;
    expect(payload1["@id"]).toBe("myapp__app-example-com");
    expect(payload2["@id"]).toBe("myapp__www-example-com");
    expect(payload1["@id"]).not.toBe(payload2["@id"]);
  });

  it("should handle numeric port values in upstream dial", () => {
    const result = buildAddRouteCommand({
      ...defaultOptions,
      upstreamPort: 8080,
    });
    const payload = extractJsonPayload(result) as Record<string, any>;
    expect(payload.handle[0].upstreams[0].dial).toBe("myapp-web:8080");
  });
});

describe("buildRemoveRouteCommand", () => {
  it("should target the fleet-proxy container with docker exec", () => {
    const result = buildRemoveRouteCommand("myapp__web");
    expect(result).toContain("docker exec fleet-proxy");
  });

  it("should use curl with silent and fail flags", () => {
    const result = buildRemoveRouteCommand("myapp__web");
    expect(result).toContain("curl -s -f");
  });

  it("should use DELETE method", () => {
    const result = buildRemoveRouteCommand("myapp__web");
    expect(result).toContain("-X DELETE");
  });

  it("should target the /id/{caddy_id} endpoint", () => {
    const result = buildRemoveRouteCommand("myapp__web");
    expect(result).toContain("http://localhost:2019/id/myapp__web");
  });

  it("should not include Content-Type header", () => {
    const result = buildRemoveRouteCommand("myapp__web");
    expect(result).not.toContain("Content-Type");
  });

  it("should handle caddy_id with single underscore in service name", () => {
    const result = buildRemoveRouteCommand("myapp__web_server");
    expect(result).toContain("/id/myapp__web_server");
  });
});

describe("buildListRoutesCommand", () => {
  it("should target the fleet-proxy container with docker exec", () => {
    const result = buildListRoutesCommand();
    expect(result).toContain("docker exec fleet-proxy");
  });

  it("should use curl with silent and fail flags", () => {
    const result = buildListRoutesCommand();
    expect(result).toContain("curl -s -f");
  });

  it("should not include an HTTP method flag (defaults to GET)", () => {
    const result = buildListRoutesCommand();
    expect(result).not.toContain("-X");
  });

  it("should target the routes API path", () => {
    const result = buildListRoutesCommand();
    expect(result).toContain(
      "http://localhost:2019/config/apps/http/servers/fleet/routes",
    );
  });

  it("should not include Content-Type header", () => {
    const result = buildListRoutesCommand();
    expect(result).not.toContain("Content-Type");
  });
});

describe("buildGetConfigCommand", () => {
  it("should target the fleet-proxy container with docker exec", () => {
    const result = buildGetConfigCommand();
    expect(result).toContain("docker exec fleet-proxy");
  });

  it("should use curl with silent and fail flags", () => {
    const result = buildGetConfigCommand();
    expect(result).toContain("curl -s -f");
  });

  it("should not include an HTTP method flag (defaults to GET)", () => {
    const result = buildGetConfigCommand();
    expect(result).not.toContain("-X");
  });

  it("should target the config API path", () => {
    const result = buildGetConfigCommand();
    expect(result).toContain("http://localhost:2019/config/");
  });

  it("should not include Content-Type header", () => {
    const result = buildGetConfigCommand();
    expect(result).not.toContain("Content-Type");
  });
});
