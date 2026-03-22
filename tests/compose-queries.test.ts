import { describe, it, expect } from "vitest";
import { isOneShot, getOneShots } from "../src/compose/queries";
import { ParsedComposeFile, ParsedService } from "../src/compose/types";

describe("isOneShot", () => {
  it("restart undefined returns false", () => {
    const service: ParsedService = {
      hasImage: true,
      hasBuild: false,
      ports: [],
    };
    expect(isOneShot(service)).toBe(false);
  });

  it('restart "no" returns true', () => {
    const service: ParsedService = {
      hasImage: true,
      hasBuild: false,
      ports: [],
      restart: "no",
    };
    expect(isOneShot(service)).toBe(true);
  });

  it('restart "on-failure" returns true', () => {
    const service: ParsedService = {
      hasImage: true,
      hasBuild: false,
      ports: [],
      restart: "on-failure",
    };
    expect(isOneShot(service)).toBe(true);
  });

  it('restart "on-failure:3" returns true', () => {
    const service: ParsedService = {
      hasImage: true,
      hasBuild: false,
      ports: [],
      restart: "on-failure:3",
    };
    expect(isOneShot(service)).toBe(true);
  });

  it('restart "unless-stopped" returns false', () => {
    const service: ParsedService = {
      hasImage: true,
      hasBuild: false,
      ports: [],
      restart: "unless-stopped",
    };
    expect(isOneShot(service)).toBe(false);
  });

  it('restart "always" returns false', () => {
    const service: ParsedService = {
      hasImage: true,
      hasBuild: false,
      ports: [],
      restart: "always",
    };
    expect(isOneShot(service)).toBe(false);
  });
});

describe("getOneShots", () => {
  it("returns only one-shot service names from a mixed compose file", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "always",
        },
        migrate: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "no",
        },
        worker: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "unless-stopped",
        },
        seed: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "on-failure",
        },
      },
    };
    const result = getOneShots(compose);
    expect(result).toEqual(expect.arrayContaining(["migrate", "seed"]));
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no services are one-shot", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "always",
        },
        worker: {
          hasImage: true,
          hasBuild: false,
          ports: [],
          restart: "unless-stopped",
        },
        db: {
          hasImage: true,
          hasBuild: false,
          ports: [],
        },
      },
    };
    const result = getOneShots(compose);
    expect(result).toEqual([]);
  });
});
