# Troubleshooting

This page covers operational questions, common failure modes, and debugging
strategies for `fleet logs` and `fleet ps`.

## Common issues

### `fleet.yml` not found

Both commands resolve `fleet.yml` from the current working directory using
`path.resolve("fleet.yml")`. If the file does not exist:

```
Error: ENOENT: no such file or directory, open '/path/to/fleet.yml'
```

**Resolution**: Run the command from the directory containing your `fleet.yml`,
or `cd` to the project root. There is no CLI flag or environment variable
to override the config path.

### Stack not found in server state

If the specified stack name does not exist in `~/.fleet/state.json`:

- **`fleet logs`**: `Stack "<name>" not found on the remote server.`
- **`fleet ps`**: `Stack "<name>" not found in server state. Available stacks: app1, app2`

The `ps` error message helpfully lists all stacks present in state. The `logs`
error does not.

**Resolution**: Verify the stack name matches what was used in `fleet deploy`.
Run `fleet ps` without arguments to see all deployed stacks.

### SSH connection failure

Both commands fail immediately if the SSH connection cannot be established.
The error message comes from the `node-ssh` library and may include:

- `All configured authentication methods failed` — the SSH key or agent
  is not configured correctly.
- `connect ECONNREFUSED` — the SSH daemon is not running or the host/port
  is wrong.
- `getaddrinfo ENOTFOUND` — the hostname cannot be resolved.

**Resolution**: Verify `server.host`, `server.port`, `server.user`, and
`server.identity_file` in `fleet.yml`. If no `identity_file` is specified,
ensure `SSH_AUTH_SOCK` is set and the SSH agent has the correct key loaded.
See the [SSH authentication guide](../ssh-connection/authentication.md).

### Docker daemon not running

If the Docker daemon is not running on the remote server:

- **`fleet ps`**: Falls back gracefully — shows services from state with
  `"unknown"` status. The user sees a table but cannot determine actual
  container state.
- **`fleet logs`**: Fails with the Docker error message
  (e.g., `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`).

**Resolution**: SSH into the server and verify Docker is running:
```bash
sudo systemctl status docker
sudo systemctl start docker
```

### Containers removed externally

If containers were removed outside of Fleet (e.g., by running
`docker compose down` directly on the server), `fleet ps` handles this
gracefully:

1. `docker compose ps` returns a non-zero exit code or empty output.
2. The fallback logic at `src/ps/ps.ts:118-128` extracts service names
   from the route state.
3. Each service is shown with `"unknown"` status.
4. If no routes exist, a single `(unknown)` entry appears.

The user sees the stack in the table but cannot tell whether containers
are stopped, crashed, or completely absent. The `"unknown"` status is the
only indicator that something is wrong.

**Resolution**: Run `fleet deploy` to recreate the containers, or
`fleet teardown <stack>` to clean up state. See
[Stack Lifecycle Operations](../stack-lifecycle/overview.md) for the full
stop/teardown/restart reference.

### Unexpected JSON output from Docker Compose

If `docker compose ps --format json` produces output that Fleet cannot parse:

- Non-JSON lines (warnings, progress indicators) are silently skipped.
- If all lines fail to parse, the result is an empty `ServiceStatus[]`,
  triggering the route-based fallback.

**Diagnosis**: SSH into the server and run the command manually:
```bash
docker compose -p <stack-name> ps --format json
```

Check for:
- Docker Compose V1 (which does not support `--format json`)
- Array-format JSON output (older V2 versions may output `[{...}]` instead
  of one object per line)
- Error messages mixed into stdout

See [Docker Compose integration](./docker-compose-integration.md) for version
requirements.

## State file issues

### Corrupted `state.json`

If `~/.fleet/state.json` contains invalid JSON, `readState` throws:

```
Failed to parse state file: invalid JSON in ~/.fleet/state.json
```

If the JSON is valid but fails Zod schema validation:

```
Invalid state file structure: ~/.fleet/state.json — <validation errors>
```

