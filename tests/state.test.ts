import { describe, it, expect } from "vitest";
import type { FleetState } from "../src/state/types";
import type { ExecFn, ExecResult } from "../src/ssh";
import {
  readState,
  writeState,
  getStack,
  removeStack,
} from "../src/state/state";

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

function mockExec(result: ExecResult): ExecFn {
  return async (_command: string): Promise<ExecResult> => result;
}

describe("readState", () => {
  it("should return parsed state on successful read", async () => {
    const exec = mockExec({
      stdout: JSON.stringify(sampleState(), null, 2),
      stderr: "",
      code: 0,
    });

    const result = await readState(exec);

    expect(result).toEqual(sampleState());
    expect(result.fleet_root).toBe("/opt/fleet");
    expect(result.caddy_bootstrapped).toBe(true);
    expect(result.stacks.myapp.routes[0].caddy_id).toBe("myapp__web");
    expect(result.stacks.api.routes[0].port).toBe(8080);
  });

  it("should return default state when file does not exist (non-zero exit code)", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "cat: /root/.fleet/state.json: No such file or directory",
      code: 1,
    });

    const result = await readState(exec);

    expect(result).toEqual({
      fleet_root: "",
      caddy_bootstrapped: false,
      stacks: {},
    });
  });

  it("should return default state when stdout is empty", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "",
      code: 0,
    });

    const result = await readState(exec);

    expect(result).toEqual({
      fleet_root: "",
      caddy_bootstrapped: false,
      stacks: {},
    });
  });

  it("should throw on malformed JSON", async () => {
    const exec = mockExec({
      stdout: "{ not valid json }",
      stderr: "",
      code: 0,
    });

    await expect(readState(exec)).rejects.toThrow("invalid JSON");
  });

  it("should throw with descriptive message when fleet_root is not a string", async () => {
    const exec = mockExec({
      stdout: JSON.stringify({
        fleet_root: 123,
        caddy_bootstrapped: true,
        stacks: {},
      }),
      stderr: "",
      code: 0,
    });

    await expect(readState(exec)).rejects.toThrow(
      "Invalid state file structure"
    );
  });

  it("should throw with descriptive message when caddy_bootstrapped is not a boolean", async () => {
    const exec = mockExec({
      stdout: JSON.stringify({
        fleet_root: "",
        caddy_bootstrapped: "yes",
        stacks: {},
      }),
      stderr: "",
      code: 0,
    });

    await expect(readState(exec)).rejects.toThrow(
      "Invalid state file structure"
    );
  });

  it("should throw with descriptive message when stacks is not an object", async () => {
    const exec = mockExec({
      stdout: JSON.stringify({
        fleet_root: "",
        caddy_bootstrapped: false,
        stacks: "not-an-object",
      }),
      stderr: "",
      code: 0,
    });

    await expect(readState(exec)).rejects.toThrow(
      "Invalid state file structure"
    );
  });

  it("should not throw when stack entries omit services and env_hash (backward compatibility)", async () => {
    const legacyState: FleetState = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {
        legacy: {
          path: "/opt/fleet/legacy",
          compose_file: "docker-compose.yml",
          deployed_at: "2025-01-10T08:00:00.000Z",
          routes: [],
        },
      },
    };
    const exec = mockExec({
      stdout: JSON.stringify(legacyState, null, 2),
      stderr: "",
      code: 0,
    });

    const result = await readState(exec);

    expect(result.stacks.legacy).toBeDefined();
    expect(result.stacks.legacy.path).toBe("/opt/fleet/legacy");
  });

  it("should return undefined for services on a stack that lacks the field", async () => {
    const stateWithoutServices: FleetState = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: false,
      stacks: {
        basic: {
          path: "/opt/fleet/basic",
          compose_file: "compose.yml",
          deployed_at: "2025-02-01T00:00:00.000Z",
          routes: [],
        },
      },
    };
    const exec = mockExec({
      stdout: JSON.stringify(stateWithoutServices, null, 2),
      stderr: "",
      code: 0,
    });

    const result = await readState(exec);

    expect(result.stacks.basic.services).toBeUndefined();
    expect(result.stacks.basic.env_hash).toBeUndefined();
  });

  it("should round-trip a state.json containing env_hash and services", async () => {
    const fullState: FleetState = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {
        webapp: {
          path: "/opt/fleet/webapp",
          compose_file: "docker-compose.yml",
          deployed_at: "2025-03-01T12:00:00.000Z",
          routes: [
            {
              host: "webapp.example.com",
              service: "web",
              port: 3000,
              caddy_id: "webapp__web",
            },
          ],
          env_hash: "abc123def456",
          services: {
            web: {
              image: "nginx:latest",
              definition_hash: "def111",
              image_digest: "sha256:aaa",
              env_hash: "abc123def456",
              deployed_at: "2025-03-01T12:00:00.000Z",
              skipped_at: null,
              one_shot: false,
              status: "running",
            },
            worker: {
              image: "myapp:v2",
              definition_hash: "def222",
              image_digest: "sha256:bbb",
              env_hash: "abc123def456",
              deployed_at: "2025-03-01T12:01:00.000Z",
              skipped_at: null,
              one_shot: true,
              status: "exited",
            },
          },
        },
      },
    };
    const exec = mockExec({
      stdout: JSON.stringify(fullState, null, 2),
      stderr: "",
      code: 0,
    });

    const result = await readState(exec);

    expect(result).toEqual(fullState);
    expect(result.stacks.webapp.env_hash).toBe("abc123def456");
    expect(result.stacks.webapp.services).toBeDefined();
    expect(result.stacks.webapp.services!.web.definition_hash).toBe("def111");
    expect(result.stacks.webapp.services!.web.one_shot).toBe(false);
    expect(result.stacks.webapp.services!.worker.image_digest).toBe("sha256:bbb");
    expect(result.stacks.webapp.services!.worker.one_shot).toBe(true);
    expect(result.stacks.webapp.services!.worker.status).toBe("exited");
  });
});

