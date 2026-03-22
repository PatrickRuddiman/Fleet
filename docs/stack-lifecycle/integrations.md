# Integrations Reference

The three lifecycle operations (restart, stop, teardown) interact with five
external systems. This document explains how each integration works, how to
inspect its state, and how to troubleshoot problems. It is designed as an
operational companion to the [individual operation guides](./overview.md).

## Docker Compose

### How Fleet uses Docker Compose

Fleet shells out to the `docker compose` CLI on the remote server. It does not
use the Docker API directly. See
[Docker Compose Integration](../process-status/docker-compose-integration.md)
for version requirements and JSON output format details. The three lifecycle
operations use three different Docker Compose commands:

| Operation | Command |
|-----------|---------|
| Restart | `docker compose -p <stack> restart <service>` |
| Stop | `docker compose -p <stack> stop` |
| Teardown | `docker compose -p <stack> down` |
| Teardown (with volumes) | `docker compose -p <stack> down --volumes` |

The `-p` flag sets the Compose **project name**, which is the Fleet stack name.
This is how Docker Compose identifies which containers belong to which stack.

### Key limitation: restart does not reload configuration

`docker compose restart` sends SIGTERM then SIGSTART to the container process.
It does **not** re-read the Compose file, rebuild images, or pick up
environment variable changes. If you have modified `docker-compose.yml` or
any `.env` files, you must run `fleet deploy` instead of `fleet restart` for
the changes to take effect.

This is a Docker Compose behavior, not a Fleet limitation. See the
[Docker Compose restart reference](https://docs.docker.com/reference/cli/docker/compose/restart/)
for details.

### How to inspect Docker Compose state

SSH into the server and use standard Docker Compose commands:

```sh
# List all running containers for a stack
docker compose -p <stackName> ps

# View logs for a specific service
docker compose -p <stackName> logs <service>

# List all Compose projects on the server
docker compose ls

# Inspect a specific container
docker inspect <containerName>
```

### How to verify an operation completed

After a **stop**, containers should show status `Exited`:

```sh
docker compose -p <stackName> ps -a
```

After a **teardown**, the project should not appear at all:

```sh
docker compose ls --filter name=<stackName>
```

After a **teardown --volumes**, named volumes should also be gone:

```sh
docker volume ls --filter label=com.docker.compose.project=<stackName>
```

### Recovery: containers in unexpected state

If containers are running but Fleet state says the stack does not exist (e.g.
after a failed state write), you have two options:

1. **Redeploy:** Run `fleet deploy` to re-register the stack in state. This is
   the cleanest option.
2. **Manual cleanup:** Remove the containers directly:

    ```sh
    docker compose -p <stackName> down
    ```

## Caddy Reverse Proxy

### How Fleet manages Caddy routes

Fleet runs a Caddy instance inside a Docker container named **`fleet-proxy`**
(hardcoded in `src/caddy/constants.ts:1`). Route management is done entirely
through Caddy's admin API (see
[Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md) for the complete
endpoint documentation), which listens on `localhost:2019` inside the
container. The admin API is **not exposed to the host network** -- all access
goes through `docker exec`.

Each route is identified by a **route ID** that follows the format:

```
<stackName>__<serviceName>
```

The double underscore (`__`) is the separator. For example, a stack named
`myapp` with a service named `web` produces the route ID `myapp__web`.

### Route lifecycle during operations

- **Restart:** Routes are not touched. The service is restarted in place and
  Caddy continues proxying to the same container IP/port.
- **Stop / Teardown:** Routes are removed sequentially before containers are
  stopped or removed. Each route is removed with a DELETE request to
  `/id/<routeId>` on the Caddy admin API.

### How to inspect Caddy routes

All commands must be run via `docker exec` because the admin API is only
accessible inside the container:

