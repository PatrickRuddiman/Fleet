# CLI Entry Point and Command Registration

Fleet is a TypeScript CLI tool for managing Docker Compose-based deployments on
remote servers via SSH, with a Caddy reverse proxy for automatic HTTPS routing.
This document describes the CLI's top-level entry point, how commands are
registered, and how the program reaches users as both an npm package and a
standalone binary.

## Why the CLI exists

Fleet's value proposition is a single command (`fleet deploy`) that takes a
Docker Compose project and deploys it to a remote server with automatic reverse
proxy configuration. The CLI is the primary user interface for every Fleet
operation -- from project initialization to deployment, secret management, proxy
inspection, and stack lifecycle control.

## How the CLI is structured

The entry point is `src/cli.ts`, which creates a [Commander.js](https://www.npmjs.com/package/commander) `Command` program,
registers ten subcommands, and exports a `createProgram()` factory function. Each
subcommand lives in a dedicated file under `src/commands/` and follows the same
pattern: export a `register(program)` function that adds a command (or command
group) to the program tree. See [CLI Architecture](architecture.md) for the
full component diagram.

### Command surface area

| Command | Source | Subsystem | Description |
|---------|--------|-----------|-------------|
| `fleet init` | `src/commands/init.ts` | [Project Initialization](../project-init/) | Scaffold a new `fleet.yml` from a compose file |
| `fleet validate` | `src/commands/validate.ts` | [Validation](../validation/) | Check `fleet.yml` and compose file for errors |
| `fleet deploy` | `src/commands/deploy.ts` | [Deployment Pipeline](../deploy/) | Deploy services to the remote server |
| `fleet env` | `src/commands/env.ts` | [Environment & Secrets](../env-secrets/) | Push or refresh secrets on the remote server |
| `fleet proxy status` | `src/commands/proxy.ts` | [Proxy Status & Reload](../proxy-status-reload/) | Show live Caddy route status |
| `fleet proxy reload` | `src/commands/proxy.ts` | [Proxy Status & Reload](../proxy-status-reload/) | Force-reload all Caddy routes from state |
| `fleet ps` | `src/commands/ps.ts` | [Process Status](../cli-commands/operational-commands.md) | Show running container status |
| `fleet logs` | `src/commands/logs.ts` | [Process Status](../cli-commands/operational-commands.md) | Stream live container logs |
| `fleet restart` | `src/commands/restart.ts` | [Stack Lifecycle](../cli-commands/operational-commands.md) | Restart a service in a deployed stack |
| `fleet stop` | `src/commands/stop.ts` | [Stack Lifecycle](../cli-commands/operational-commands.md) | Stop a stack without destroying it |
| `fleet teardown` | `src/commands/teardown.ts` | [Stack Lifecycle](../cli-commands/operational-commands.md) | Remove a stack, its containers, and optionally its volumes |

### Registration order

Commands are registered in `src/cli.ts:25-34` in the order: `init`, `validate`,
`deploy`, `ps`, `logs`, `restart`, `stop`, `teardown`, `env`, `proxy`. This
order affects help output but has no runtime behavior impact.

## How Fleet resolves the target server

The CLI itself accepts no `--host` or `--server` flag. The remote server is
**always** loaded from the `server` section of `fleet.yml` in the current
working directory. The schema (defined in `src/config/schema.ts:3-8`, documented
in the [Configuration Schema Reference](../configuration/schema-reference.md))
requires:

- `host` (string, required) -- the server hostname or IP
- `port` (integer, defaults to `22`) -- SSH port
- `user` (string, defaults to `"root"`) -- SSH username
- `identity_file` (string, optional) -- path to the SSH private key

This means every Fleet command that contacts a server (all except `init` and
`validate`) requires a valid `fleet.yml` in `process.cwd()`.

## Dual-entry pattern

Fleet has two entry points that both call `createProgram()`:

1. **`bin/fleet`** (5 lines) -- the production entry point, loaded via
   `dist/cli.js` after TypeScript compilation. This is what runs when users
   invoke `fleet` after npm installation or from a standalone binary.

2. **`src/cli.ts:39-42`** -- uses `require.main === module` to parse args
   directly when the file is executed with `ts-node` during development (the
   `dev` script in `package.json` runs `ts-node src/cli.ts`).

This pattern follows the
[Node.js CommonJS convention for detecting the main module](https://nodejs.org/api/modules.html#accessing-the-main-module).
It allows `createProgram()` to be imported for testing without triggering
argument parsing as a side effect.

## Error handling strategy

Every command handler uses an identical try/catch pattern:

```
try {
  await someOperation();
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Operation failed with an unknown error.");
  }
  process.exit(1);
}
```

There is **no centralized error handler**, no structured error codes, and no
cleanup-on-failure logic at the CLI layer. Commander.js provides
`exitOverride()` and `configureOutput()` hooks that could centralize this, but
Fleet does not use them.

For unknown options and missing required arguments, Commander.js handles errors
automatically -- it prints a usage error and exits with code 1 without reaching
the action handler. Fleet does not call `.allowUnknownOption()`, so unrecognized
flags are rejected by default.

## Binary distribution

Fleet is distributed as a standalone binary via
[@yao-pkg/pkg](https://github.com/nicedoc/pkg-napi). The build configuration in
`package.json:50-61` specifies:

- **Entry point**: `bin/fleet`
- **Targets**: `node18-linux-x64`, `node18-macos-x64`, `node18-macos-arm64`
- **Assets**: `dist/**/*` (compiled TypeScript output)
- **Output**: `releases/` directory

### Node version mismatch

The pkg targets specify `node18` while `engines` in `package.json` requires
`node>=20`. This is a known divergence: `@yao-pkg/pkg` at the time of
configuration did not support Node 20 targets. The compiled JavaScript in `dist/`
runs correctly on the Node 18 runtime bundled by pkg because Fleet does not use
Node 20-specific APIs. If future code uses Node 20 features (like
`Array.fromAsync` or stable `import.meta.resolve`), the pkg targets must be
updated accordingly.

### Native module handling

Fleet depends on `node-ssh` (which wraps `ssh2`). The `ssh2` package includes
optional native bindings for performance. During pkg bundling, native `.node`
addons are typically included via the `assets` or `scripts` configuration. If the
native bindings fail to load at runtime in the packaged binary, `ssh2` falls back
to its pure-JavaScript implementation, so connectivity is not affected -- only
performance of cryptographic operations.

## Related documentation

- [Deploy Command](deploy-command.md) -- full deploy lifecycle
- [Init Command](init-command.md) -- project initialization flow
- [Validate Command](validate-command.md) -- validation checks reference
- [Env Command](env-command.md) -- secrets management
- [Proxy Commands](proxy-commands.md) -- proxy status and reload
- [CLI Architecture](architecture.md) -- component diagram and subsystem map
- [Operational Commands](../cli-commands/operational-commands.md) -- ps, logs, restart, stop, teardown
- [CLI Commands Integrations](../cli-commands/integrations.md) -- integration
  details for operational commands
