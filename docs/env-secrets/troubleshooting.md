# Environment and Secrets Troubleshooting

## What This Covers

This page documents failure modes, error messages, and recovery procedures for
the [`fleet env` command](../cli-entry-point/env-command.md) and the secrets-resolution step that runs during
`fleet deploy`. It covers every step of the `pushEnv()` workflow, the Infisical
SDK integration, and the three [environment configuration shapes](./env-configuration-shapes.md).

## Why a Dedicated Troubleshooting Page

The `fleet env` workflow crosses several system boundaries -- local filesystem,
YAML parsing, Zod validation, the Infisical SDK (running locally), SSH
transport, remote shell execution, and file permissions. Each boundary produces
different error signatures. A centralized reference prevents operators from
guessing which layer failed.

## Error Reference

### Step-by-step failure modes

The `pushEnv()` function at `src/env/env.ts:6-65` runs six steps. Each step
has distinct failure modes:

| Step | Operation | Possible failure | Error message pattern |
|------|-----------|-----------------|----------------------|
| 1 | Load `fleet.yml` | File missing | `Could not read config file: {path}` |
| 1 | Parse YAML | Syntax error | `Invalid YAML in config file: {path}` |
| 1 | Validate schema | Malformed fields | `Invalid Fleet configuration in {path}:` followed by Zod details |
| 1 | `$VAR` expansion | Env var not set | `Environment variable "{name}" referenced by env.infisical.{field} in {path} is not set` |
| 2 | Fail-fast check | No env configured | `No env source configured in fleet.yml. Define an 'env' array, env.file, or env.infisical block.` |
| 3 | SSH connect | Connection refused | Depends on SSH library; typically `connect ECONNREFUSED` or `Authentication failed` |
| 4 | Read state | State file missing | Depends on `readState()` implementation; new servers have no state |
| 5 | Stack lookup | Stack not deployed | `Stack "{name}" not found in server state. Run 'fleet deploy' first.` |
| 6 | Resolve secrets (SDK fetch) | Auth failure | SDK throws on `client.auth().accessToken(token)` -- invalid or expired token |
| 6 | Resolve secrets (SDK fetch) | List failure | SDK throws on `client.secrets().listSecrets()` -- 403, 404, or network error |
| 6 | File upload (heredoc) | Write failed | `Failed to upload file to {path}: command exited with code {code}` |
| 6 | File upload (base64) | Write failed | `Failed to upload file to {path}: command exited with code {code}` |
| 6 | Path traversal | Escape attempt | `env.file path "{path}" resolves outside the project directory` |
| 6 | File not found | Local file missing | `env.file not found: {file} (resolved to {fullPath})` |

### Configuration errors

#### Zod validation failures

When `fleet.yml` does not match the expected schema, the config loader at
`src/config/loader.ts:21-25` produces a Zod-formatted error. Because the `env`
field is a union of three shapes, Zod may report errors against all three
alternatives when none match:

```
Invalid Fleet configuration in fleet.yml:
Expected array, received object
  at env
```

**Common causes**:

- Misspelled `infisical` field (e.g., `infisicall`)
- Missing required Infisical subfields (`token`, `project_id`, `environment`,
  `path` are all required)
- Using `key`/`value` entries directly under `env:` as an object instead of an
  array

**Resolution**: Compare your `env` block against the three valid shapes
documented in [Environment Configuration Shapes](./env-configuration-shapes.md)
and the [Configuration Schema Reference](../configuration/schema-reference.md).

#### `$VAR` expansion failures

The config loader at `src/config/loader.ts:37-46` resolves `$VAR` references
in Infisical fields. If the referenced variable is not in `process.env`:

```
Environment variable "INFISICAL_TOKEN" referenced by env.infisical.token
in fleet.yml is not set
```

**Resolution**: Export the variable before running Fleet:

```bash
export INFISICAL_TOKEN=st.xxxx.yyyy.zzzz
fleet env
```

In CI/CD, set it as a pipeline secret (GitHub Actions secret, GitLab CI
variable, etc.).

Note that `$VAR` expansion only applies to the four Infisical fields (`token`,
`project_id`, `environment`, `path`). It does not apply to `env.entries` values
or `env.file` paths.

#### ENV_CONFLICT validation error

When both `env.entries` (non-empty) and `env.infisical` are configured, the
validation module at `src/validation/fleet-checks.ts:4-25` reports:

```
Error (ENV_CONFLICT): "env.entries" and "env.infisical" are both configured,
but "env.infisical" will overwrite the ".env" file produced by "env.entries".
```