describe("writeState", () => {
  it("should produce a command that includes mkdir -p ~/.fleet", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    await writeState(exec, sampleState());

    expect(capturedCommand).toContain("mkdir -p ~/.fleet");
  });

  it("should produce a command that includes atomic rename via mv", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    await writeState(exec, sampleState());

    expect(capturedCommand).toContain(
      "mv ~/.fleet/state.json.tmp ~/.fleet/state.json"
    );
  });

  it("should serialize JSON with 2-space indent", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    await writeState(exec, sampleState());

    expect(capturedCommand).toContain(JSON.stringify(sampleState(), null, 2));
  });

  it("should throw on non-zero exit code", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "permission denied",
      code: 1,
    });

    await expect(writeState(exec, sampleState())).rejects.toThrow(
      "exited with code 1"
    );
  });

  it("should include env_hash and services in serialized output when present", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    const stateWithServices: FleetState = {
      fleet_root: "/opt/fleet",
      caddy_bootstrapped: true,
      stacks: {
        myapp: {
          path: "/opt/fleet/myapp",
          compose_file: "docker-compose.yml",
          deployed_at: "2025-03-01T12:00:00.000Z",
          routes: [],
          env_hash: "envhash123",
          services: {
            api: {
              image: "node:20-alpine",
              definition_hash: "defhash1",
              image_digest: "sha256:abc",
              env_hash: "envhash123",
              deployed_at: "2025-03-01T12:00:00.000Z",
              skipped_at: null,
              one_shot: false,
              status: "running",
            },
          },
        },
      },
    };

    await writeState(exec, stateWithServices);

    expect(capturedCommand).toContain('"env_hash": "envhash123"');
    expect(capturedCommand).toContain('"definition_hash": "defhash1"');
    expect(capturedCommand).toContain('"image_digest": "sha256:abc"');
    expect(capturedCommand).toContain('"one_shot": false');
    expect(capturedCommand).toContain('"status": "running"');
    expect(capturedCommand).toContain('"image": "node:20-alpine"');
    expect(capturedCommand).toContain('"skipped_at": null');
    expect(capturedCommand).toContain(JSON.stringify(stateWithServices, null, 2));
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
