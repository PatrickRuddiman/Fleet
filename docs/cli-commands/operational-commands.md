# Operational CLI Commands

Fleet provides five operational commands for day-to-day management of deployed
stacks: `logs`, `ps`, `restart`, `stop`, and `teardown`. These commands let
operators inspect, restart, stop, and destroy stacks without rerunning a full
deployment.

## Why these commands exist

After `fleet deploy` places a stack on the remote server, operators need runtime
controls to manage that stack. These commands fill the gap between deployment and
the next deployment cycle, providing visibility into running services and the
ability to stop or destroy stacks when they are no longer needed.

## How they work

Every operational command follows the same execution pattern:

1. Load `fleet.yml` from the current working directory
2. Open an SSH connection to the remote server
3. Read the Fleet state file (`~/.fleet/state.json`) on the server
4. Validate the target stack exists in state
5. Execute Docker Compose and/or Caddy admin API commands over SSH
6. (For destructive operations) Update the persisted state file

The command files under `src/commands/` are thin registration shells that use
Commander.js to declare arguments and options, validate input, and delegate to
the corresponding implementation module. See
[Command Registration Architecture](../cli-entry-point/) for how these
integrate with the main CLI entry point.

## Prerequisites

All operational commands require:

- A valid `fleet.yml` in the current working directory (see
  [Configuration Schema](../configuration/schema-reference.md))
- SSH connectivity to the server defined in `fleet.yml` (see
  [SSH Authentication](../ssh-connection/authentication.md))
- Docker Compose V2 (`docker compose`, not `docker-compose`) installed on the
  remote server
- A previously deployed stack (via `fleet deploy`)

## Command reference

### `fleet logs`

Stream live container logs from a deployed stack.

```
fleet logs <stack> [service] [-n, --tail <lines>]
```

| Argument/Option | Required | Description |
|-----------------|----------|-------------|
| `stack` | Yes | Name of the deployed stack |
| `service` | No | Specific service to show logs for |
| `-n, --tail <lines>` | No | Number of historical lines to show |

**Implementation**: `src/logs/logs.ts` -- see also
[Process and Service Status](../process-status/overview.md) for architecture
details.

**How it works**: Runs `docker compose -p <stack> logs -f` over SSH with
streaming output piped directly to your terminal's stdout/stderr. The command
registers a `SIGINT` handler (Ctrl+C) that gracefully closes the SSH connection,
so you can safely interrupt the log stream at any time. The handler is cleaned
up in a `finally` block to prevent listener leaks.

**Example**:

```bash
# Stream all logs for stack "myapp"
fleet logs myapp

# Stream logs for only the "web" service, last 100 lines
fleet logs myapp web --tail 100
```

### `fleet ps`

List running services and their status across all deployed stacks or for a
specific stack.

```
fleet ps [stack]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `stack` | No | Filter to a specific stack |

**Implementation**: `src/ps/ps.ts`

**How it works**: Queries live container status by running
`docker compose -p <stack> ps --format json` over SSH for each stack. This is a
live query -- it does not read cached state for container status. State is only
used for route mappings and deployment timestamps. The output is formatted as an
aligned table with columns: STACK, SERVICE, STATUS, ROUTES, DEPLOYED AT.

For a detailed explanation of how `ps` assembles data from multiple sources,
see [Process Status Data Assembly](./ps-data-assembly.md) and the
[Ps Command](../process-status/ps-command.md) reference.

**Example output**:

```
STACK    SERVICE  STATUS   ROUTES                         DEPLOYED AT
myapp    api      running  api.example.com -> api:3000    2 hours ago
         web      running  example.com -> web:8080        2 hours ago
```

### `fleet restart`

Restart a specific service within a deployed stack.

```
fleet restart <stack> <service>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `stack` | Yes | Name of the deployed stack |
| `service` | Yes | Name of the service to restart |

**Implementation**: `src/restart/restart.ts`