**Why this happens**: At runtime, `resolveSecrets()` writes entries first via
heredoc upload, then fetches secrets from the Infisical SDK and uploads the
result via base64 to the same `.env` path, overwriting the entries entirely.

**Resolution**: Use one source or the other. To combine values from both
sources, either add the entry-style variables to Infisical, or use the file
reference shape with a pre-merged `.env` file.

### SSH and remote server errors

#### Connection failures

The SSH connection at `src/env/env.ts:23-25` uses the `server` block from
`fleet.yml`. Common failures:

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| `connect ECONNREFUSED` | SSH daemon not running or wrong port | Check `server.host` and `server.port`; verify `sshd` is running |
| `Authentication failed` | Wrong key or user | Verify `server.user` and `server.privateKey` match the remote server |
| `Connection timed out` | Firewall blocking port 22 | Check security groups / firewall rules |
| `Host key verification failed` | Server key changed | Update `~/.ssh/known_hosts` or configure `server.strictHostKeyChecking` |

After the workflow completes (success or failure), the SSH connection is closed
in the `finally` block at `src/env/env.ts:60-63`.

#### SSH connection drops mid-operation

If the SSH connection drops during the `resolveSecrets()` step:

- **Heredoc upload** (inline array entries): Uses atomic `.tmp` + `mv` pattern
  (`src/deploy/helpers.ts:142-175`). If the connection drops before `mv`, the
  `.tmp` file is left on disk but the original `.env` is untouched.
- **Base64 upload** (file reference and Infisical): Uses a single compound
  command with atomic `.tmp` + `mv` (`src/deploy/helpers.ts:182-205`). If the
  connection drops mid-command, the shell `&&` chain prevents `mv` from running,
  leaving the original `.env` untouched.

All three secret resolution paths (file reference, inline entries, and
Infisical) use one of these two atomic upload methods. There is no non-atomic
redirect path.

**Recovery**: Rerun `fleet env`. The command is idempotent -- it overwrites the
`.env` file completely on each run.

### Stack not found in server state

```
Stack "myapp" not found in server state. Run 'fleet deploy' first.
```

The `getStack()` function at `src/state/state.ts:99-104` looks up the stack name
in `~/.fleet/state.json` on the remote server. This file is created during the
first `fleet deploy` and records the path where each stack was deployed.

**Causes**:

- The stack has never been deployed to this server
- The `stack.name` in `fleet.yml` does not match the name used during deployment
  (stack names are case-sensitive)
- The state file was manually deleted or corrupted

**Resolution**: Run `fleet deploy` to create the stack and its state entry, then
run `fleet env` separately if needed. Alternatively, check that `stack.name` in
`fleet.yml` matches exactly what was used previously.

### Infisical SDK errors

