# Troubleshooting: CLI Entry Point

This document covers common issues with the Fleet CLI entry point, standalone
binary packaging, and runtime path resolution.

## `package.json` missing in standalone binary

**Symptom**: Running any `fleet` command from a standalone binary produces:

```
Error: Cannot find module '/snapshot/fleet/package.json'
```

**Cause**: The `pkg` assets configuration at `package.json:62-64` lists only
`dist/**/*`, which does not include the root `package.json`. If `pkg`'s static
analysis fails to detect the dynamic `require(path.join(__dirname, "..",
"package.json"))` call in `src/cli.ts:19`, the file is excluded from the
snapshot filesystem.

**Fix**: Add `package.json` explicitly to the `pkg` assets:

```json
"pkg": {
  "entry": "bin/fleet",
  "targets": ["node18-linux-x64", "node18-macos-x64", "node18-macos-arm64"],
  "assets": ["dist/**/*", "package.json"],
  "outputPath": "releases"
}
```

**Verification**: After rebuilding with `npm run build:binaries`, run the
standalone binary with the `DEBUG_PKG=1` environment variable to inspect the
snapshot filesystem contents:

```bash
DEBUG_PKG=1 ./releases/fleet-linux version
```

This prints the virtual filesystem tree, allowing you to confirm that
`package.json` is present at the expected path.

## Node version mismatch in standalone binaries

**Symptom**: A standalone binary crashes with a syntax error or missing API
when running on the embedded Node.js 18 runtime.

**Cause**: The `pkg` targets specify `node18` while `package.json` declares
`engines.node >= 20`. Fleet's TypeScript is compiled to `ES2022`, which Node 18
supports. However, if code is added that uses Node 20+ runtime APIs, those APIs
are absent in the Node 18 binary bundled by `pkg`.

**Current status**: Fleet does not currently use Node 20-specific APIs, so
this mismatch is harmless. It becomes a problem if any of the following are
introduced:

| Feature | Minimum Node version |
|---------|---------------------|
| `Array.fromAsync()` | 22.0.0 |
| Stable `import.meta.resolve` | 20.6.0 |
| `navigator` global | 21.0.0 |
| `WebSocket` global | 22.0.0 |
| `fs.glob()` | 22.0.0 |

**Fix**: When `@yao-pkg/pkg` releases pre-built binaries for newer Node.js
versions, update the targets in `package.json`:

```json
"targets": ["node20-linux-x64", "node20-macos-x64", "node20-macos-arm64"]
```

Alternatively, use the `--build` flag with `pkg` to compile a custom Node.js
binary from source, though this significantly increases build time.

## `fleet version` crashes with no error message

**Symptom**: Running `fleet version` produces a raw stack trace instead of the
clean error messages shown by other commands.

**Cause**: The `version` subcommand at `src/commands/version.ts:4-11` does not
wrap its `require()` call in the standard try/catch pattern used by all other
commands. If `package.json` cannot be loaded, Node.js throws an unhandled
`MODULE_NOT_FOUND` error.

**Fix**: This is a minor robustness issue. The version command could be updated
to match the try/catch pattern used by other commands:

```typescript
.action(() => {
  try {
    const packageJson = require(path.join(__dirname, "..", "..", "package.json"));
    console.log(packageJson.version);
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Failed to read version.");
    }
    process.exit(1);
  }
});
```

**Workaround**: Use `fleet --version` instead, which is handled by Commander.js
and reads `package.json` from `src/cli.ts:19` (one directory level up instead
of two). If one path fails, the other might still work depending on the
directory layout issue.

## `fleet --version` and `fleet version` show different values

**Symptom**: The two version-reporting mechanisms return different strings.

**Cause**: This should not happen under normal circumstances because both
read from the same `package.json`. If it does occur, possible causes are:

1. **Stale build**: The `dist/` directory contains compiled output from a
   different version of the source. Run `npm run clean && npm run build` to
   recompile.
