# Docker Compose Integration

Fleet's `logs` and `ps` commands execute Docker Compose CLI commands on the
remote server over SSH. This page documents the Docker Compose version
requirements, the expected JSON output format, and how to troubleshoot
common integration issues.

## Docker Compose version requirements

Fleet uses the `docker compose` V2 plugin syntax (space-separated), **not**
the legacy `docker-compose` V1 binary (hyphenated). This is the same
requirement as the [bootstrap process](../bootstrap/bootstrap-integrations.md#docker-engine-version-requirements).
All commands are constructed as:

```
docker compose -p <project-name> <subcommand> [options]
```

### Minimum version for `--format json`

The `--format json` flag for `docker compose ps` was introduced in Docker
Compose V2. The minimum recommended version is **Docker Compose v2.6.0** or
later, which stabilized the JSON output format.

To verify the installed version on the remote server:

```bash
docker compose version
```

If the remote server has only the legacy `docker-compose` V1 binary, Fleet
commands will fail because `docker compose` (the V2 plugin) will not be found.

### How to install Docker Compose V2

Docker Compose V2 is included with Docker Desktop and is available as a CLI
plugin for Docker Engine on Linux:

```bash
# Install as Docker CLI plugin (Linux)
sudo apt-get update
sudo apt-get install docker-compose-plugin
```

See the [Docker Compose installation guide](https://docs.docker.com/compose/install/)
for platform-specific instructions.

## JSON output format

### `docker compose ps --format json`

Fleet's `parseDockerComposePs` function (at `src/ps/ps.ts:16-41`) expects
the output to be one JSON object per line. Each object must contain at least
`Service` and `State` fields.

According to Docker's official documentation, the JSON output includes these
fields:

| Field | Type | Description |
|-------|------|-------------|
| `ID` | string | Container ID |
| `Name` | string | Container name (e.g., `myapp-web-1`) |
| `Service` | string | Compose service name (e.g., `web`) |
| `State` | string | Container state (`running`, `exited`, `paused`, etc.) |
| `Health` | string | Health check status (empty if no health check) |
| `ExitCode` | number | Exit code if container has stopped |
| `Publishers` | array | Port publishing information |
| `Project` | string | Compose project name |
| `Command` | string | Container command |

Fleet uses only `Service` (with `Name` as fallback) and `State`. All other
fields are ignored.

### Output format variations

Docker Compose has changed its JSON output format across versions:

- **v2.0-v2.5**: JSON output was a JSON array (`[{...}, {...}]`). Fleet's
  parser may not handle this correctly because it splits on newlines and
  parses each line individually.
- **v2.6+**: JSON output is one JSON object per line (NDJSON format). This
  is what Fleet expects.
- **v2.17+**: Confirmed to output NDJSON with the fields listed above.

If you encounter parsing issues, verify the Docker Compose version and
check the raw output:

```bash
docker compose -p <stack-name> ps --format json
```

### Parser resilience

The parser in `src/ps/ps.ts:28-36` wraps each `JSON.parse` call in a
try/catch and silently skips lines that are not valid JSON. This means:

- Warning messages or informational text from Docker Compose are ignored.
- Blank lines are skipped.
- If the entire output is non-JSON (e.g., an error message), the result
  is an empty array, which triggers the route-based fallback.

## `docker compose logs -f`

The `logs` command constructs:

```
docker compose -p <stackName> logs -f [--tail <n>] [service]
```

This is a long-running streaming command. The `-f` flag follows log output
in real time, similar to `tail -f`. The `--tail` option limits the number
of historical log lines shown before streaming begins (defaults to showing
all history).

The log output is piped directly to the local terminal through the SSH
streaming interface (see [Connection API](../ssh-connection/connection-api.md#streamexeccommand-string-callbacks-streamexeccallbacks-promiseexecresult)
for details on `streamExec`). Each chunk of output from Docker Compose appears on
the user's terminal as it is received.

## Project name (`-p` flag)

Both `logs` and `ps` pass the stack name as the Docker Compose project name
using the `-p` flag. This is critical: Docker Compose uses the project name
to identify which containers belong to a stack.

The project name must match exactly what was used during `fleet deploy`.
Fleet guarantees this by always using the `stack.name` value from `fleet.yml`
as the project name. The name is validated by `STACK_NAME_REGEX`
(`/^[a-z\d][a-z\d-]*$/`) in `src/config/schema.ts:46`, which ensures:

- Starts with a lowercase letter or digit
- Contains only lowercase letters, digits, and hyphens
- No leading hyphens

This pattern is a subset of Docker Compose's project naming rules, so any
valid Fleet stack name is also a valid Docker Compose project name.

## What happens if Docker is not running

If the Docker daemon is not running on the remote server:

- **`fleet ps`**: The `docker compose ps` command returns a non-zero exit
  code. The `ps` command falls back to showing services from the Fleet state
  file with `"unknown"` status. The user sees a table, but all statuses
  will be `"unknown"`.

- **`fleet logs`**: The `docker compose logs` command fails. The error message
  from Docker (typically "Cannot connect to the Docker daemon") propagates
  through the SSH connection and is printed to stderr.

## Related documentation

- [Ps command reference](./ps-command.md)
- [Logs command reference](./logs-command.md)
- [Process Status Overview](./overview.md)
- [Troubleshooting](./troubleshooting.md)
- [State Version Compatibility](./state-version-compatibility.md) -- how `ps`
  handles different state file versions
- [Caddy proxy configuration](../caddy-proxy/overview.md)
- [Deploy sequence](../deploy/deploy-sequence.md)
- [SSH Connection API](../ssh-connection/connection-api.md) -- the `ExecFn` and
  `StreamExecFn` interfaces used for remote commands
- [Stack Lifecycle Integrations](../stack-lifecycle/integrations.md) -- Docker
  Compose usage in lifecycle operations
