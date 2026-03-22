import { describe, it, expect } from "vitest";
import {
  checkReservedPortConflicts,
  checkServiceNotFound,
  checkPortExposed,
  checkNoImageOrBuild,
  checkOneShotNoMaxAttempts,
} from "../src/validation/compose-checks";
import { FleetConfig } from "../src/config/schema";
import { ParsedComposeFile } from "../src/compose/types";
import { Codes } from "../src/validation/types";

describe("checkReservedPortConflicts", () => {
  it("port 80 conflict produces PORT_80_CONFLICT finding", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 80, target: 80 }],
        },
      },
    };
    const findings = checkReservedPortConflicts(compose);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.PORT_80_CONFLICT);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("web");
    expect(findings[0].message).toContain("80");
  });

  it("port 443 conflict produces PORT_443_CONFLICT finding", () => {
    const compose: ParsedComposeFile = {
      services: {
        proxy: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 443, target: 443 }],
        },
      },
    };
    const findings = checkReservedPortConflicts(compose);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.PORT_443_CONFLICT);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("proxy");
    expect(findings[0].message).toContain("443");
  });

  it("both 80 and 443 produce separate findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 80, target: 80 }],
        },
        proxy: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 443, target: 443 }],
        },
      },
    };
    const findings = checkReservedPortConflicts(compose);
    expect(findings).toHaveLength(2);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain(Codes.PORT_80_CONFLICT);
    expect(codes).toContain(Codes.PORT_443_CONFLICT);
  });

  it("non-reserved port produces no findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 8080, target: 80 }],
        },
      },
    };
    const findings = checkReservedPortConflicts(compose);
    expect(findings).toHaveLength(0);
  });

  it("no port bindings produces no findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [],
        },
      },
    };
    const findings = checkReservedPortConflicts(compose);
    expect(findings).toHaveLength(0);
  });
});

describe("checkServiceNotFound", () => {
  const baseConfig: FleetConfig = {
    version: "1",
    server: { host: "192.168.1.1", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "docker-compose.yml" },
    routes: [
      { domain: "example.com", port: 3000, service: "web", tls: true },
    ],
  };

  it("existing service produces no findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: { hasImage: true, hasBuild: false, ports: [] },
      },
    };
    const findings = checkServiceNotFound(baseConfig, compose);
    expect(findings).toHaveLength(0);
  });

  it("missing service produces SERVICE_NOT_FOUND", () => {
    const config: FleetConfig = {
      ...baseConfig,
      routes: [
        { domain: "example.com", port: 3000, service: "worker", tls: true },
      ],
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
  });

  it("route without service field produces no findings", () => {
    const config: FleetConfig = {
      ...baseConfig,
      routes: [
        { domain: "example.com", port: 3000, tls: true },
      ],
    };
    const compose: ParsedComposeFile = {
      services: {
        web: { hasImage: true, hasBuild: false, ports: [] },
      },
    };
    const findings = checkServiceNotFound(config, compose);
    expect(findings).toHaveLength(0);
  });

  it("multiple missing services produce multiple findings", () => {
    const config: FleetConfig = {
      ...baseConfig,
      routes: [
        { domain: "example.com", port: 3000, service: "web", tls: true },
        { domain: "api.example.com", port: 4000, service: "worker", tls: true },
      ],
    };
    const compose: ParsedComposeFile = {
      services: {
        db: { hasImage: true, hasBuild: false, ports: [] },
      },
    };
    const findings = checkServiceNotFound(config, compose);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === Codes.SERVICE_NOT_FOUND)).toBe(true);
  });
});

describe("checkPortExposed", () => {
  it("non-reserved host port produces PORT_EXPOSED warning", () => {
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
  });

  it("ports 80 and 443 do NOT produce PORT_EXPOSED warnings", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 80, target: 80 }],
        },
        proxy: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: 443, target: 443 }],
        },
      },
    };
    const findings = checkPortExposed(compose);
    expect(findings).toHaveLength(0);
  });

  it("multiple non-reserved ports produce multiple warnings", () => {
    const compose: ParsedComposeFile = {
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
      },
    };
    const findings = checkPortExposed(compose);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === Codes.PORT_EXPOSED)).toBe(true);
  });

  it("no host port bindings produces no findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [{ published: null, target: 80 }],
        },
      },
    };
    const findings = checkPortExposed(compose);
    expect(findings).toHaveLength(0);
  });
});

describe("checkNoImageOrBuild", () => {
  it("service without image or build produces NO_IMAGE_OR_BUILD warning", () => {
    const compose: ParsedComposeFile = {
      services: {
        worker: {
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
  });

  it("service with image produces no finding", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [],
        },
      },
    };
    const findings = checkNoImageOrBuild(compose);
    expect(findings).toHaveLength(0);
  });

  it("service with build produces no finding", () => {
    const compose: ParsedComposeFile = {
      services: {
        app: {
          hasImage: false,
          hasBuild: true,
          ports: [],
        },
      },
    };
    const findings = checkNoImageOrBuild(compose);
    expect(findings).toHaveLength(0);
  });

  it("multiple services without image or build produce multiple warnings", () => {
    const compose: ParsedComposeFile = {
      services: {
        worker: {
          hasImage: false,
          hasBuild: false,
          ports: [],
        },
        scheduler: {
          hasImage: false,
          hasBuild: false,
          ports: [],
        },
      },
    };
    const findings = checkNoImageOrBuild(compose);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === Codes.NO_IMAGE_OR_BUILD)).toBe(true);
  });
});

describe("checkOneShotNoMaxAttempts", () => {
  it("service with restart on-failure and no max attempts produces warning", () => {
    const compose: ParsedComposeFile = {
      services: {
        migrate: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "on-failure",
        },
      },
    };
    const findings = checkOneShotNoMaxAttempts(compose);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe(Codes.ONE_SHOT_NO_MAX_ATTEMPTS);
    expect(findings[0].severity).toBe("warning");
    expect(findings[0].message).toContain("migrate");
  });

  it("service with restart on-failure and restartPolicyMaxAttempts produces no findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        migrate: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "on-failure",
          restartPolicyMaxAttempts: 3,
        },
      },
    };
    const findings = checkOneShotNoMaxAttempts(compose);
    expect(findings).toHaveLength(0);
  });

  it("service with restart always produces no findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "always",
        },
      },
    };
    const findings = checkOneShotNoMaxAttempts(compose);
    expect(findings).toHaveLength(0);
  });

  it("service with no restart field produces no findings", () => {
    const compose: ParsedComposeFile = {
      services: {
        worker: {
          hasImage: true,
          hasBuild: false,
          ports: [],
        },
      },
    };
    const findings = checkOneShotNoMaxAttempts(compose);
    expect(findings).toHaveLength(0);
  });

  it("multiple services with restart on-failure and no max attempts produce multiple warnings", () => {
    const compose: ParsedComposeFile = {
      services: {
        migrate: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "on-failure",
        },
        seed: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "on-failure",
        },
      },
    };
    const findings = checkOneShotNoMaxAttempts(compose);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.code === Codes.ONE_SHOT_NO_MAX_ATTEMPTS)).toBe(true);
  });
});
