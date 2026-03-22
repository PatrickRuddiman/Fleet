# Connection Interface API Reference

The `Connection` interface (defined in `src/ssh/types.ts:19-23`) is the
contract that both the SSH and local backends implement. Every module that
interacts with a remote (or local) server receives a `Connection` object from
the factory and uses its three methods.

## Types

### `ExecResult`

Returned by both `exec` and `streamExec`. Defined at `src/ssh/types.ts:1-5`.

| Field | Type | Description |
|---|---|---|
| `stdout` | `string` | Standard output from the command |
| `stderr` | `string` | Standard error output from the command |
| `code` | `number` | Exit code (0 = success). Defaults to 0 if the backend returns null |

### `ExecFn`

```typescript
type ExecFn = (command: string) => Promise<ExecResult>;
```

A function type alias for buffered command execution. This is the most commonly
used type across the codebase -- at least 19 consumer files accept `ExecFn` as a
parameter to run commands on the target server. Defined at `src/ssh/types.ts:7`.
See [Bootstrap Integrations](../bootstrap/bootstrap-integrations.md#ssh--remote-execution-layer)
for how `ExecFn` is used during bootstrap.

### `StreamExecCallbacks`

```typescript
interface StreamExecCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}
```

Callback hooks for real-time output streaming. Defined at
`src/ssh/types.ts:9-12`.

### `StreamExecFn`

```typescript
type StreamExecFn = (
  command: string,
  callbacks: StreamExecCallbacks
) => Promise<ExecResult>;
```

A function type alias for streaming command execution. Defined at
`src/ssh/types.ts:14-17`. Used by the
[logs command](../process-status/docker-compose-integration.md#docker-compose-logs--f)
for real-time log streaming.

### `Connection`

```typescript
interface Connection {
  exec: ExecFn;
  streamExec: StreamExecFn;
  close: () => Promise<void>;
}
```

The full connection interface. Defined at `src/ssh/types.ts:19-23`.

## Methods

### `exec(command: string): Promise<ExecResult>`

Executes a shell command and returns the full buffered output after the command
completes.

**When to use**: Most Fleet operations use `exec` — running Docker commands,
reading files, writing state, querying APIs. This is the default choice.

**SSH backend** (`src/ssh/ssh.ts:31-38`): Delegates to `ssh.execCommand()`.
The command runs in the default shell on the remote server. The exit code
defaults to 0 when `node-ssh` returns null (which can happen when the SSH
channel closes without an explicit exit code).

**Local backend** (`src/ssh/local.ts:5-15`): Delegates to Node.js
`child_process.exec()`. The command runs in `/bin/sh` on Unix systems. On
error, the exit code comes from `error.code`, defaulting to 1 when null.

**Buffer limit (local only)**: Node.js `child_process.exec()` has a default
`maxBuffer` of 1 MB (1024 * 1024 bytes). If a command's stdout or stderr
exceeds this limit, the child process is terminated and output is truncated.
The SSH backend does not have this limitation.

### `streamExec(command: string, callbacks: StreamExecCallbacks): Promise<ExecResult>`

Executes a shell command with real-time output streaming via callbacks, while
also accumulating the full output for the return value.

**When to use**: For long-running commands where the user needs to see output
as it arrives. Currently, only `src/logs/logs.ts:49-56` uses `streamExec` to
stream Docker Compose logs to the terminal in real time.

**SSH backend** (`src/ssh/ssh.ts:40-57`): Delegates to `ssh.execCommand()`
with `onStdout` and `onStderr` options. The callbacks receive `Buffer` chunks
that are converted to strings before being passed to the caller's callbacks.
The full output is still accumulated and returned in the `ExecResult`.

**Local backend** (`src/ssh/local.ts:17-47`): Uses `child_process.spawn()`
with `{ shell: true }` to create a child process. Registers `data` event
handlers on `stdout` and `stderr` streams, invoking the callbacks on each
chunk. Accumulates the full output in memory and resolves the promise when the
child process closes.

**Note**: Both backends accumulate the full output regardless of whether
callbacks are provided. For very large outputs, this means memory usage grows
proportionally to the command's total output.

### `close(): Promise<void>`

Releases the connection's resources.

**SSH backend** (`src/ssh/ssh.ts:59-61`): Calls `ssh.dispose()` on the
`node-ssh` instance, which closes the underlying SSH2 connection and frees
the socket.

**Local backend** (`src/ssh/local.ts:49-51`): No-op. Local connections do not
hold persistent resources. Each `exec()` and `streamExec()` call spawns and
completes its own child process independently.

**Why is local `close()` a no-op?** Unlike SSH connections which maintain a
persistent TCP connection and session, local command execution via
`child_process.exec` and `child_process.spawn` creates a new process for each
invocation. When the command completes, the process exits and its resources
(file descriptors, memory) are automatically reclaimed by the OS. There is no
persistent resource to release.

## Behavioral Differences Between Backends

While both backends implement the same interface, there are behavioral
differences that could cause code to work locally but fail over SSH (or vice
versa):

| Aspect | SSH Backend | Local Backend |
|---|---|---|
| Shell | Remote server's default shell | `/bin/sh` (Unix) or `cmd.exe` (Windows) |
| Environment | Remote user's environment | Current process environment |
| Working directory | Remote user's home directory | Current working directory |
| Timeout | None configured | None configured (but `exec` supports a `timeout` option internally) |
| Max buffer | No limit (streams over SSH) | 1 MB default for `exec`; unlimited for `streamExec` |
| Error on non-zero exit | Returns the exit code (no throw) | Returns the exit code (no throw) |
| Resource cleanup | Must call `close()` to free socket | `close()` is a no-op |

### Shell injection risk

Both backends pass command strings directly to a shell for execution:

- **SSH**: `ssh.execCommand(command)` executes the command in the remote shell
- **Local `exec`**: `child_process.exec(command)` runs the command in `/bin/sh -c`
- **Local `streamExec`**: `spawn(command, { shell: true })` also uses a shell

Fleet constructs commands internally (not from user input), but any component
that builds command strings must take care to avoid injection — particularly
when interpolating values from `fleet.yml`, stack names, or service names into
shell commands.

## Factory Function

### `createConnection(config: ServerConfig): Promise<Connection>`

Creates and returns a `Connection` instance based on the server configuration.

**Source**: `src/ssh/factory.ts:6-11`

**Parameters**:
- `config` — A `ServerConfig` object with `host`, `port` (default 22), `user`
  (default "root"), and optional `identity_file`

**Returns**: A `Promise<Connection>` — for SSH connections, the promise resolves
only after the SSH handshake completes successfully.

**Localhost detection**: The factory checks for exact string matches against
`"localhost"` and `"127.0.0.1"`. Other loopback representations are **not**
detected:

| Address | Detected as local? |
|---|---|
| `localhost` | Yes |
| `127.0.0.1` | Yes |
| `::1` | No — triggers SSH connection to IPv6 loopback |
| `0.0.0.0` | No — triggers SSH connection attempt |
| `127.0.0.2` | No — triggers SSH connection attempt |
| A hostname resolving to `127.0.0.1` | No — triggers SSH connection attempt |

This is by design: Fleet's `fleet.yml` schema validates `host` as a plain
string, and the factory performs a simple string comparison. If you need local
execution, use `localhost` or `127.0.0.1` exactly.

## Related documentation

- [Overview](./overview.md) -- Architecture of the SSH connection layer
- [Authentication](./authentication.md) -- SSH authentication methods and
  troubleshooting
- [Connection Lifecycle](./connection-lifecycle.md) -- Resource management and
  cleanup patterns
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  `server` block field definitions used by `createConnection`
- [Stack Lifecycle Integrations](../stack-lifecycle/integrations.md) -- how SSH
  is used by lifecycle operations
- [Deploy Sequence](../deploy/deploy-sequence.md) -- how the deploy pipeline
  uses the connection interface
