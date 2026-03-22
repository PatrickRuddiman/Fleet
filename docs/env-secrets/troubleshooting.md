# Environment and Secrets Troubleshooting

## What This Covers

This page documents failure modes, error messages, and recovery procedures for
the [`fleet env` command](../cli-entry-point/env-command.md) and the secrets-resolution step that runs during
`fleet deploy`. It covers every step of the `pushEnv()` workflow, the Infisical
CLI bootstrap, and the three [environment configuration shapes](./env-configuration-shapes.md).

## Why a Dedicated Troubleshooting Page

The `fleet env` workflow crosses several system boundaries -- local filesystem,
YAML parsing, Zod validation, SSH transport, remote shell execution, Infisical
API, and file permissions. Each boundary produces different error signatures. A
centralized reference prevents operators from guessing which layer failed.

## Error Reference

### Step-by-step failure modes

The `pushEnv()` function at `src/env/env.ts:8-72` runs seven steps. Each step
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
| 6 | Infisical bootstrap | Install failed | `Failed to install Infisical CLI: command exited with code {code}` |
| 6 | Infisical bootstrap | Verify failed | `Infisical CLI installation could not be verified: command exited with code {code}` |
| 7 | File upload (heredoc) | Write failed | `Failed to upload file to {path}: command exited with code {code}` |
| 7 | File upload (base64) | Write failed | `Failed to upload file to {path}: command exited with code {code}` |
| 7 | Infisical export | Export failed | `Failed to export secrets via Infisical CLI: {stderr}` |
| 7 | chmod | Permission denied | `Failed to set .env file permissions: {stderr}` |
| 7 | Path traversal | Escape attempt | `env.file path "{path}" resolves outside the project directory` |
| 7 | File not found | Local file missing | `env.file not found: {file} (resolved to {fullPath})` |

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

**Why this happens**: At runtime, entries are written first via heredoc, then
`infisical export` redirects output to the same `.env` file using `>` (not
`>>`), overwriting the entries.

**Resolution**: Use one source or the other. To combine values from both
sources, either add the entry-style variables to Infisical, or use the file
reference shape with a pre-merged `.env` file.

### SSH and remote server errors

#### Connection failures

The SSH connection at `src/env/env.ts:25-27` uses the `server` block from
`fleet.yml`. Common failures:

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| `connect ECONNREFUSED` | SSH daemon not running or wrong port | Check `server.host` and `server.port`; verify `sshd` is running |
| `Authentication failed` | Wrong key or user | Verify `server.user` and `server.privateKey` match the remote server |
| `Connection timed out` | Firewall blocking port 22 | Check security groups / firewall rules |
| `Host key verification failed` | Server key changed | Update `~/.ssh/known_hosts` or configure `server.strictHostKeyChecking` |

After the workflow completes (success or failure), the SSH connection is closed
in the `finally` block at `src/env/env.ts:68-71`.

#### SSH connection drops mid-operation

If the SSH connection drops during the `resolveSecrets()` step:

- **Heredoc upload**: Uses atomic `.tmp` + `mv` pattern
  (`src/deploy/helpers.ts:145-148`). If the connection drops before `mv`, the
  `.tmp` file is left on disk but the original `.env` is untouched.
- **Base64 upload**: Same atomic pattern
  (`src/deploy/helpers.ts:174-178`). Same safety guarantee.
- **Infisical export**: Uses shell redirect (`>`). If the connection drops
  during export, the `.env` file may be partially written or empty because the
  redirect truncates the file before writing. There is no atomic pattern for
  this code path.

**Recovery**: Rerun `fleet env`. The command is idempotent -- it overwrites the
`.env` file completely on each run.

### Stack not found in server state

```
Stack "myapp" not found in server state. Run 'fleet deploy' first.
```

The `getStack()` function at `src/state/state.ts:93-98` looks up the stack name
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

### Infisical CLI bootstrap failures

#### Installation failure

