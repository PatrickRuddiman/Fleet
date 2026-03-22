# The `fleet validate` Command

The `fleet validate` command runs all configuration checks against a `fleet.yml`
file and its referenced Docker Compose file, reporting errors and warnings to the
terminal. It is the primary tool for pre-flight configuration verification.

Source: `src/commands/validate.ts`

## Usage

```
fleet validate [file]
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `file` | No | `./fleet.yml` | Path to the Fleet configuration file |

The `[file]` argument defaults to `"./fleet.yml"`, which resolves relative to
the current working directory (`process.cwd()`).

## How the command works

The validate command executes a three-phase process:

### Phase 1: Load Fleet configuration

```
loadFleetConfig(file)
```

Reads the YAML file, parses it, and validates it against the Zod schema. If
the file is missing, unreadable, or fails schema validation, the command prints
the error and exits with code 1. Schema errors are formatted using Zod v4's
`prettifyError` function (`src/config/loader.ts:22-24`), which produces
human-readable messages.

### Phase 2: Load Compose file

```
path.resolve(dir, config.stack.compose_file)
```

The compose file path is resolved relative to the **directory** of the Fleet
config file, not the current working directory. For example, if you run
`fleet validate configs/fleet.yml` and that file specifies
`compose_file: "docker-compose.yml"`, the compose file is loaded from
`configs/docker-compose.yml`.

The default value of `compose_file` is `"docker-compose.yml"`
(`src/config/schema.ts:50`).

### Phase 3: Run all checks

```
runAllChecks(config, compose)
```

Runs validation checks and separates findings into errors and warnings. The
checks are defined across two modules and executed in the following order
(see `src/validation/index.ts:27-38`):

#### Fleet configuration checks

These validate the `fleet.yml` schema beyond what Zod catches:

| Code | Severity | What it checks | Resolution |
|------|----------|----------------|------------|
| `INVALID_STACK_NAME` | error | Stack name matches `^[a-z\d][a-z\d-]*$` | Use lowercase alphanumeric with hyphens, not starting with a hyphen |
| `ENV_CONFLICT` | error | Both `env.entries` and `env.infisical` are configured | Use one source or the other; Infisical overwrites the `.env` file produced by entries |
| `INVALID_FQDN` | error | Route domain is a valid fully qualified domain name | Use a valid FQDN like `app.example.com` |
| `INVALID_PORT_RANGE` | error | Route port is between 1 and 65535 | Correct the port number |
| `DUPLICATE_HOST` | error | No two routes share the same domain | Ensure each route uses a unique domain |

#### Compose file checks

These cross-reference the compose file against Fleet's requirements:

| Code | Severity | What it checks | Resolution |
|------|----------|----------------|------------|
| `PORT_80_CONFLICT` | error | No service binds host port 80 | Remove the binding; the Caddy reverse proxy handles port 80 |
| `PORT_443_CONFLICT` | error | No service binds host port 443 | Remove the binding; the Caddy reverse proxy handles port 443 |
| `SERVICE_NOT_FOUND` | error | Route's `service` field references a service that exists in the compose file | Add the service to compose or fix the route |
| `PORT_EXPOSED` | warning | Service binds a host port (other than 80/443) | Consider removing unless external access is required |
| `NO_IMAGE_OR_BUILD` | warning | Service has neither `image` nor `build` directive | Add an `image` or `build` to the service |
| `ONE_SHOT_NO_MAX_ATTEMPTS` | warning | Service with `on-failure` restart policy lacks `max_attempts` | Set `deploy.restart_policy.max_attempts` to prevent infinite restart loops |

## Output format

### Errors

```
Errors:
  ✗ [PORT_80_CONFLICT] Service "web" binds host port 80 which is reserved for the reverse proxy
    Resolution: Remove the host port 80 binding from service "web" in compose.yml; the reverse proxy handles port 80
```

### Warnings

```
Warnings:
  ⚠ [PORT_EXPOSED] Service "redis" binds host port 6379 which may conflict with other stacks
    Resolution: Consider removing the host port binding for port 6379 from service "redis" unless external access is required
