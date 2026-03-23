# Integrations

This document covers the external libraries, tools, and runtime mechanisms that
the CLI entry point (`src/cli.ts`) and the version command
(`src/commands/version.ts`) depend on directly.

## Commander.js

- **Package**: [`commander`](https://www.npmjs.com/package/commander) ^14.0.3
- **Source**: `src/cli.ts:1`, `src/commands/version.ts:1`
- **Official docs**: [Commander.js README](https://github.com/tj/commander.js)

### How Fleet uses Commander.js

Fleet creates a `Command` instance in `createProgram()` at `src/cli.ts:16-38`,
sets the program name, version, and description, then passes the program object
to each command's `register()` function. Commander.js handles:

- Parsing `process.argv` into commands, arguments, and options
- Generating help text (`fleet --help`, `fleet <command> --help`)
- Displaying the version string (`fleet --version` / `fleet -V`)
- Reporting errors for unknown options, missing arguments, and excess arguments

### Unknown option handling and error reporting

Commander.js v14 is **strict by default**: unrecognized options cause an error
message and exit with code 1. Fleet does not call `.allowUnknownOption()` on any
command, so this strictness applies everywhere.

When a user types an unknown option, Commander.js:

1. Prints an error message: `error: unknown option '--foo'`
2. Suggests similar options if a close match exists (e.g., `(Did you mean --force?)`)
3. Exits with code 1

This behavior can be customized via `program.showSuggestionAfterError(false)` to
disable suggestions, or `program.showHelpAfterError()` to show full help after
errors. Fleet uses neither customization -- the defaults are active.

### The `--version` flag and the `version` subcommand

Commander.js's `.version()` method registers `-V` and `--version` as option
flags on the root program. These are processed during option parsing, before
subcommand matching. The separately registered `version` subcommand at
`src/commands/version.ts:6` is a positional command name matched during
subcommand dispatch.

There is **no conflict** between the two. In Commander.js's help output, the
`--version` flag appears under "Options" and the `version` subcommand appears
under "Commands". This is the same pattern used by tools like npm (`npm --version`
vs `npm version`) and Docker (`docker --version` vs `docker version`).

The flag and subcommand can coexist because Commander.js resolves them at
different parsing stages:

1. Option flags (`--version`) are matched first
2. If no flag matches, the argument is treated as a subcommand name
3. `fleet version` matches the `version` command
4. `fleet --version` matches the version option and exits before subcommand
   dispatch

### `parse()` vs `parseAsync()`

Fleet uses synchronous `program.parse(process.argv)` in both `bin/fleet:5` and
`src/cli.ts:43`. Commander.js documentation recommends `parseAsync()` for
programs with async action handlers to ensure proper promise rejection handling.

Fleet's action handlers are async but wrap their bodies in try/catch blocks with
explicit `process.exit(1)` on failure. This means unhandled rejections in
practice do not escape to Commander.js. However, if a future command handler
omits the try/catch, the rejection would be silently swallowed with `parse()`
but properly reported with `parseAsync()`.

### Subcommand groups

The `proxy` command uses Commander.js's command grouping: `proxy` is a parent
command with no action handler, and `status` and `reload` are child commands.
When a user runs `fleet proxy` without a subcommand, Commander.js displays
the proxy group's help listing the available subcommands.

### Adding global options

Commander.js supports global options via `.optsWithGlobals()`. To add a
`--verbose` flag across all commands, define it on the root `program` in
`src/cli.ts` before registering subcommands. Each subcommand's action handler
can then read it via `command.optsWithGlobals().verbose`.

## Node.js `require()` for runtime JSON loading

- **Source**: `src/cli.ts:19`, `src/commands/version.ts:9`
- **Official docs**: [Node.js Modules](https://nodejs.org/api/modules.html)

### How Fleet loads `package.json`

Both `src/cli.ts` and `src/commands/version.ts` use Node's `require()` with
`path.join(__dirname, ...)` to load `package.json` at runtime:

| File | Expression | Resolved path |
|------|-----------|---------------|
| `src/cli.ts:19` | `require(path.join(__dirname, "..", "package.json"))` | From `dist/cli.js` → `package.json` (project root) |
| `src/commands/version.ts:9` | `require(path.join(__dirname, "..", "..", "package.json"))` | From `dist/commands/version.js` → `package.json` (project root) |

Both paths resolve to the same `package.json` at the project root after
TypeScript compilation places output in `dist/`. The different relative depths
(`..` vs `../..`) reflect the directory nesting of each source file.

### `__dirname` semantics in different contexts

| Context | `__dirname` value | Path resolution |
|---------|------------------|-----------------|
| Development (`ts-node`) | Physical location of the `.ts` file in `src/` | `src/../package.json` = project root |
| Production (npm install) | Physical location of the `.js` file in `dist/` | `dist/../package.json` = project root |
| Standalone binary (`pkg`) | Virtual snapshot path (`/snapshot/.../dist/`) | **Depends on asset bundling** |

In the `pkg` standalone binary context, `__dirname` points into the virtual
snapshot filesystem. The `require()` call resolves against this virtual
filesystem, where `package.json` must exist. See the `@yao-pkg/pkg` section
below for whether this is the case.

### What happens if `package.json` is not found

If `require()` cannot find `package.json` at the computed path, Node.js throws
a `MODULE_NOT_FOUND` error. Because neither `src/cli.ts` nor
`src/commands/version.ts` wraps the `require()` call in a try/catch, this error
is **unhandled** and crashes the process with a stack trace. In the `cli.ts`
case, this happens during `createProgram()` before any command is parsed, so
every command would fail -- not just `fleet version`.

## @yao-pkg/pkg (standalone binary packaging)

- **Package**: [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) ^5.15.2
  (devDependency)
- **Source**: `package.json:47` (dependency), `package.json:55-66`
  (configuration)
- **Official docs**: [yao-pkg/pkg README](https://github.com/yao-pkg/pkg)

### How pkg bundles Fleet

The `pkg` configuration in `package.json` specifies:

```json
{
  "pkg": {
    "entry": "bin/fleet",
    "targets": ["node18-linux-x64", "node18-macos-x64", "node18-macos-arm64"],
    "assets": ["dist/**/*"],
    "outputPath": "releases"
  }
}
```

`pkg` packages the entry point (`bin/fleet`), traces all `require()` calls to
find dependencies, and bundles them into a single executable. The `assets` field
specifies additional files to include in the virtual snapshot filesystem --
currently only `dist/**/*`.

### Is `package.json` bundled in the binary?

This is a critical question because both `cli.ts` and `version.ts` `require()`
`package.json` at runtime.

`pkg` automatically detects `require()` calls with resolvable paths and
includes the referenced files. Because `cli.ts:19` calls
`require(path.join(__dirname, "..", "package.json"))`, `pkg`'s static analysis
should detect this path and include `package.json` in the snapshot. However,
`path.join(__dirname, ...)` is a dynamic expression -- `pkg` may or may not
resolve it successfully depending on its analysis capabilities.

The `assets` field in the configuration only lists `dist/**/*`, which does **not**
include the root `package.json`. If `pkg`'s static analysis misses the dynamic
`require()` call, `package.json` would be absent from the binary, and every
command would crash with `MODULE_NOT_FOUND`.

To ensure reliability, `package.json` should be explicitly added to the assets:

```json
"assets": ["dist/**/*", "package.json"]
```

See [Troubleshooting](troubleshooting.md#package-json-missing-in-standalone-binary)
for debugging this issue.

### `__dirname` inside a pkg binary

Inside a `pkg`-packaged binary, `__dirname` points to a path within the virtual
snapshot filesystem (e.g., `/snapshot/fleet/dist/`). The `require()` function is
patched by `pkg` to resolve paths within this virtual filesystem. Files that
exist in the snapshot are loaded from the embedded data; files that don't exist
fall through to the real filesystem.

This means `path.join(__dirname, "..", "package.json")` inside the binary
resolves to `/snapshot/fleet/package.json` -- which only works if `package.json`
was included in the snapshot during packaging.

### Node version mismatch: `node18` targets vs `>=20` engines

The `pkg` targets specify `node18` while `package.json` declares
`engines.node >= 20`. This divergence exists because `@yao-pkg/pkg` historically
lagged behind Node.js releases in providing pre-built base binaries.

Fleet currently works on the Node 18 runtime bundled by `pkg` because it does
not use Node 20-specific APIs. The key ES2022 features used by Fleet (top-level
`await` is not used; `Array.prototype.at()`, `Object.hasOwn()`, etc.) are
available in Node 18.

If Fleet adds code using Node 20+ APIs, the standalone binaries will break at
runtime. Watch for:

- `Array.fromAsync()` (Node 22+)
- Stable `import.meta.resolve` (Node 20.6+)
- `navigator` global (Node 21+)
- `WebSocket` global (Node 22+)

### Native module handling in pkg

Fleet depends on `node-ssh` (which wraps `ssh2`). The `ssh2` package includes
optional native bindings for cryptographic operations. When `pkg` encounters
`.node` native addon files, it packages them as assets and extracts them to a
cache directory (`~/.cache/pkg/` by default) at runtime.

If the native bindings fail to load in the packaged binary, `ssh2` falls back
to its pure-JavaScript implementation. Connectivity is unaffected -- only the
performance of cryptographic operations degrades.

### How standalone binaries are built and released

The `build:binaries` script at `package.json:36` runs:

```bash
pkg . --out-path releases
```

This produces three executables in the `releases/` directory. There is no CI/CD
pipeline configured in the repository for automated binary building or release
publishing. The build is run manually.

## npm registry (package distribution)

- **Package**: `@pruddiman/fleet` (scoped, public)
- **Source**: `package.json:1-3`, `package.json:52-53`
- **Official docs**: [npm documentation](https://docs.npmjs.com/)

### How the package is published

The `publishConfig` field at `package.json:52-53` sets `access: "public"`,
allowing the scoped package to be published publicly. The publication workflow:

1. The `prepublishOnly` hook at `package.json:31` runs `npm run build` (which
   invokes `tsc`)
2. TypeScript compiles `src/` to `dist/`
3. `npm publish` uploads the tarball containing `dist/`, `bin/`, and
   `package.json`

The `files` array at `package.json:5-7` restricts the published tarball to
`dist/` and `bin/`. npm always includes `package.json`, `README.md`, `LICENSE`,
and `CHANGELOG.md` regardless of the `files` array.

### How versions are bumped

There is no automated versioning tool (e.g., `semantic-release`,
`standard-version`, `changesets`) configured. The version in `package.json` is
updated manually before publishing. There is no changelog generation beyond the
manually maintained `changelog.md` at the repository root.

### bin entry

The `bin` field at `package.json:27-28` maps the command name `fleet` to
`bin/fleet`. When a user runs `npm install -g @pruddiman/fleet`, npm creates a
symlink (or shim on Windows) from the global `bin/` directory to `bin/fleet`,
making `fleet` available as a command.

## Related documentation

- [CLI Overview](overview.md) -- entry points and command table
- [CLI Architecture](architecture.md) -- component diagram and integration map
- [Version Command](version-command.md) -- dual-version pattern details
- [Troubleshooting](troubleshooting.md) -- packaging issues and error recovery
- [CLI Commands Integrations](../cli-commands/integrations.md) -- integration
  details for operational commands (Docker Compose, Caddy, SSH, state)
- [Deploy Command](deploy-command.md) -- deploy lifecycle and how it uses
  the CLI framework
- [Configuration Loading and Validation](../configuration/loading-and-validation.md)
  -- how `fleet.yml` is loaded (uses the same `require()` pattern for
  `package.json`)
- [Configuration Integrations](../configuration/integrations.md) -- Zod and
  YAML parser details
