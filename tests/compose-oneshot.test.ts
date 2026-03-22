import { describe, it, expect } from "vitest";
import { isOneShot, getOneShots } from "../src/compose/queries";
import { ParsedService, ParsedComposeFile } from "../src/compose/types";

function makeService(restart?: string): ParsedService {
  return { hasImage: true, hasBuild: false, ports: [], restart };
}

describe("isOneShot", () => {
  it("returns false when restart is undefined", () => {
    expect(isOneShot(makeService(undefined))).toBe(false);
  });

  it("returns false when restart is not set", () => {
    const service: ParsedService = { hasImage: true, hasBuild: false, ports: [] };
    expect(isOneShot(service)).toBe(false);
  });

  it('returns true when restart is "no"', () => {
    expect(isOneShot(makeService("no"))).toBe(true);
  });

  it('returns true when restart is "on-failure"', () => {
    expect(isOneShot(makeService("on-failure"))).toBe(true);
  });

  it('returns true when restart is "on-failure:3"', () => {
    expect(isOneShot(makeService("on-failure:3"))).toBe(true);
  });

  it('returns false when restart is "always"', () => {
    expect(isOneShot(makeService("always"))).toBe(false);
  });

  it('returns false when restart is "unless-stopped"', () => {
    expect(isOneShot(makeService("unless-stopped"))).toBe(false);
  });
});

describe("getOneShots", () => {
  it("returns empty array when no services are one-shot", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: makeService("always"),
        db: makeService(undefined),
      },
    };
    expect(getOneShots(compose)).toEqual([]);
  });

  it("returns names of one-shot services", () => {
    const compose: ParsedComposeFile = {
      services: {
        web: makeService("always"),
        migrate: makeService("no"),
        seed: makeService("on-failure"),
      },
    };
    const result = getOneShots(compose);
    expect(result).toContain("migrate");
    expect(result).toContain("seed");
    expect(result).not.toContain("web");
    expect(result).toHaveLength(2);
  });

  it("returns empty array when there are no services", () => {
    const compose: ParsedComposeFile = { services: {} };
    expect(getOneShots(compose)).toEqual([]);
  });

  it("returns all service names when all are one-shot", () => {
    const compose: ParsedComposeFile = {
      services: {
        migrate: makeService("no"),
        seed: makeService("on-failure:5"),
      },
    };
    expect(getOneShots(compose)).toHaveLength(2);
  });
});
