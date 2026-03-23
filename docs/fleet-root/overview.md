# Fleet Root Directory Resolution

The `fleet-root` module determines and persists the base filesystem path that
Fleet uses on every target server. Every other module that creates directories,
uploads files, or writes configuration on the remote host builds its paths
relative to this root. It is the anchor point for the entire Fleet directory
layout.

## Why this module exists

Fleet deploys Docker Compose stacks to remote servers via SSH. Those stacks need
a predictable location on the server's filesystem for compose files, proxy
configuration, and environment secrets. Rather than requiring the user to
configure this path manually, Fleet resolves it automatically based on what the
SSH user is permitted to create.

The module answers a single question at bootstrap time: **where on this server
should Fleet store its files?** The answer is persisted so that subsequent
operations ([deploy](../deployment-pipeline.md),
[stop](../stack-lifecycle/stop.md),
[teardown](../stack-lifecycle/teardown.md),
[reload](../proxy-status-reload/route-reload.md)) can locate Fleet's data
without re-resolving.

## How it works

The module exports four public symbols:

| Symbol              | Type       | Purpose                                              |
|---------------------|------------|------------------------------------------------------|
| `resolveFleetRoot`  | Function   | Creates the root directory and persists the path      |
| `readFleetRoot`     | Function   | Reads a previously persisted root path (if any)       |
| `PROXY_DIR`         | Constant   | Subdirectory name for proxy configuration (`"proxy"`) |
| `STACKS_DIR`        | Constant   | Subdirectory name for stack deployments (`"stacks"`)  |

### Resolution strategy

`resolveFleetRoot` uses a two-tier fallback:

1. **Primary**: attempt to create `/opt/fleet` via `mkdir -p`.
2. **Fallback**: if the primary fails with a permission error, create `~/fleet`
   under the SSH user's home directory.

The resolved path is written to `~/.fleet-root` on the target server so it can
be read later without re-running the resolution logic.

See [Resolution Flow](./resolution-flow.md) for the full decision flowchart.

### State persistence (dual storage)

The resolved fleet root is stored in two locations on the target server:

1. **`~/.fleet-root`** - a single-line text file containing the absolute path.
   Written by `resolveFleetRoot` immediately after directory creation.
2. **`~/.fleet/state.json`** - the `fleet_root` field in the `FleetState` JSON
   object. Written by the bootstrap or deploy pipeline after resolution.

The `FleetState.fleet_root` field in state is the authoritative source during
normal operations. The `~/.fleet-root` file serves as a fallback that
`readFleetRoot` can consult if state is unavailable.

## Why `/opt/fleet` is the primary root

The choice of `/opt/fleet` follows the [Linux Filesystem Hierarchy Standard
(FHS 3.0)](https://refspecs.linuxfoundation.org/FHS_3.0/fhs/ch03s13.html),
which reserves `/opt` for add-on application software packages. Specifically:

- `/opt/<package>` is the designated location for self-contained software that
  is not part of the base OS distribution.
- Files under `/opt` are visible system-wide, making them accessible to all
  users and services on the host.
- System-level services and init systems conventionally look for software
  under `/opt`, which aligns with Fleet's role as infrastructure tooling.

**When `/opt/fleet` is unavailable**: many cloud providers and hosting platforms
run SSH sessions under non-root users (e.g., `ubuntu`, `deploy`, `ec2-user`)
that lack write access to `/opt`. In these environments, `mkdir -p /opt/fleet`
fails with "Permission denied" and Fleet falls back to `~/fleet`. This fallback
means Fleet works out of the box regardless of the SSH user's privilege level.

## Source files

| File                          | Purpose                                      |
|-------------------------------|----------------------------------------------|
| `src/fleet-root/constants.ts` | Exports `PROXY_DIR` and `STACKS_DIR`         |
| `src/fleet-root/index.ts`     | Barrel re-export of all public symbols        |
| `src/fleet-root/resolve.ts`   | Resolution logic and `~/.fleet-root` I/O      |

## Integration: SSH command execution (`ExecFn`)

The `fleet-root` module depends on a single external abstraction: `ExecFn` from
the [SSH connection layer](../ssh-connection/overview.md). Every filesystem
operation (directory creation, file writing, file reading) is executed as a shell
command through this function, which may run locally or over SSH depending on
the server configuration.

The `ExecFn` signature:

```
type ExecFn = (command: string) => Promise<ExecResult>
```

Where `ExecResult` contains `stdout`, `stderr`, and an integer `code`. The
resolution logic inspects `code` and `stderr` to detect permission errors and
determine whether to fall back.

### Testing without a remote server

Because `ExecFn` is a plain function type, it can be stubbed in tests. The SSH
module also provides a local implementation (via `child_process`) that is
selected automatically when `server.host` is `localhost` or `127.0.0.1`. See
[SSH Connection Overview](../ssh-connection/overview.md) for details.

## Cross-group dependencies

The fleet-root module is consumed by:

- **[Server Bootstrap](../bootstrap/server-bootstrap.md)**: calls
  `resolveFleetRoot` during first-time server initialization and stores the
  result in `FleetState.fleet_root`.
- **[Deployment Pipeline](../deployment-pipeline.md)**: imports `STACKS_DIR` to
  construct stack directories at `<fleet-root>/stacks/<stack-name>/`.
- **[Caddy Proxy Configuration](../caddy-proxy/overview.md)**: imports
  `PROXY_DIR` to construct the proxy compose file path at
  `<fleet-root>/proxy/compose.yml`.

The module itself depends only on:

- **[SSH Connection Layer](../ssh-connection/overview.md)**: for the `ExecFn`
  type used to execute shell commands on the target host.

## `readFleetRoot` and its current usage

The `readFleetRoot` function reads `~/.fleet-root` and returns the stored path,
or `null` if the file does not exist. It is exported from the barrel but
**currently has no external callers** in the codebase. It appears to be reserved
for future use cases such as:

- Status or diagnostic commands that need the fleet root without running a full
  deploy.
- Recovery flows that need to locate Fleet data when `state.json` is missing or
  corrupted.

The function does not validate that the returned path still exists on the
filesystem. See [Troubleshooting](./troubleshooting.md) for implications.

## Related documentation

- [Resolution Flow](./resolution-flow.md) -- full decision flowchart for path
  resolution
- [Directory Layout](./directory-layout.md) -- structure of the fleet root
  directory on the server
- [Troubleshooting](./troubleshooting.md) -- common issues with fleet root
  resolution
- [Bootstrap Sequence](../bootstrap/bootstrap-sequence.md) -- Step 1 calls
  `resolveFleetRoot()` during server initialization
- [Server Bootstrap](../bootstrap/server-bootstrap.md) -- high-level bootstrap
  overview
- [Deployment Pipeline](../deployment-pipeline.md) -- uses `STACKS_DIR` to
  construct stack directories
- [Caddy Proxy Architecture](../caddy-proxy/overview.md) -- uses `PROXY_DIR`
  for the proxy compose path
- [SSH Connection Layer](../ssh-connection/overview.md) -- provides the `ExecFn`
  abstraction used for filesystem operations
- [State Management Overview](../state-management/overview.md) -- stores the
  resolved `fleet_root` in `FleetState`
- [State Operations Guide](../state-management/operations-guide.md) -- recovery
  procedures when state or fleet root is corrupted
- [Deploy Integrations](../deploy/integrations.md) -- Docker, SSH, and other
  integrations that use the fleet root path
