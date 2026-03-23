# Version Command

The `fleet version` command prints the current Fleet version to stdout. This
document explains why the version exists in two places, how the paths resolve
in different runtime contexts, and the implications for standalone binary
packaging.

## Usage

```
fleet version
fleet --version
fleet -V
```

All three invocations print the same version string (e.g., `0.1.10`), but they
follow different code paths.

## Why the version string exists in two places

Fleet provides two ways to query the version:

| Invocation | Mechanism | Source |
|------------|-----------|--------|
| `fleet --version` / `fleet -V` | Commander.js built-in version option | `src/cli.ts:23` |
| `fleet version` | Dedicated subcommand | `src/commands/version.ts:4-11` |

The duplication is **intentional** for user convenience:

- `--version` is the conventional flag that Commander.js users and POSIX
  conventions expect. It is set via `program.version(packageJson.version)` at
  `src/cli.ts:23`.
- The `version` subcommand follows the pattern used by tools like `docker version`,
  `git version`, and `npm version`. It is registered at
  `src/commands/version.ts:4-11`.

Both read the version from `package.json` at runtime using `require()` with a
relative path. They always return the same value because they resolve to the
same file.

### Could a shared utility consolidate the version read?

Yes. A single `getVersion()` function that caches the `package.json` read could
eliminate the duplication. However, the current approach is only two independent
`require()` calls, each totaling one line of code. The maintenance cost of the
duplication is low. The risk is that the two relative paths could diverge if the
build output directory structure changes -- see the path resolution section below.

## How path resolution works

Each version-reading site computes a path relative to `__dirname`:

| File | Code | `__dirname` after `tsc` | Resolved path |
|------|------|------------------------|---------------|
| `src/cli.ts:19` | `path.join(__dirname, "..", "package.json")` | `dist/` | `dist/../package.json` → project root |
| `src/commands/version.ts:9` | `path.join(__dirname, "..", "..", "package.json")` | `dist/commands/` | `dist/commands/../../package.json` → project root |

Both resolve to the project root `package.json` because `tsc` mirrors the `src/`
directory structure into `dist/`:

```
project/
├── package.json          ← target file
├── dist/
│   ├── cli.js            ← __dirname is dist/, one level up
│   └── commands/
│       └── version.js    ← __dirname is dist/commands/, two levels up
└── src/
    ├── cli.ts
    └── commands/
        └── version.ts
```

### When the paths could break

The paths would break if:

1. **`tsconfig.json` changes `rootDir` or `outDir`** to flatten the output
   structure (e.g., removing the `commands/` subdirectory)
2. **A bundler** (like esbuild or webpack) collapses all files into a single
   output file, changing `__dirname` semantics
3. **`package.json` is moved** from the project root

In the current build configuration (`rootDir: "src"`, `outDir: "dist"`), the
paths are stable.

## Behavior in standalone binaries

Inside a `pkg`-packaged binary, `__dirname` points to a virtual snapshot
filesystem path (e.g., `/snapshot/fleet/dist/` or
`/snapshot/fleet/dist/commands/`). The `require()` function is patched by `pkg`
to resolve paths within this virtual filesystem.

For the version command to work in a standalone binary, `package.json` must be
present in the snapshot at the expected relative location. The `pkg` assets
configuration currently lists only `dist/**/*`:

```json
"assets": ["dist/**/*"]
```

This does **not** explicitly include the root `package.json`. Whether `pkg`'s
static analysis detects the dynamic `require(path.join(__dirname, ...))` call
and automatically includes `package.json` depends on `pkg`'s ability to resolve
the expression. If it fails, the version command (and every other command, since
`cli.ts` also reads `package.json`) would crash with `MODULE_NOT_FOUND`.

See [Troubleshooting](troubleshooting.md#package-json-missing-in-standalone-binary)
for how to diagnose and fix this.

## What the command does at runtime

The `fleet version` subcommand (`src/commands/version.ts:4-11`) is minimal:

1. Commander.js matches the `version` argument to the registered subcommand
2. The action handler runs synchronously
3. `require()` loads `package.json` from the computed path
4. `console.log(packageJson.version)` prints the version string to stdout
5. The process exits with code 0 (Commander.js's default behavior after a
   successful action)

There is no try/catch wrapper in the version command -- if `package.json` cannot
be loaded, the unhandled `MODULE_NOT_FOUND` error crashes the process with a
stack trace. This is the only command in Fleet that does not use the standard
try/catch error handling pattern.

## Comparison with Commander.js's built-in `--version`

| Aspect | `fleet --version` | `fleet version` |
|--------|-------------------|-----------------|
| Handler | Commander.js internal | Custom action handler |
| Output | Version string to stdout | Version string to stdout |
| Exit | Immediate exit after printing | Normal exit after action |
| Error handling | Commander.js handles errors | No try/catch (bare `require`) |
| Help output location | Under "Options" | Under "Commands" |
| Short flag | `-V` | None |

## Related documentation

- [CLI Overview](overview.md) -- full command table and dual-version explanation
- [CLI Architecture](architecture.md) -- how `--version` and `version` coexist
- [Integrations](integrations.md) -- Commander.js version option details and
  `require()` path resolution
- [Troubleshooting](troubleshooting.md) -- `package.json` resolution failures
- [Deploy Command](deploy-command.md) -- another command that depends on
  successful `package.json` resolution
