import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamExecCallbacks } from "../src/ssh/types";
import type { FleetState } from "../src/state/types";

// --- Hoisted mock functions ---

const { mockExec, mockStreamExec, mockClose } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockStreamExec: vi
    .fn()
    .mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
  mockClose: vi.fn().mockResolvedValue(undefined),
}));

const { mockReadState, mockGetStack } = vi.hoisted(() => ({
  mockReadState: vi.fn(),
  mockGetStack: vi.fn(),
}));

// --- Module mocks ---

vi.mock("../src/config", () => ({
  loadFleetConfig: () => ({
    version: "1",
    server: { host: "example.com", port: 22, user: "root" },
    stack: { name: "myapp", compose_file: "compose.yml" },
    routes: [{ domain: "myapp.example.com", port: 3000, tls: true }],
  }),
}));

vi.mock("../src/ssh", () => ({
  createConnection: async () => ({
    exec: mockExec,
    streamExec: mockStreamExec,
    close: mockClose,
  }),
}));

vi.mock("../src/state", () => ({
  readState: (...args: unknown[]) => mockReadState(...args),
  getStack: (...args: unknown[]) => mockGetStack(...args),
}));

// --- Import function under test (after vi.mock calls) ---

import { logs } from "../src/logs";

// --- Helpers ---

function sampleState(): FleetState {
  return {
    fleet_root: "/opt/fleet",
    caddy_bootstrapped: true,
    stacks: {
      myapp: {
        path: "/opt/fleet/stacks/myapp",
        compose_file: "compose.yml",
        deployed_at: "2025-01-15T10:30:00.000Z",
        routes: [],
      },
    },
  };
}

// --- Tests ---

describe("logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadState.mockResolvedValue(sampleState());
    mockGetStack.mockReturnValue(sampleState().stacks.myapp);
    mockStreamExec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    mockClose.mockResolvedValue(undefined);
  });

  // (1) Successful log streaming with stdout/stderr callbacks invoked
  it("should stream logs and invoke stdout/stderr callbacks", async () => {
    mockStreamExec.mockImplementation(
      async (_command: string, callbacks: StreamExecCallbacks) => {
        callbacks.onStdout?.("stdout chunk");
        callbacks.onStderr?.("stderr chunk");
        return { stdout: "", stderr: "", code: 0 };
      }
    );

    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await logs("myapp");

    expect(stdoutWrite).toHaveBeenCalledWith("stdout chunk");
    expect(stderrWrite).toHaveBeenCalledWith("stderr chunk");

    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  // (2) Stack-not-found error when the stack does not exist in state
  it("should throw when stack is not found in state", async () => {
    mockGetStack.mockReturnValue(undefined);

    await expect(logs("nonexistent")).rejects.toThrow(
      'Stack "nonexistent" not found'
    );
  });

  // (3) Correct docker compose command construction with and without service filter
  it("should construct command without service filter", async () => {
    await logs("myapp");

    expect(mockStreamExec).toHaveBeenCalledWith(
      "docker compose -p myapp logs -f",
      expect.any(Object)
    );
  });

  it("should construct command with service filter", async () => {
    await logs("myapp", "web");

    expect(mockStreamExec).toHaveBeenCalledWith(
      "docker compose -p myapp logs -f web",
      expect.any(Object)
    );
  });

  // (4) Correct command construction with and without the --tail flag
  it("should construct command without --tail flag", async () => {
    await logs("myapp");

    const command = mockStreamExec.mock.calls[0][0];
    expect(command).not.toContain("--tail");
  });

  it("should construct command with --tail flag", async () => {
    await logs("myapp", undefined, 100);

    expect(mockStreamExec).toHaveBeenCalledWith(
      "docker compose -p myapp logs -f --tail 100",
      expect.any(Object)
    );
  });

  it("should construct command with both --tail and service", async () => {
    await logs("myapp", "api", 50);

    expect(mockStreamExec).toHaveBeenCalledWith(
      "docker compose -p myapp logs -f --tail 50 api",
      expect.any(Object)
    );
  });

  // (5) Connection cleanup in both success and error paths
  it("should close connection after successful execution", async () => {
    await logs("myapp");

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("should close connection when streamExec throws", async () => {
    mockStreamExec.mockRejectedValue(new Error("stream failed"));

    await expect(logs("myapp")).rejects.toThrow("stream failed");
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("should close connection when stack is not found", async () => {
    mockGetStack.mockReturnValue(undefined);

    await expect(logs("nonexistent")).rejects.toThrow();
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
