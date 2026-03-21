import { describe, it, expect } from "vitest";
import type { ExecFn, ExecResult } from "../src/ssh";
import { generateProxyCompose, writeProxyCompose } from "../src/proxy";
import { PROXY_DIR } from "../src/fleet-root";

function mockExec(result: ExecResult): ExecFn {
  return async (_command: string): Promise<ExecResult> => result;
}

describe("generateProxyCompose", () => {
  it("should return valid YAML containing the fleet-caddy service", () => {
    const content = generateProxyCompose();
    expect(content).toContain("fleet-caddy");
  });

  it("should specify the caddy:2-alpine image", () => {
    const content = generateProxyCompose();
    expect(content).toContain("image: caddy:2-alpine");
  });

  it("should set the container name to fleet-caddy", () => {
    const content = generateProxyCompose();
    expect(content).toContain("container_name: fleet-caddy");
  });

  it("should map ports 80 and 443", () => {
    const content = generateProxyCompose();
    expect(content).toContain("80:80");
    expect(content).toContain("443:443");
  });

  it("should mount caddy_data and caddy_config volumes", () => {
    const content = generateProxyCompose();
    expect(content).toContain("caddy_data:/data");
    expect(content).toContain("caddy_config:/config");
  });

  it("should attach to the fleet-proxy network", () => {
    const content = generateProxyCompose();
    expect(content).toContain("fleet-proxy");
  });

  it("should set the command to caddy run --resume", () => {
    const content = generateProxyCompose();
    expect(content).toContain("caddy run --resume");
  });

  it("should set restart policy to unless-stopped", () => {
    const content = generateProxyCompose();
    expect(content).toContain("unless-stopped");
  });

  it("should declare fleet-proxy as an external network", () => {
    const content = generateProxyCompose();
    expect(content).toContain("networks:");
    expect(content).toContain("external: true");
  });

  it("should declare caddy_data and caddy_config as named volumes", () => {
    const content = generateProxyCompose();
    expect(content).toContain("volumes:");
    expect(content).toContain("caddy_data:");
    expect(content).toContain("caddy_config:");
  });
});

describe("writeProxyCompose", () => {
  it("should construct a shell command that includes mkdir -p for the target directory", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    await writeProxyCompose("/opt/fleet", exec);

    expect(capturedCommand).toContain(`mkdir -p /opt/fleet/${PROXY_DIR}`);
  });

  it("should use atomic rename via mv", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    await writeProxyCompose("/opt/fleet", exec);

    expect(capturedCommand).toContain("mv");
    expect(capturedCommand).toContain(
      `mv /opt/fleet/${PROXY_DIR}/compose.yml.tmp /opt/fleet/${PROXY_DIR}/compose.yml`
    );
  });

  it("should derive the target path from the fleet root and PROXY_DIR", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    await writeProxyCompose("/home/deploy/fleet", exec);

    expect(capturedCommand).toContain(`/home/deploy/fleet/${PROXY_DIR}/compose.yml`);
  });

  it("should include the compose content in the command", async () => {
    let capturedCommand = "";
    const exec: ExecFn = async (command: string) => {
      capturedCommand = command;
      return { stdout: "", stderr: "", code: 0 };
    };

    await writeProxyCompose("/opt/fleet", exec);

    expect(capturedCommand).toContain("caddy:2-alpine");
  });

  it("should throw on non-zero exit code with a descriptive error message", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "disk full",
      code: 1,
    });

    await expect(writeProxyCompose("/opt/fleet", exec)).rejects.toThrow(
      "exited with code 1"
    );
    await expect(writeProxyCompose("/opt/fleet", exec)).rejects.toThrow(
      "disk full"
    );
  });

  it("should not throw when exit code is zero", async () => {
    const exec = mockExec({
      stdout: "",
      stderr: "",
      code: 0,
    });

    await expect(writeProxyCompose("/opt/fleet", exec)).resolves.toBeUndefined();
  });
});
