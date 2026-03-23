# Logs Command

The `fleet logs` command streams real-time log output from Docker Compose
services running on a remote server. It is the equivalent of running
`docker compose logs -f` over an [SSH connection](../ssh-connection/overview.md).

## Usage

```
fleet logs <stack> [service] [-n, --tail <lines>]
```

| Argument/Option | Required | Description |
|----------------|----------|-------------|
| `<stack>` | Yes | The name of the deployed stack |
| `[service]` | No | Filter logs to a single service within the stack |
| `-n, --tail <lines>` | No | Number of recent lines to show before streaming |

### Why is the stack name required?

Unlike `fleet ps` which can list all stacks, `fleet logs` requires an explicit
stack name because log streaming is a long-lived connection that pipes directly
to stdout. Streaming logs from all stacks simultaneously would produce
interleaved, unreadable output. The stack name is used to construct the Docker
Compose project name (`docker compose -p <stack>`), which must match the project
name used during `fleet deploy`.

## Execution flow

The command executes seven steps, all defined in `src/logs/logs.ts`:

1. **Load config** (line 15-16): Reads `fleet.yml` from the current working
   directory via `path.resolve("fleet.yml")`.

2. **Create SSH connection** (line 19): Establishes an SSH session (or local
   connection) to the server defined in `fleet.yml`. See
   [SSH Connection Lifecycle](../ssh-connection/connection-lifecycle.md) for the
   SIGINT-aware pattern used by this command.

3. **Read state** (line 22): Reads
   [`~/.fleet/state.json`](../state-management/overview.md) from the remote
   server to validate the stack exists.

4. **Validate stack** (line 25-28): Confirms the stack name appears in the
   server state. Throws an error if not found.

5. **Build command** (line 31-37): Constructs the Docker Compose command:
   ```
   docker compose -p <stackName> logs -f [--tail <n>] [service]
   ```

6. **Register SIGINT handler** (line 40-45): Installs a `process.on("SIGINT")`
   handler that closes the SSH connection when the user presses Ctrl+C.

7. **Stream execution** (line 49-56): Uses `connection.streamExec()` to
   execute the command remotely, piping stdout and stderr chunks directly to
   the local terminal in real time.

## SIGINT handling and graceful shutdown

When the user presses Ctrl+C during log streaming:

1. The registered SIGINT handler fires and calls `connection.close()`.
2. Closing the SSH connection terminates the remote `docker compose logs`
   process.
3. The `finally` block at line 58 removes the SIGINT listener to prevent
   it from firing again during cleanup.
4. The outer `finally` block at line 61-63 calls `connection.close()` again
   as a safety net (the SSH library handles double-close gracefully).

### What happens if the user sends SIGINT twice rapidly?

The `connection.close()` call in the SIGINT handler uses `.catch(() => {})`
to swallow errors silently. If the user presses Ctrl+C twice in quick
succession, the second SIGINT may reach Node.js's default handler (which
terminates the process) before the connection close completes. In practice,
this results in the process exiting immediately, which is the desired behavior
for a double-Ctrl+C. The SSH connection will be cleaned up by the operating
system when the process exits.

## SSH connection drop during streaming

There is no explicit reconnection or timeout logic for SSH connection loss
during `fleet logs`. If the SSH connection drops mid-stream:

- The `streamExec` promise will reject with an error from the underlying
  `node-ssh` library.
- The error propagates to the outer `try/catch`, which prints the error
  message and calls `process.exit(1)`.
- The `finally` block attempts to close the (already-disconnected) connection.
- The user must manually re-run `fleet logs` to resume streaming.

This is consistent with the behavior of `ssh user@host docker compose logs -f`
— a dropped connection simply ends the stream.

## Docker Compose project name consistency

The logs command passes the stack name directly as the `-p` (project name)
flag to `docker compose` at `src/logs/logs.ts:31`. This means the project
name used during `fleet deploy` must match exactly. Fleet ensures this by
always using `config.stack.name` as the project name in both deployment
(`src/deploy/deploy.ts`) and querying (`src/logs/logs.ts`). The stack name
is validated against `STACK_NAME_REGEX` (`/^[a-z\d][a-z\d-]*$/`) in the
configuration schema, ensuring it is a valid Docker Compose project name.

## Related documentation

- [Overview](./overview.md)
- [Ps command reference](./ps-command.md)
- [Docker Compose integration](./docker-compose-integration.md)
- [Troubleshooting](./troubleshooting.md)
- [SSH connection layer](../ssh-connection/overview.md)
- [SSH authentication](../ssh-connection/authentication.md)
- [SSH connection lifecycle](../ssh-connection/connection-lifecycle.md) -- the
  SIGINT-aware cleanup pattern used by `fleet logs`
- [State management overview](../state-management/overview.md) -- how stack
  state is read and validated
- [Configuration loading](../configuration/loading-and-validation.md) -- how
  `fleet.yml` is loaded
- [Configuration schema reference](../configuration/schema-reference.md) -- the
  stack name validation and server configuration fields
- [Operational CLI Commands](../cli-commands/operational-commands.md) -- full
  reference for all operational commands including `fleet logs`
- [Stack lifecycle](../stack-lifecycle/overview.md) -- restart, stop, and
  teardown operations