2. **Modified `package.json` after build**: If `package.json` was edited after
   `tsc` compiled the source but before running the command, both paths read the
   same file and should agree. This scenario is unlikely to cause a mismatch.
3. **Multiple `package.json` files**: A `package.json` file exists inside `dist/`
   with a different version. Check that `dist/package.json` does not exist.

**Fix**: Run `npm run clean && npm run build` to ensure the build output is
consistent.

## Unknown option errors

**Symptom**: Running a command with an unrecognized flag shows:

```
error: unknown option '--foo'
(Did you mean --force?)
```

**Cause**: Commander.js v14 rejects unknown options by default. Fleet does not
call `.allowUnknownOption()` on any command.

**Fix**: This is intended behavior. Check the available options with
`fleet <command> --help`. If you need to pass flags through to an underlying
tool, this is not currently supported -- Fleet does not use Commander.js's
`.passThroughOptions()` feature.

## `fleet proxy` shows help instead of running

**Symptom**: Running `fleet proxy` without a subcommand displays help text
instead of performing an action.

**Cause**: The `proxy` command is a Commander.js subcommand group with no
action handler. It has two child commands (`status` and `reload`). When invoked
without a child command, Commander.js displays the group's help.

**Fix**: Specify the subcommand: `fleet proxy status` or `fleet proxy reload`.

## Async errors silently swallowed

**Symptom**: A command fails silently without printing an error message, and
the process exits with code 0.

**Cause**: Fleet uses `program.parse()` (synchronous) instead of
`program.parseAsync()`. If an async action handler throws an error that is not
caught by the handler's try/catch block, the promise rejection is not propagated
to Commander.js. In Node.js versions with unhandled rejection warnings (but not
termination), this manifests as a silent failure.

**Fix**: Ensure all action handlers wrap their async bodies in try/catch. For a
structural fix, the entry points (`bin/fleet` and `src/cli.ts`) could be updated
to use `program.parseAsync(process.argv)` instead of `program.parse()`.

## Native SSH module performance in standalone binaries

**Symptom**: SSH operations (deploy, ps, logs, etc.) are noticeably slower in
the standalone binary than when running via `npm`.

**Cause**: The `ssh2` package used by `node-ssh` includes optional native
bindings for cryptographic operations. In a `pkg` binary, native `.node` addons
are extracted to a cache directory (`~/.cache/pkg/` by default) at runtime. If
extraction fails or the cache is cleared, `ssh2` falls back to its pure
JavaScript implementation, which is slower for crypto operations.

**Fix**: Ensure the user's home directory has a writable `.cache/pkg/` directory.
You can override the cache path with the `PKG_NATIVE_CACHE_PATH` environment
variable:

```bash
PKG_NATIVE_CACHE_PATH=/opt/fleet/cache ./fleet deploy
```

## Related documentation

- [CLI Overview](overview.md) -- command table and distribution channels
- [Version Command](version-command.md) -- dual-version pattern and path details
- [Integrations](integrations.md) -- `pkg`, Commander.js, and `require()` details
- [CLI Architecture](architecture.md) -- `parse()` vs `parseAsync()` discussion
- [CLI Commands Integrations](../cli-commands/integrations.md) -- Docker
  Compose, SSH, and Caddy troubleshooting
- [SSH Connection Lifecycle](../ssh-connection/connection-lifecycle.md) --
  connection management and cleanup patterns
- [SSH Authentication](../ssh-connection/authentication.md) -- SSH key and
  agent configuration
- [Process Status Troubleshooting](../process-status/troubleshooting.md) --
  troubleshooting `fleet logs` and `fleet ps`
- [Bootstrap Troubleshooting](../bootstrap/bootstrap-troubleshooting.md) --
  diagnosing proxy bootstrap failures
- [Deploy Troubleshooting](../deploy/troubleshooting.md) -- diagnosing
  deployment failures
- [Validation Troubleshooting](../validation/troubleshooting.md) --
  resolving validation errors