```sh
# List all routes with their IDs
docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq

# List just route IDs
docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq '.[].["@id"]'

# Get a specific route by ID
docker exec fleet-proxy curl -s http://localhost:2019/id/<stackName>__<serviceName>

# Get the full Caddy configuration
docker exec fleet-proxy curl -s http://localhost:2019/config/
```

### How to manually remove a route

```sh
docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/<stackName>__<serviceName>
```

A successful deletion returns an empty response. A 404 means the route does not
exist (already removed or never created).

### How to manually add a route back

If you need to restore a route that was removed (e.g. after a partial failure),
you can POST a route object:

```sh
docker exec -i fleet-proxy sh -c 'curl -s -f -X POST -H "Content-Type: application/json" -d @- http://localhost:2019/config/apps/http/servers/fleet/routes' << 'EOF'
{
  "@id": "<stackName>__<serviceName>",
  "match": [{"host": ["example.com"]}],
  "handle": [{
    "handler": "reverse_proxy",
    "upstreams": [{"dial": "<containerHost>:<port>"}]
  }]
}
EOF
```

You will need to know the correct upstream host and port, which can be found in
the Fleet state file or by inspecting the running container's network.

### Troubleshooting: fleet-proxy container

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| `docker exec fleet-proxy` fails with "no such container" | Container was never created or was removed | Run `fleet deploy` to bootstrap the proxy |
| `docker exec fleet-proxy` fails with "is not running" | Container exists but is stopped | `docker start fleet-proxy` |
| Curl to admin API times out | Caddy process inside container has crashed | Check container logs: `docker logs fleet-proxy` |
| Route removal returns 404 | Route was already removed or never existed | Safe to ignore; proceed with next steps |

### Admin API endpoints used by Fleet

| Endpoint | Method | Purpose | Source |
|----------|--------|---------|--------|
| `/load` | POST | Bootstrap Caddy config | `src/caddy/constants.ts:5` |
| `/config/apps/http/servers/fleet/routes` | POST | Add a route | `src/caddy/constants.ts:3` |
| `/config/apps/http/servers/fleet/routes` | GET | List all routes | `src/caddy/constants.ts:3` |
| `/id/<routeId>` | DELETE | Remove a route by ID | `src/caddy/constants.ts:6` |
| `/config/` | GET | Get full config | `src/caddy/constants.ts:4` |

## SSH / node-ssh

### How Fleet connects to servers

Fleet uses the `node-ssh` library to execute commands on the remote server.
For the complete connection interface documentation, see
[Connection API Reference](../ssh-connection/connection-api.md).
The connection is configured through the `server` section of `fleet.yml`:

```yaml
server:
  host: "192.168.1.100"
  port: 22              # default: 22
  user: "root"          # default: "root"
  identity_file: "~/.ssh/id_ed25519"  # optional
```

### Authentication methods

Fleet supports two authentication methods, checked in order:

1. **Private key file** (`identity_file`) -- if the `identity_file` field is
   set in `fleet.yml`, Fleet uses it as the path to a private SSH key. Tilde
   (`~`) is expanded to the local user's home directory
   (`src/ssh/ssh.ts:7-11`).

2. **SSH agent** -- if `identity_file` is not set, Fleet falls back to the
   `SSH_AUTH_SOCK` environment variable, which should point to a running SSH
   agent. This is the standard mechanism used by `ssh-agent` and tools like
   1Password SSH agent or GPG agent.

**Password authentication is not supported.** There is no `password` field in
the config schema and no password-based auth logic in the SSH module.

### Localhost bypass

If `server.host` is `localhost` or `127.0.0.1`, Fleet skips SSH entirely and
uses a local execution path (`src/ssh/factory.ts:7-9`). This is useful for
testing or when Fleet is running directly on the target server.

### How to verify SSH connectivity

Before running Fleet commands, you can test the connection manually:

