import { describe, it, expect } from "vitest";
import { createProgram } from "../src/cli";

describe("CLI", () => {
  it("should instantiate the commander program with correct metadata", () => {
    const program = createProgram();

    expect(program.name()).toBe("fleet");
    expect(program.version()).toBe("0.1.0");
    expect(program.description()).toBe(
      "A TypeScript CLI tool for managing deployments"
    );
  });

  it("should register all expected subcommands", () => {
    const program = createProgram();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toContain("init");
    expect(commandNames).toContain("validate");
    expect(commandNames).toContain("deploy");
    expect(commandNames).toContain("ps");
    expect(commandNames).toContain("logs");
    expect(commandNames).toContain("restart");
    expect(commandNames).toContain("stop");
    expect(commandNames).toContain("teardown");
    expect(commandNames).toContain("env");
    expect(commandNames).toContain("proxy");
    expect(commandNames).toHaveLength(10);
  });

  it("should register proxy subcommands", () => {
    const program = createProgram();
    const proxyCommand = program.commands.find((cmd) => cmd.name() === "proxy");

    expect(proxyCommand).toBeDefined();
    const proxySubcommands = proxyCommand!.commands.map((cmd) => cmd.name());

    expect(proxySubcommands).toContain("status");
    expect(proxySubcommands).toContain("reload");
    expect(proxySubcommands).toHaveLength(2);
  });
});