**How it works**: Runs `docker compose -p <stack> restart <service>` over SSH.
This restarts the container in-place without changing its network identity or
IP address, so existing Caddy reverse proxy routes remain valid. Unlike `stop`
and `teardown`, `restart` does not touch Caddy routes or modify the Fleet state
file.

**When to use**: Use `restart` when a service is misbehaving but its
configuration has not changed. For configuration changes, use `fleet deploy`
instead.

### `fleet stop`

Stop all containers in a deployed stack and remove its Caddy routes.

```
fleet stop <stack>
```

| Argument | Required | Description |
|----------|----------|-------------|
| `stack` | Yes | Name of the deployed stack |

**Implementation**: `src/stop/stop.ts`

**How it works**: Executes a multi-step sequence:

1. Remove Caddy routes one by one via the Caddy admin API
2. Run `docker compose -p <stack> stop` to halt containers
3. Remove the stack from Fleet state and persist the updated state

Stopped containers are preserved on disk (images, networks, and volumes remain).
The stack is removed from Fleet state, so `fleet ps` will no longer show it.
To resume the stack, you must run `fleet deploy` again.

For a detailed comparison with `teardown`, see
[Stop vs Teardown Lifecycle](./stop-vs-teardown.md) and
[Stop Operation](../stack-lifecycle/stop.md).

### `fleet teardown`

Destroy a deployed stack, removing containers, networks, and optionally volumes.

```
fleet teardown <stack> [--volumes]
```

| Argument/Option | Required | Description |
|-----------------|----------|-------------|
| `stack` | Yes | Name of the deployed stack |
| `--volumes` | No | Also remove persistent Docker volumes |

**Implementation**: `src/teardown/teardown.ts`

**How it works**: Executes a multi-step sequence:

1. Remove Caddy routes one by one via the Caddy admin API
2. Run `docker compose -p <stack> down` (or `down --volumes`) to remove
   containers and networks
3. Remove the stack from Fleet state and persist the updated state

Without `--volumes`, named volumes are preserved, allowing data recovery.
With `--volumes`, all persistent data is irreversibly deleted.

For a detailed comparison with `stop`, see
[Stop vs Teardown Lifecycle](./stop-vs-teardown.md) and
[Teardown Operation](../stack-lifecycle/teardown.md).

## Docker Compose project naming

All commands use the stack name directly as the Docker Compose project name
via the `-p` flag. This must match the project name used during `fleet deploy`.
The stack name is validated against the pattern `^[a-z\d][a-z\d-]*$`
(defined in `src/config/schema.ts:46`), which aligns with Docker Compose's
project naming requirements.

## `fleet.yml` location

All five commands resolve the configuration file using `path.resolve("fleet.yml")`,
which resolves relative to `process.cwd()`. You must run Fleet commands from the
directory containing your `fleet.yml` file. See
[Configuration Schema](../configuration/schema-reference.md) for the full `fleet.yml` reference.

## Related documentation

- [Stop vs Teardown Lifecycle](./stop-vs-teardown.md) -- detailed comparison
  of stop and teardown behavior
- [Process Status Data Assembly](./ps-data-assembly.md) -- how `fleet ps`
  merges data from multiple sources
- [Failure Modes and Troubleshooting](./failure-modes.md) -- what happens when
  operations fail mid-execution
- [CLI Entry Point and Command Registration](../cli-entry-point/) -- how
  commands are registered with Commander.js
- [Stack Lifecycle Operations](../stack-lifecycle/) -- implementation details
  of stop, restart, and teardown
- [Process and Service Status](../process-status/) -- implementation details
  of logs and ps
- [Server State Management](../state-management/) -- how `~/.fleet/state.json`
  works
- [SSH Connection Layer](../ssh-connection/) -- how remote execution works
- [Deployment Pipeline](../deployment-pipeline.md) -- the main `fleet deploy`
  orchestration that these commands complement
- [Caddy Reverse Proxy Configuration](../caddy-proxy/) -- how routes are
  managed