```sh
# Using key file
ssh -i ~/.ssh/id_ed25519 -p 22 root@192.168.1.100 "echo connected"

# Using SSH agent
SSH_AUTH_SOCK=/path/to/agent.sock ssh -p 22 root@192.168.1.100 "echo connected"
```

### Troubleshooting SSH

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| `ECONNREFUSED` | Server not accepting SSH on configured port | Verify `sshd` is running and the port is correct |
| `ETIMEDOUT` | Network issue or firewall | Check network path, firewall rules |
| `Authentication failed` | Key not accepted by server | Verify the key is in `~/.ssh/authorized_keys` on the server |
| `Cannot parse privateKey` | Key file is encrypted or in unsupported format | Use `ssh-keygen -p` to convert, or use SSH agent instead |
| Connection hangs | SSH agent not running (no `identity_file`, no `SSH_AUTH_SOCK`) | Set `identity_file` in config or start an SSH agent |

### Credential rotation

To rotate SSH credentials:

1. Generate a new key pair on the local machine.
2. Add the new public key to `~/.ssh/authorized_keys` on the remote server.
3. Update `identity_file` in `fleet.yml` to point to the new private key.
4. Test connectivity manually before running Fleet commands.
5. Remove the old public key from the server.

## Fleet State

### Where state lives

Fleet state is stored at `~/.fleet/state.json` on the **remote server** (not
the local machine). It is read and written over SSH using the same `exec`
function used for all other remote commands.

### State file structure

The state file follows this structure (validated by Zod schemas in
`src/state/state.ts`):

```json
{
  "fleet_root": "/path/to/fleet/directory",
  "caddy_bootstrapped": true,
  "stacks": {
    "myapp": {
      "path": "/path/to/stack",
      "compose_file": "docker-compose.yml",
      "deployed_at": "2025-01-15T10:30:00.000Z",
      "env_hash": "abc123",
      "routes": [
        {
          "host": "myapp.example.com",
          "service": "web",
          "port": 3000,
          "caddy_id": "myapp__web"
        }
      ],
      "services": {
        "web": {
          "definition_hash": "def456",
          "deployed_at": "2025-01-15T10:30:00.000Z",
          "status": "deployed",
          "image": "myapp:latest",
          "image_digest": "sha256:...",
          "env_hash": "abc123",
          "skipped_at": null,
          "one_shot": false
        }
      }
    }
  }
}
```

### How lifecycle operations affect state

| Operation | State change |
|-----------|-------------|
| Restart | No change -- state is not read for modification, only for stack existence validation |
| Stop | Stack entry is removed from `stacks` object |
| Teardown | Stack entry is removed from `stacks` object |

State removal uses an immutable pattern: the `removeStack()` function
(`src/state/state.ts:100-105`) creates a new `FleetState` object using the
spread operator, excluding the target stack. The original state object is not
mutated.

### Atomic write pattern

The `writeState()` function (`src/state/state.ts:74-91`) uses a
write-to-tmp-then-rename pattern to prevent corruption. For the complete state
lifecycle across all operations, see
[State Lifecycle](../state-management/state-lifecycle.md).

1. Serialize state to JSON with 2-space indentation.
2. Write to `~/.fleet/state.json.tmp`.
3. Atomically rename `state.json.tmp` to `state.json` using `mv`.

If the process is interrupted during step 2, the original `state.json` is
untouched. The `mv` in step 3 is atomic on POSIX filesystems.

### How to inspect state

```sh
# View the full state
ssh user@server "cat ~/.fleet/state.json" | jq

# List all stack names
ssh user@server "cat ~/.fleet/state.json" | jq '.stacks | keys'

# View a specific stack
ssh user@server "cat ~/.fleet/state.json" | jq '.stacks["<stackName>"]'

# List all route IDs across all stacks
ssh user@server "cat ~/.fleet/state.json" | jq '[.stacks[].routes[].caddy_id]'
```

### How to manually edit state

If you need to manually remove a stack from state (e.g. after a partial
failure):

