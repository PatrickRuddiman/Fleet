import { describe, it, expect } from "vitest";
import {
  checkFqdnFormat,
  checkPortRange,
  checkDuplicateHosts,
  checkInvalidStackName,
} from "../src/validation/fleet-checks";
import {
  checkReservedPortConflicts,
  checkServiceNotFound,
  checkPortExposed,
  checkNoImageOrBuild,
} from "../src/validation/compose-checks";
import { Codes } from "../src/validation/types";
import { RouteConfig } from "../src/config/schema";
import { FleetConfig } from "../src/config/schema";
import { ParsedComposeFile } from "../src/compose/types";

function makeRoutes(...domains: string[]): RouteConfig[] {
  return domains.map((domain) => ({ domain, port: 3000, tls: true }));
}

function makeRoutesWithPort(...ports: number[]): RouteConfig[] {
  return ports.map((port, i) => ({ domain: `app${i}.example.com`, port, tls: true }));
}

describe("checkFqdnFormat", () => {
  describe("valid FQDNs produce no findings", () => {
    it("basic two-label FQDN", () => {
      const findings = checkFqdnFormat(makeRoutes("example.com"));
      expect(findings).toHaveLength(0);
    });

    it("three-label FQDN", () => {
      const findings = checkFqdnFormat(makeRoutes("app.example.com"));
      expect(findings).toHaveLength(0);
    });

    it("four-label FQDN", () => {
      const findings = checkFqdnFormat(makeRoutes("sub.domain.example.com"));
      expect(findings).toHaveLength(0);
    });

    it("alphanumeric labels", () => {
      const findings = checkFqdnFormat(makeRoutes("a1.b2.com"));
      expect(findings).toHaveLength(0);
    });

    it("hyphen in label", () => {
      const findings = checkFqdnFormat(makeRoutes("my-app.example.com"));
      expect(findings).toHaveLength(0);
    });
  });

  describe("invalid FQDNs produce INVALID_FQDN finding", () => {
    it("single label (no dot)", () => {
      const findings = checkFqdnFormat(makeRoutes("localhost"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_FQDN);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("localhost");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("empty string", () => {
      const findings = checkFqdnFormat(makeRoutes(""));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_FQDN);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("label starts with hyphen", () => {
      const findings = checkFqdnFormat(makeRoutes("-example.com"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_FQDN);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("-example.com");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("label ends with hyphen", () => {
      const findings = checkFqdnFormat(makeRoutes("example-.com"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_FQDN);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("example-.com");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("space in label", () => {
      const findings = checkFqdnFormat(makeRoutes("exam ple.com"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_FQDN);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("exam ple.com");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("empty label (double dot)", () => {
      const findings = checkFqdnFormat(makeRoutes("example..com"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_FQDN);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("example..com");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("domain exceeding 253 characters", () => {
      const longDomain = "a".repeat(63) + "." + "b".repeat(63) + "." + "c".repeat(63) + "." + "d".repeat(63);
      expect(longDomain.length).toBeGreaterThan(253);
      const findings = checkFqdnFormat(makeRoutes(longDomain));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_FQDN);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain(longDomain);
      expect(findings[0].resolution).toBeTruthy();
    });
  });
});

describe("checkPortRange", () => {
  describe("valid ports produce no findings", () => {
    it("port 1 (minimum)", () => {
      const findings = checkPortRange(makeRoutesWithPort(1));
      expect(findings).toHaveLength(0);
    });

    it("port 65535 (maximum)", () => {
      const findings = checkPortRange(makeRoutesWithPort(65535));
      expect(findings).toHaveLength(0);
    });

    it("port 8080 (common)", () => {
      const findings = checkPortRange(makeRoutesWithPort(8080));
      expect(findings).toHaveLength(0);
    });

    it("port 443 (HTTPS)", () => {
      const findings = checkPortRange(makeRoutesWithPort(443));
      expect(findings).toHaveLength(0);
    });
  });

  describe("invalid ports produce INVALID_PORT_RANGE finding", () => {
    it("port 0 (below minimum)", () => {
      const findings = checkPortRange(makeRoutesWithPort(0));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_PORT_RANGE);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("0");
      expect(findings[0].resolution).toContain("1");
      expect(findings[0].resolution).toContain("65535");
    });

    it("port 65536 (above maximum)", () => {
      const findings = checkPortRange(makeRoutesWithPort(65536));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_PORT_RANGE);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("65536");
      expect(findings[0].resolution).toContain("1");
      expect(findings[0].resolution).toContain("65535");
    });

    it("port -1 (negative)", () => {
      const findings = checkPortRange(makeRoutesWithPort(-1));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_PORT_RANGE);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("-1");
      expect(findings[0].resolution).toContain("1");
      expect(findings[0].resolution).toContain("65535");
    });

    it("port 100000 (far above maximum)", () => {
      const findings = checkPortRange(makeRoutesWithPort(100000));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_PORT_RANGE);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("100000");
      expect(findings[0].resolution).toContain("1");
      expect(findings[0].resolution).toContain("65535");
    });
  });
});

describe("checkDuplicateHosts", () => {
  it("no duplicates produces no findings", () => {
    const findings = checkDuplicateHosts(makeRoutes("app.example.com", "api.example.com"));
    expect(findings).toHaveLength(0);
  });

  it("one duplicate pair produces one finding", () => {
    const findings = checkDuplicateHosts(makeRoutes("app.example.com", "app.example.com"));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.DUPLICATE_HOST);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("app.example.com");
    expect(findings[0].resolution).toBeTruthy();
  });

  it("triple duplicate produces one finding with count", () => {
    const findings = checkDuplicateHosts(
      makeRoutes("app.example.com", "app.example.com", "app.example.com"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.DUPLICATE_HOST);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("3");
    expect(findings[0].resolution).toBeTruthy();
  });

  it("multiple different duplicates produce multiple findings", () => {
    const findings = checkDuplicateHosts(
      makeRoutes("app.example.com", "api.example.com", "app.example.com", "api.example.com"),
    );
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === Codes.DUPLICATE_HOST)).toBe(true);
    expect(findings.every((f) => f.severity === "error")).toBe(true);
  });
});

function makeConfig(stackName: string): FleetConfig {
  return {
    version: "1",
    server: { host: "192.168.1.1", port: 22, user: "root" },
    stack: { name: stackName, compose_file: "docker-compose.yml" },
    routes: [{ domain: "example.com", port: 3000, tls: true }],
  };
}

describe("checkInvalidStackName", () => {
  describe("valid stack names produce no findings", () => {
    it("lowercase alphabetic name", () => {
      const findings = checkInvalidStackName(makeConfig("myapp"));
      expect(findings).toHaveLength(0);
    });

    it("name with hyphens", () => {
      const findings = checkInvalidStackName(makeConfig("my-app"));
      expect(findings).toHaveLength(0);
    });

    it("name starting with a digit", () => {
      const findings = checkInvalidStackName(makeConfig("1app"));
      expect(findings).toHaveLength(0);
    });

    it("alphanumeric with hyphens", () => {
      const findings = checkInvalidStackName(makeConfig("my-app-2"));
      expect(findings).toHaveLength(0);
    });

    it("single character", () => {
      const findings = checkInvalidStackName(makeConfig("a"));
      expect(findings).toHaveLength(0);
    });

    it("single digit", () => {
      const findings = checkInvalidStackName(makeConfig("1"));
      expect(findings).toHaveLength(0);
    });
  });

  describe("invalid stack names produce INVALID_STACK_NAME finding", () => {
    it("uppercase letters", () => {
      const findings = checkInvalidStackName(makeConfig("MyApp"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_STACK_NAME);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("MyApp");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("underscores", () => {
      const findings = checkInvalidStackName(makeConfig("my_app"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_STACK_NAME);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("my_app");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("spaces", () => {
      const findings = checkInvalidStackName(makeConfig("my app"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_STACK_NAME);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("my app");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("starts with a hyphen", () => {
      const findings = checkInvalidStackName(makeConfig("-myapp"));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_STACK_NAME);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("-myapp");
      expect(findings[0].resolution).toBeTruthy();
    });

    it("empty string", () => {
      const findings = checkInvalidStackName(makeConfig(""));
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(Codes.INVALID_STACK_NAME);
      expect(findings[0].severity).toBe("error");
      expect(findings[0].message).toContain("");
      expect(findings[0].resolution).toBeTruthy();
    });
  });
});

describe("compose check findings", () => {
  it("PORT_80_CONFLICT vs PORT_443_CONFLICT distinction", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [
            { published: 80, target: 80 },
            { published: 443, target: 443 },
          ],
        },
      },
    };

    const findings = checkReservedPortConflicts(compose);
    expect(findings).toHaveLength(2);

    const port80 = findings.find((f) => f.code === Codes.PORT_80_CONFLICT);
    const port443 = findings.find((f) => f.code === Codes.PORT_443_CONFLICT);

    expect(port80).toBeDefined();
    expect(port80!.severity).toBe("error");
    expect(port80!.message).toContain("80");
    expect(port80!.message).toContain("web");
    expect(port80!.resolution).toContain("web");
    expect(port80!.resolution).toBeTruthy();

    expect(port443).toBeDefined();
    expect(port443!.severity).toBe("error");
    expect(port443!.message).toContain("443");
    expect(port443!.message).toContain("web");
    expect(port443!.resolution).toContain("web");
    expect(port443!.resolution).toBeTruthy();
  });

  it("SERVICE_NOT_FOUND finding has correct structure", () => {
    const config: FleetConfig = {
      version: "1",
      server: { host: "192.168.1.1", port: 22, user: "root" },
      stack: { name: "myapp", compose_file: "docker-compose.yml" },
      routes: [{ domain: "example.com", port: 3000, service: "worker", tls: true }],
    };
    const compose: ParsedComposeFile = {
      services: {
        web: { hasImage: true, hasBuild: false, ports: [] },
      },
    };

    const findings = checkServiceNotFound(config, compose);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.SERVICE_NOT_FOUND);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("worker");
    expect(findings[0].resolution).toBeTruthy();
  });

  it("PORT_EXPOSED finding has correct structure", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 8080, target: 80 }],
        },
      },
    };

    const findings = checkPortExposed(compose);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.PORT_EXPOSED);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("8080");
    expect(findings[0].resolution).toBeTruthy();
  });

  it("NO_IMAGE_OR_BUILD finding has correct structure", () => {
    const compose: ParsedComposeFile = {
      services: {
        myservice: {
          hasImage: false,
          hasBuild: false,
          ports: [],
        },
      },
    };

    const findings = checkNoImageOrBuild(compose);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.NO_IMAGE_OR_BUILD);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("myservice");
    expect(findings[0].resolution).toBeTruthy();
  });
});