```
Failed to install Infisical CLI: command exited with code 1 — E: Unable to locate package infisical
```

The installer at `src/deploy/infisical.ts:16-24` downloads the APT repo setup
script from Cloudsmith, runs `apt-get update`, then installs the `infisical`
package.

**Common causes**:

| Cause | Resolution |
|-------|------------|
| Non-Debian server | Pre-install the CLI; see [Platform Limitations](./infisical-integration.md#platform-limitations) |
| Cloudsmith unreachable | Check outbound HTTPS to `dl.cloudsmith.io`; retry later |
| `sudo` not available | Ensure the SSH user has passwordless `sudo` |
| Disk full | Free space on the remote server |
| APT lock held | Another `apt` process is running; wait or kill it |

#### Verification failure

```
Infisical CLI installation could not be verified: command exited with code 127
```

The post-install verification at `src/deploy/infisical.ts:27-33` runs
`infisical --version`. Exit code 127 means the binary is not on PATH.

**Resolution**: Check that `/usr/bin` (or wherever the package installs) is
in PATH for the SSH session. Non-interactive SSH sessions may have a minimal
PATH.

### Infisical CLI export failures

```
Failed to export secrets via Infisical CLI: {stderr}
```

The `infisical export` command at `src/deploy/helpers.ts:270-271` can fail for
several reasons:

| Stderr pattern | Cause | Resolution |
|---------------|-------|------------|
| `401 Unauthorized` | Token expired or invalid | Generate a new token in the Infisical dashboard; update `fleet.yml` or env var |
| `403 Forbidden` | Token lacks access to the project/environment/path | Check token permissions in Infisical dashboard |
| `404 Not Found` | Wrong `project_id`, `environment`, or `path` | Verify values match Infisical dashboard; paths are case-sensitive |
| `connection refused` / `timeout` | Infisical API unreachable | Check outbound HTTPS to `app.infisical.com` (or self-hosted URL) |
| `command not found` | CLI not installed despite bootstrap | Check bootstrap logs; may indicate PATH issue |

#### Partial or empty `.env` file after export failure

When the `infisical export` command fails, the `.env` file may be in one of
three states:

1. **Empty (0 bytes)**: The shell redirect `>` truncated the file before
   `infisical export` produced any output. This is the most common case.
2. **Partially written**: The export started producing output but the process
   was killed or the connection dropped mid-stream.
3. **Previous content intact**: This only happens if the failure occurred before
   the shell redirect was established (unlikely).

In cases 1 and 2, the `.env` file no longer contains valid secrets. Services
that were running before will continue running with their existing in-memory
environment until restarted.

**Recovery**: Fix the root cause (token, network, permissions), then rerun
`fleet env`. Do not restart services until the `.env` file is confirmed
correct.

### File upload failures

#### Heredoc upload failure

```
Failed to upload file to /home/deploy/.fleet/stacks/myapp/.env:
command exited with code 1 — Permission denied
```

The heredoc upload at `src/deploy/helpers.ts:140-162` runs
`mkdir -p {dir} && cat << 'FLEET_EOF' > {tmpPath} ... && mv {tmpPath} {path}`.

**Common causes**: Disk full, directory permissions, or SELinux restrictions.

#### Base64 upload failure

Same error pattern. The base64 upload at `src/deploy/helpers.ts:169-192` runs
`echo '{base64}' | base64 -d > {tmpPath} && mv {tmpPath} {path}`.

**Additional cause**: If the base64 string contains single quotes (it should
not, since base64 uses `[A-Za-z0-9+/=]`), the shell command would break.

### File reference (env.file) errors

#### Path traversal rejection

```
env.file path "../../etc/passwd" resolves outside the project directory
— path traversal is not allowed
```

The check at `src/deploy/helpers.ts:216-219` ensures the resolved path starts
with the config directory. This is a security measure, not a bug.

**Resolution**: Move the `.env` file inside the project directory, or use a
symlink within the project that points to the actual file.

#### File not found

```
env.file not found: .env.production (resolved to /home/user/project/.env.production)
```

The check at `src/deploy/helpers.ts:221-225` verifies the file exists before
reading.

**Resolution**: Create the file at the expected path, or fix the `env.file`
value in `fleet.yml`.

## CLI Command Behavior

### Does `fleet env` accept flags?

No. The command registration at `src/commands/env.ts:4-19` defines no options
or arguments:

```typescript
program
  .command("env")
  .description("Push or refresh secrets (.env file) for the current stack")
  .action(async () => { ... });
```

All behavior is driven by `fleet.yml` configuration. There is no `--force`,
`--dry-run`, or `--stack` flag. The command always reads `fleet.yml` from the
current working directory.

### Error handling and exit codes

The command uses a double try/catch pattern:

1. **Inner try/catch** in `pushEnv()` (`src/env/env.ts:61-67`): Catches all
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

### Token in SSH command string

The Infisical token is interpolated into the command string passed to `exec()`.
While it is not visible in `ps aux` output (because it is an env var prefix,
not a flag), it may be visible in:

- SSH command logging on the server (if enabled)
- `/proc/{pid}/environ` for the duration of the export command
- Shell history if commands are logged

See [Token Security](./infisical-integration.md#token-security) for mitigation
recommendations.

### File permissions

All `.env` files are written with `0600` permissions. However:

- The heredoc and base64 upload methods use atomic `.tmp` + `mv`. The `.tmp`
  file is created with default umask permissions and then `chmod` is applied
  after `mv`. There is a brief window where the `.tmp` file has broader
  permissions.
- The Infisical export writes directly to `.env` via redirect, then runs
  `chmod 0600` as a separate command (`src/deploy/helpers.ts:280-285`). There
  is a brief window where the file has default permissions.

In practice, this window is milliseconds on a single-user deployment server.
For high-security environments, consider restricting the deploy user's umask
to `0077`.

### Services must be restarted

After `fleet env` writes the `.env` file, running containers still have the
old environment values in memory. You must restart services to pick up changes:

- `fleet restart` -- restarts all services in the stack
- `fleet deploy` -- detects the env hash change and restarts affected services

The success message at `src/env/env.ts:58-59` reminds operators of this.

## Schema Evolution

The `env` field schema is defined at `src/config/schema.ts:57` as a Zod union.
Adding new shapes or fields requires:

1. Updating the Zod schema in `src/config/schema.ts`
2. Adding type narrowing branches in `resolveSecrets()`
   (`src/deploy/helpers.ts:198-287`)
3. Updating `configHasSecrets()` (`src/deploy/helpers.ts:409-423`)
4. Adding `$VAR` expansion for any new secret-bearing fields in the config
   loader (`src/config/loader.ts:30-61`)
5. Updating validation checks if new conflicts are possible
   (`src/validation/fleet-checks.ts`)

## Quick Diagnostic Checklist

When `fleet env` fails, work through these checks in order:

1. **Is `fleet.yml` valid?** -- Run `fleet validate` or check the error output
   for Zod messages
2. **Is there an env source?** -- Confirm `env` is present in `fleet.yml`
3. **Can you SSH to the server?** -- Try `ssh user@host` manually
4. **Is the stack deployed?** -- Check `~/.fleet/state.json` on the server
5. **Is the Infisical token valid?** -- Test with `infisical export` manually
   on the server
6. **Is the network path clear?** -- Check outbound HTTPS to Infisical and
   Cloudsmith from the server
7. **Is there disk space?** -- Check `df -h` on the remote server
8. **Are file permissions correct?** -- Check the deploy user's write access to
   the stack directory

## Related documentation

- [Environment and Secrets Overview](./overview.md) -- the complete `fleet env`
  workflow
- [Infisical Integration](./infisical-integration.md) -- CLI bootstrap,
  authentication, and network requirements
- [Environment Configuration Shapes](./env-configuration-shapes.md) -- the
  three `env` field formats
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
