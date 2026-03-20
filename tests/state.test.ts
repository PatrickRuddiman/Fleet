import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { FleetState, StackState } from "../src/state/types";

let tmpDir: string;
let stateDir: string;
let stateFile: string;

// We need to re-import the state module for each test so that the module-level
// STATE_DIR / STATE_FILE constants are recomputed using the mocked homedir.
let readState: () => FleetState;
let writeState: (state: FleetState) => void;
let getStack: (state: FleetState, name: string) => StackState | undefined;
let removeStack: (state: FleetState, name: string) => FleetState;

function sampleState(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/opt/fleet/myapp",
        compose_file: "docker-compose.yml",
        deployed_at: "2025-01-15T10:30:00.000Z",
        routes: [
          {
            host: "myapp.example.com",
            service: "web",
            port: 3000,
            caddy_id: "myapp__web",
          },
        ],
      },
      api: {
        path: "/opt/fleet/api",
        compose_file: "compose.prod.yml",
        deployed_at: "2025-01-16T12:00:00.000Z",
        routes: [
          {
            host: "api.example.com",
            service: "server",
            port: 8080,
            caddy_id: "api__server",
          },
        ],
      },
    },
  };
}

beforeEach(async () => {
  // Create a fresh temporary directory for each test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-"));
  stateDir = path.join(tmpDir, ".fleet");
  stateFile = path.join(stateDir, "state.json");

  // Mock os.homedir() to return our temp dir
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

  // Reset module cache so state.ts re-evaluates its constants with mocked homedir
  vi.resetModules();

  // Dynamically re-import the state module
  const stateModule = await import("../src/state/state");
  readState = stateModule.readState;
  writeState = stateModule.writeState;
  getStack = stateModule.getStack;
  removeStack = stateModule.removeStack;
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up temp directory
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readState", () => {
  it("should read a valid state file and produce the correct object", () => {
    const expected = sampleState();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(expected, null, 2), "utf-8");

    const result = readState();

    expect(result).toEqual(expected);
    expect(result.fleet_root).toBe("/opt/fleet");
    expect(result.caddy_bootstrapped).toBe(true);
    expect(result.stacks.myapp.routes[0].caddy_id).toBe("myapp__web");
    expect(result.stacks.api.routes[0].port).toBe(8080);
  });

  it("should return default initial state when file does not exist", () => {
    const result = readState();

    expect(result).toEqual({
      fleet_root: "",
      caddy_bootstrapped: false,
      stacks: {},
    });
  });

  it("should throw a descriptive error on malformed JSON", () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, "{ not valid json }", "utf-8");

    expect(() => readState()).toThrow();
    expect(() => readState()).toThrow("Invalid JSON");
    expect(() => readState()).toThrow(stateFile);
  });
});

describe("writeState", () => {
  it("should create the directory and file when they do not exist", () => {
    expect(fs.existsSync(stateDir)).toBe(false);

    const state = sampleState();
    writeState(state);

    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.existsSync(stateFile)).toBe(true);

    const content = fs.readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(state);
  });

  it("should write pretty-printed JSON with 2-space indent", () => {
    const state = sampleState();
    writeState(state);

    const content = fs.readFileSync(stateFile, "utf-8");
    expect(content).toBe(JSON.stringify(state, null, 2));
  });
});

describe("round-trip", () => {
  it("should produce identical data when writing then reading", () => {
    const state = sampleState();
    writeState(state);
    const result = readState();

    expect(result).toEqual(state);
  });
});

describe("getStack", () => {
  it("should return the entry for an existing stack", () => {
    const state = sampleState();
    const result = getStack(state, "myapp");

    expect(result).toEqual(state.stacks.myapp);
    expect(result).toBeDefined();
    expect(result!.path).toBe("/opt/fleet/myapp");
    expect(result!.compose_file).toBe("docker-compose.yml");
    expect(result!.deployed_at).toBe("2025-01-15T10:30:00.000Z");
    expect(result!.routes).toHaveLength(1);
  });

  it("should return undefined for a missing stack", () => {
    const state = sampleState();
    const result = getStack(state, "nonexistent");

    expect(result).toBeUndefined();
  });
});

describe("removeStack", () => {
  it("should remove the named stack and return a new object", () => {
    const state = sampleState();
    const result = removeStack(state, "myapp");

    expect(result.stacks).not.toHaveProperty("myapp");
    expect(result.stacks).toHaveProperty("api");
    expect(result).not.toBe(state);
  });

  it("should not mutate the original state", () => {
    const state = sampleState();
    const originalCopy = JSON.parse(JSON.stringify(state));

    removeStack(state, "myapp");

    expect(state).toEqual(originalCopy);
    expect(state.stacks).toHaveProperty("myapp");
  });

  it("should return state unchanged when removing a non-existent stack", () => {
    const state = sampleState();
    const result = removeStack(state, "nonexistent");

    expect(result).toEqual(state);
    expect(result.stacks).toHaveProperty("myapp");
    expect(result.stacks).toHaveProperty("api");
  });
});