Fleet uses the [`@infisical/sdk`](https://infisical.com/docs/sdks/languages/node)
Node.js package to fetch secrets. The SDK runs locally within the Fleet process
-- no Infisical software is installed on the remote server. The two SDK calls
are `client.auth().accessToken(token)` and `client.secrets().listSecrets()`,
both at `src/deploy/helpers.ts:282-289`.

Errors from the SDK are thrown as JavaScript exceptions and caught by the
`pushEnv()` try/catch block at `src/env/env.ts:53-59`, which prints
`Env push failed: {message}` and exits with code 1.

#### Authentication failure (invalid or expired token)

The `client.auth().accessToken(token)` call at `src/deploy/helpers.ts:283`
fails if the token is invalid, expired, or revoked.

**Symptoms**: Error message referencing `401`, `Unauthorized`, or an SDK-specific
authentication error.

**Resolution**: Generate a new machine identity access token in the Infisical
dashboard. Update the `env.infisical.token` value in `fleet.yml` or the
environment variable it references.

#### Authorization failure (403)

The `client.secrets().listSecrets()` call at `src/deploy/helpers.ts:285-289`
fails with 403 when the identity associated with the token does not have access
to the specified project, environment, or path.

**Symptoms**: Error message referencing `403` or `Forbidden`.

**Resolution**: In the Infisical dashboard, verify the machine identity has
read access to the project (`project_id`), the target environment
(`environment`), and the secret path (`path`).

#### Resource not found (404)

The `listSecrets()` call can return 404 when the `project_id`, `environment`,
or `path` does not exist in Infisical.

**Symptoms**: Error message referencing `404` or `Not Found`.

**Resolution**: Verify all three values match exactly what is configured in the
Infisical dashboard. Paths and environment slugs are case-sensitive.

#### Network failure (Infisical API unreachable)

The SDK makes HTTPS requests to the Infisical API (default:
`https://app.infisical.com`). If the API is unreachable from the machine
running Fleet, the SDK throws a network error.

**Symptoms**: Error messages referencing `ECONNREFUSED`, `ETIMEDOUT`,
`ENOTFOUND`, or similar network errors.

**Resolution**: Verify outbound HTTPS connectivity from the local machine (not
the remote server) to the Infisical API endpoint. For self-hosted Infisical,
check the custom API URL.

#### Node.js version incompatibility

The `@infisical/sdk` package (v5+) requires Node.js 20 or later. If Fleet is
running on an older Node.js version, the SDK may fail to instantiate.

**Symptoms**: Errors during `require()` or `import` of `@infisical/sdk`, or
unexpected runtime errors from the SDK internals.

**Resolution**: Upgrade Node.js to version 20 or later.

#### No retry or circuit-breaker

The SDK call is a single attempt with no retry logic or circuit-breaker. If the
Infisical API returns a transient error (500, 502, 503), the operation fails
immediately.

**Recovery**: Rerun `fleet env` after the transient issue resolves.

#### Previously deployed `.env` remains untouched on failure

When the SDK fetch fails, the error is thrown before `uploadFileBase64()` is
called. The previously deployed `.env` file on the remote server is not
modified. Services continue running with their existing environment.

### File upload failures

#### Heredoc upload failure

```
Failed to upload file to /home/deploy/.fleet/stacks/myapp/.env:
command exited with code 1 -- Permission denied
```

The heredoc upload at `src/deploy/helpers.ts:142-175` runs separate SSH
commands for `mkdir -p`, `cat << 'FLEET_EOF' > {tmpPath}`, `mv`, and
optionally `chmod`.

**Common causes**: Disk full, directory permissions, or SELinux restrictions.

#### Base64 upload failure

Same error pattern. The base64 upload at `src/deploy/helpers.ts:182-205` runs
a single compound command:
`mkdir -p {dir} && echo '{base64}' | base64 -d > {tmpPath} && mv {tmpPath} {path} && chmod {perms} {path}`.

**Additional cause**: If the base64 string contains single quotes (it should
not, since base64 uses `[A-Za-z0-9+/=]`), the shell command would break.

### File reference (env.file) errors

#### Path traversal rejection

```
env.file path "../../etc/passwd" resolves outside the project directory
-- path traversal is not allowed
```

The check at `src/deploy/helpers.ts:229-232` resolves the path with
`path.resolve()` and verifies the result starts with the config directory plus
a path separator. This is a security measure, not a bug.

**Resolution**: Move the `.env` file inside the project directory, or use a
symlink within the project that points to the actual file.

#### File not found

```
env.file not found: .env.production (resolved to /home/user/project/.env.production)
```

The check at `src/deploy/helpers.ts:234-237` verifies the file exists before
reading.

**Resolution**: Create the file at the expected path, or fix the `env.file`
value in `fleet.yml`.

## CLI Command Behavior

### Does `fleet env` accept flags?

No. The command registration at `src/commands/env.ts:4-19` defines no options
or arguments. All behavior is driven by `fleet.yml` configuration. There is no
`--force`, `--dry-run`, or `--stack` flag. The command always reads `fleet.yml`
from the current working directory.

### Error handling and exit codes

The command uses a double try/catch pattern:

1. **Inner try/catch** in `pushEnv()` (`src/env/env.ts:53-59`): Catches all
   errors, prints `Env push failed: {message}`, and calls `process.exit(1)`.
2. **Outer try/catch** in the Commander action (`src/commands/env.ts:9-18`):
   Catches any error that escapes `pushEnv()` and also calls `process.exit(1)`.

The inner handler should catch everything, making the outer handler a safety
net. Both exit with code 1 on failure and print to stderr.

Successful runs exit with code 0 (implicit) and print:

```
Success: .env file written for stack "myapp".
If your services need to pick up the new values, restart them with 'fleet restart'.
```

## Security Considerations

### Token in local process memory only

The Infisical token is resolved from `process.env` or from the `fleet.yml`
literal value by the config loader at `src/config/loader.ts:37-46`. It is
passed to the Infisical SDK running in the local Fleet process. The token is
never sent to the remote server -- it does not appear in any SSH command string,
shell history, or `/proc/{pid}/environ` on the remote host.

The token is present in the local process's memory and `process.env` for the
duration of the `fleet env` run. Standard local process security practices
apply (e.g., restrict access to the machine running Fleet, avoid logging
environment variables).

### File permissions timing window

All `.env` files are written with `0600` permissions. However, there is a brief
timing window in both upload methods:

- **Heredoc upload** (`uploadFile`): The `.tmp` file is created with default
  umask permissions. `chmod` is applied after `mv`. Between `mv` and `chmod`,
  the file has broader permissions.
- **Base64 upload** (`uploadFileBase64`): The `.tmp` file is created with
  default umask permissions. `chmod` runs as the last step in the `&&` chain.
  Between `mv` and `chmod`, the file has broader permissions.

In practice, this window is milliseconds on a single-user deployment server.
For high-security environments, consider restricting the deploy user's umask
to `0077`. See [Security Model](./security-model.md) for a complete analysis.

### Services must be restarted

After `fleet env` writes the `.env` file, running containers still have the
old environment values in memory. You must restart services to pick up changes:

- `fleet restart` -- restarts all services in the stack
- `fleet deploy` -- detects the env hash change and restarts affected services

The success message at `src/env/env.ts:47-52` reminds operators of this.

## Schema Evolution

The `env` field schema is defined in `src/config/schema.ts` as a Zod union.
Adding new shapes or fields requires:

1. Updating the Zod schema in `src/config/schema.ts`
2. Adding type narrowing branches in `resolveSecrets()`
   (`src/deploy/helpers.ts:211-299`)
3. Updating `configHasSecrets()` in `src/deploy/helpers.ts`
4. Adding `$VAR` expansion for any new secret-bearing fields in the config
   loader (`src/config/loader.ts:30-61`)
5. Updating validation checks if new conflicts are possible
   (`src/validation/fleet-checks.ts`)

## Quick Diagnostic Checklist

When `fleet env` fails, work through these checks in order:

1. **Is `fleet.yml` valid?** -- Run [`fleet validate`](../validation/validate-command.md) or check the error output
   for Zod messages
2. **Is there an env source?** -- Confirm `env` is present in `fleet.yml`
3. **Can you SSH to the server?** -- Try `ssh user@host` manually
4. **Is the stack deployed?** -- Check [`~/.fleet/state.json`](../state-management/schema-reference.md) on the server
5. **Is the Infisical token valid?** -- Verify the token locally by calling the
   [Infisical API](https://infisical.com/docs/api-reference/overview/introduction)
   or using the Infisical dashboard to confirm it is not expired or revoked
6. **Is the Infisical API reachable?** -- Check outbound HTTPS from the local
   machine (where Fleet runs) to `app.infisical.com` or your self-hosted URL
7. **Is there disk space?** -- Check `df -h` on the remote server
8. **Are file permissions correct?** -- Check the deploy user's write access to
   the stack directory
9. **Is Node.js 20+ installed?** -- Run `node --version` locally; the
   `@infisical/sdk` requires Node.js 20 or later

## Related documentation

- [Environment and Secrets Overview](./overview.md) -- the complete `fleet env`
  workflow
- [Infisical Integration](./infisical-integration.md) -- SDK authentication,
  secret fetching, and network requirements
- [Environment Configuration Shapes](./env-configuration-shapes.md) -- the
  three `env` field formats
- [Security Model](./security-model.md) -- file permissions, path traversal,
  and transport security
- [State and Change Detection](./state-data-model.md) -- how `env_hash` drives
  the classification decision tree
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  full `fleet.yml` specification
- [Secrets Resolution (Deploy)](../deploy/secrets-resolution.md) -- the same
  logic from the deploy pipeline perspective
- [Deploy Troubleshooting](../deploy/troubleshooting.md) -- troubleshooting
  the broader deployment pipeline
- [CLI Env Command](../cli-entry-point/env-command.md) -- command registration
  and usage for `fleet env`
- [SSH Connection Layer](../ssh-connection/overview.md) -- how remote commands
  are executed
- [SSH Authentication](../ssh-connection/authentication.md) -- diagnosing SSH
  connection failures
- [Validation Overview](../validation/overview.md) -- the pre-flight check
  system that catches `ENV_CONFLICT` and other configuration errors
- [Fleet Root Troubleshooting](../fleet-root/troubleshooting.md) -- related
  troubleshooting for project root discovery issues
- [Configuration Overview](../configuration/overview.md) -- how `fleet.yml` is
  loaded and validated before `fleet env` runs