**Resolution**: SSH into the server and inspect the file:
```bash
cat ~/.fleet/state.json
cat ~/.fleet/state.json | python3 -m json.tool  # pretty-print
```

To repair: either fix the JSON manually or delete it. A missing state file
causes `readState` to return a default empty state (no stacks), which means
`fleet ps` shows "No stacks are currently deployed."

### Missing `state.json`

If `~/.fleet/state.json` does not exist (e.g., a fresh server or the file
was deleted), `readState` returns:

```json
{ "fleet_root": "", "caddy_bootstrapped": false, "stacks": {} }
```

`fleet ps` prints "No stacks are currently deployed." and exits cleanly.
`fleet logs` fails with "Stack not found" because no stacks exist in the
empty state.

### Backing up state

The state file is not backed up automatically. To create a manual backup
before a risky operation:

```bash
ssh user@server "cp ~/.fleet/state.json ~/.fleet/state.json.backup"
```

### Concurrent access

There is no locking mechanism on the state file. Both `logs` and `ps` only
read state and do not write it, so concurrent `logs`/`ps` commands are safe.
However, running `fleet ps` concurrently with `fleet deploy` (which writes
state) could produce a transient inconsistency where `ps` reads state before
or after the deploy's write. The atomic write pattern (write to `.tmp` then
`mv`) in `writeState` ensures the file is never in a partially-written state.

## SSH connection drop during `fleet logs`

When streaming logs, an SSH connection drop results in:

- The `streamExec` promise rejects.
- The error is caught by the outer try/catch.
- The error message is printed (e.g., connection reset).
- `process.exit(1)` terminates the CLI.

There is no automatic reconnection. The user must re-run `fleet logs` to
resume.

### Double SIGINT race condition

If the user presses Ctrl+C twice quickly during `fleet logs`:

1. First SIGINT triggers the handler, which calls `connection.close()`.
2. Second SIGINT may reach Node.js's default handler before the close
   completes, terminating the process immediately.
3. The OS cleans up the SSH socket when the process exits.

This is not a data corruption risk — `fleet logs` is read-only. The worst
case is an orphaned SSH session on the server that will eventually time out.

## Debugging checklist

| Symptom | Check |
|---------|-------|
| "fleet.yml not found" | Are you in the right directory? |
| "Stack not found" | Does the stack name match `fleet.yml`? Run `fleet ps` to list stacks. |
| SSH connection error | Verify `server.*` fields in `fleet.yml`. Test with `ssh user@host`. |
| All services show "unknown" | Is Docker running on the server? Were containers removed externally? |
| No output from `fleet logs` | Is the service producing log output? Try `--tail 100` to see recent history. |
| Empty table from `fleet ps` | Is `~/.fleet/state.json` present and valid on the server? |
| Wrong timestamps | Check server clock skew. Timestamps are stored as ISO 8601 and compared to `Date.now()`. |
| "Ps failed: ..." | Check the full error message — it may indicate a config, SSH, or Docker issue. |

## Related documentation

- [Overview](./overview.md)
- [Logs command reference](./logs-command.md)
- [Ps command reference](./ps-command.md)
- [Docker Compose integration](./docker-compose-integration.md)
- [State version compatibility](./state-version-compatibility.md)
- [SSH connection overview](../ssh-connection/overview.md)
- [SSH authentication](../ssh-connection/authentication.md)
- [SSH connection lifecycle](../ssh-connection/connection-lifecycle.md) -- how
  connections are managed and cleaned up
- [State management overview](../state-management/overview.md)
- [State operations guide](../state-management/operations-guide.md) -- recovery
  scenarios for corrupted or missing state
- [Configuration reference](../configuration/schema-reference.md)
- [Stack lifecycle](../stack-lifecycle/overview.md) -- restart, stop, and
  teardown operations
- [Bootstrap troubleshooting](../bootstrap/bootstrap-troubleshooting.md) --
  diagnosing proxy bootstrap failures