```sh
ssh user@server 'cat ~/.fleet/state.json | jq "del(.stacks[\"<stackName>\"])" > ~/.fleet/state.json.tmp && mv ~/.fleet/state.json.tmp ~/.fleet/state.json'
```

This preserves the atomic write pattern by using a tmp file and `mv`.

### Missing or empty state file

If `~/.fleet/state.json` does not exist or is empty, `readState()` returns a
default state:

```json
{
  "fleet_root": "",
  "caddy_bootstrapped": false,
  "stacks": {}
}
```

This means any lifecycle operation will fail at the "validate stack exists"
step with "Stack not found", which is the correct behavior -- if there is no
state, there are no stacks to operate on.

## Fleet Config (fleet.yml)

### Role in lifecycle operations

All three lifecycle operations begin by loading `fleet.yml` from the current
working directory (`path.resolve("fleet.yml")`). The config is used exclusively
for the SSH connection parameters -- the stack name passed as a CLI argument
is validated against the remote state, not against the local config file.

### Required fields for lifecycle operations

Lifecycle operations only need the `server` section of the config to establish
an SSH connection. However, because `fleet.yml` is parsed as a whole, all
required fields must be present:

```yaml
version: "1"                    # required, must be "1"
server:
  host: "192.168.1.100"         # required
  port: 22                      # optional, default: 22
  user: "root"                  # optional, default: "root"
  identity_file: "~/.ssh/key"   # optional, falls back to SSH agent
stack:
  name: "myapp"                 # required, must match /^[a-z\d][a-z\d-]*$/
  compose_file: "docker-compose.yml"  # optional, default: "docker-compose.yml"
routes:                         # required, min 1 entry
  - domain: "myapp.example.com"
    port: 3000
```

### Config file location

The config file is always loaded from the **current working directory**. There
is no `--config` flag to specify a different path. If you are running Fleet
from a directory that does not contain `fleet.yml`, the operation will fail at
step 1.

### Stack name validation

Stack names must match the regex `/^[a-z\d][a-z\d-]*$/`
(`src/config/schema.ts:46`):

- Must start with a lowercase letter or digit.
- Can contain lowercase letters, digits, and hyphens.
- No uppercase, underscores, dots, or special characters.

This constraint ensures stack names are valid Docker Compose project names and
can be safely used in Caddy route IDs.

### Relationship between config and state

The config file defines the **intended** state of a stack. The remote state
file records the **actual** state. Lifecycle operations use the config only for
connectivity -- the stack identity is passed via CLI argument and validated
against remote state, not local config. This means you can run `fleet stop
myapp` from any directory containing a `fleet.yml` that points to the correct
server, even if the local config defines a different stack name.

## Related documentation

- [Failure Modes and Recovery](./failure-modes.md) -- what happens when
  integrations fail during lifecycle operations
- [Teardown Operation](./teardown.md) -- detailed teardown flow and volume
  deletion behavior
- [Stack Lifecycle Overview](./overview.md) -- the three operations and their
  severity gradient
- [Operational CLI Commands](../cli-commands/operational-commands.md) -- full
  CLI reference
- [Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md) -- complete
  Caddy API endpoint documentation
- [Caddy Reverse Proxy Configuration](../caddy-proxy/) -- detailed Caddy proxy
  documentation
- [Caddy Proxy Troubleshooting](../caddy-proxy/troubleshooting.md) -- debugging
  Caddy issues during lifecycle operations
- [Server State Management](../state-management/) -- dedicated state management
  documentation
- [State Lifecycle](../state-management/state-lifecycle.md) -- state flow across
  stop, teardown, and restart
- [SSH Connection Layer](../ssh-connection/) -- dedicated SSH documentation
- [SSH Connection API](../ssh-connection/connection-api.md) -- `ExecFn` interface
  reference
- [Configuration Schema](../configuration/) -- full `fleet.yml` reference