```

### Summary line

```
Found 1 error(s) and 1 warning(s).
```

## Exit codes

| Exit code | Condition |
|-----------|-----------|
| 0 | No errors (warnings are acceptable) |
| 1 | One or more error-severity findings, OR the config/compose file could not be loaded |

**CI/CD behavior**: A pipeline step running `fleet validate` will fail (non-zero
exit) only on errors. Warnings alone produce exit code 0, meaning CI pipelines
pass when only warnings are present. There is no built-in flag to promote
warnings to errors. To enforce stricter checks in CI, you would need to parse
the output or wrap the command.

## Zod error messages and user-friendliness

Fleet uses [Zod](https://zod.dev/) for runtime schema validation of `fleet.yml`.
When the config file fails Zod validation, the error messages come directly from
Zod's error formatting.

### Union type error reporting

The `env` field in `fleet.yml` accepts three formats (defined in
`src/config/schema.ts:57`):

1. An array of `{key, value}` entries
2. An object with a `file` field pointing to a `.env` file
3. An object with optional `entries` and `infisical` fields

When a `z.union()` type fails validation because none of the branches match,
Zod reports errors from all branches, which can produce verbose, confusing
messages. For example, a typo in the `infisical` field might produce errors for
all three union branches simultaneously. This is a known ergonomic limitation of
Zod union types.

### YAML parser behavior

Fleet uses the [`yaml`](https://eemeli.org/yaml/) npm package (version 2.x) for
YAML parsing. This package supports YAML 1.2, which is the version used by
Docker Compose. Key behaviors:

- **Multi-document files**: The parser loads only the first document. YAML
  files with multiple documents separated by `---` will have subsequent
  documents silently ignored.
- **Anchors and aliases**: Fully supported. Compose files that use YAML anchors
  (`&anchor`) and aliases (`*anchor`) for DRY configuration are parsed correctly.
- **Docker Compose compatibility**: YAML 1.2 differs from YAML 1.1 in how it
  handles values like `yes`, `no`, `on`, `off` (no longer treated as booleans).
  Since Docker Compose also uses YAML 1.2 in modern versions, this is compatible.

## Docker Compose compatibility

Fleet's compose file parsing focuses on the fields it needs for deployment and
routing. The following aspects of Docker Compose specification support are
relevant:

- **Versions**: Fleet does not validate a `version` field in the compose file.
  It parses the Compose specification format (sometimes called "v3" or the
  unified Compose spec).
- **`profiles`**: Not explicitly handled. Services with profiles may be included
  in validation even if they wouldn't be started by `docker compose up`.
- **`extends`**: Not processed by Fleet's parser. The compose file should be
  fully resolved before Fleet parses it, or use YAML anchors instead.
- **`include`**: Not processed. Multi-file compose configurations using the
  `include` directive should be merged before Fleet validation.

## Validation during deployment

The `fleet validate` command and `fleet deploy` share the same validation logic.
During deployment, `runAllChecks()` is called at Step 1
(`src/deploy/deploy.ts:49-57`). See the
[deploy command reference](../cli-entry-point/deploy-command.md) for the full
deploy lifecycle:

- **Errors**: Block deployment immediately. The deploy process exits with code 1
  before opening an SSH connection.
- **Warnings**: Are collected and included in the deployment summary output but
  do not block deployment.

The key difference is that `fleet validate` displays full resolution messages
for every finding, while `fleet deploy` shows only error messages (without
resolutions) and collects warnings into the summary.

## Integration with Commander.js

The validate command is registered as a subcommand of the Fleet CLI program
using Commander.js (`src/commands/validate.ts:7-80`). Commander handles:

- **Argument parsing**: The `[file]` argument with default value.
- **Help text**: `fleet validate --help` displays the description and argument.
- **Error on unknown options**: Commander's default behavior rejects unrecognized
  flags.

The `register(program)` function is called by the CLI entry point at
`src/cli.ts` to wire the command into the program tree.

### How the default file argument resolves

The `[file]` argument defaults to the string `"./fleet.yml"`. Commander passes
this string directly to the action handler. The string is then used as-is with
`loadFleetConfig(file)`, which calls `fs.readFileSync(filePath, "utf-8")`. Since
`readFileSync` resolves relative paths against `process.cwd()`, the effective
path is `{cwd}/fleet.yml`.

## When to run validation

| Scenario | Run validate? | Why |
|----------|--------------|-----|
| Before first deploy | Yes | Catch configuration issues before touching the server |
| After editing `fleet.yml` | Yes | Verify changes are valid |
| After editing `compose.yml` | Yes | Catch port conflicts and missing services |
| In CI/CD pipeline | Yes | Gate deployments on configuration correctness |
| Before `fleet env` | Optional | `fleet env` does not run validation |

## Related pages

- [Validation Overview](./overview.md) --- Architecture and check pipeline.
- [Validation Codes Reference](./validation-codes.md) --- Complete catalog of
  error and warning codes.
- [Fleet Configuration Checks](./fleet-checks.md) --- Checks against
  `fleet.yml`.
- [Compose Configuration Checks](./compose-checks.md) --- Checks against Docker
  Compose files.
- [Troubleshooting](./troubleshooting.md) --- Common failures and fixes.
- [Configuration Loading and Validation](../configuration/loading-and-validation.md)
  --- How `fleet.yml` is loaded and schema-validated.
- [Configuration Schema Reference](../configuration/schema-reference.md) ---
  Field-by-field `fleet.yml` specification.
- [Deploy Command](../cli-entry-point/deploy-command.md) --- How validation runs
  during deployment.
- [CI/CD Integration](../ci-cd-integration.md) --- Using `fleet validate` as a
  pipeline gate.
- [Compose Query Functions](../compose/queries.md) --- Query functions that
  validation checks rely on.
