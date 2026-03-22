# Troubleshooting: Proxy Status and Route Reload

## Common scenarios and solutions

### Caddy container is not running

**Symptom (status)**: Output shows `Proxy container: not found` or a status
other than `running`.

**Symptom (reload)**: Error message:
`Caddy container "fleet-proxy" is not running. Start the proxy first with 'fleet deploy'.`

**Cause**: The `fleet-proxy` container has not been created, was stopped, or
was removed.

**Solution**:

1. SSH into the server and check container state:

    ```sh
    docker ps -a --filter name=fleet-proxy
    ```

2. If the container exists but is stopped, it may have crashed. Check logs:

    ```sh
    docker logs fleet-proxy
    ```

3. Run `fleet deploy` to re-bootstrap the proxy. The bootstrap process creates
    the Docker network, writes the Compose file, starts Caddy, and posts the
    initial configuration. See the [Server Bootstrap](../bootstrap/bootstrap-sequence.md)
    documentation and [Bootstrap Troubleshooting](../bootstrap/bootstrap-troubleshooting.md)
    for common bootstrap failures.

### SSH connection failures

**Symptom**: `Proxy status failed: ...` or `Reload failed: ...` with an
SSH-related error (connection refused, authentication failed, timeout).

**Possible causes and solutions**:

| Cause | Solution |
|-------|----------|
| Wrong host/port in `fleet.yml` | Verify `server.host` and `server.port` |
| SSH key not found | Check `server.identity_file` path; it supports `~` expansion |
| SSH agent not running | If no `identity_file`, ensure `SSH_AUTH_SOCK` is set |
| Firewall blocking port 22 | Verify network connectivity to the server |
| Wrong username | Check `server.user` (defaults to `root`) |

Fleet uses the [`node-ssh`](https://github.com/steelbrain/node-ssh) library
(which wraps `ssh2`). Authentication methods are detailed in
[SSH Authentication](../ssh-connection/authentication.md):

- **Key file**: If `server.identity_file` is set in `fleet.yml`, the specified
    private key is used. Paths starting with `~` are expanded to the home
    directory.
- **SSH agent**: If no `identity_file` is configured, Fleet uses the SSH agent
    via the `SSH_AUTH_SOCK` environment variable.
- **Local mode**: If `server.host` is `localhost` or `127.0.0.1`, no SSH
    connection is made; commands run locally via child processes.

There is no built-in retry or timeout configuration for SSH connections. If the
connection fails, the command exits immediately with code 1.

### State file issues

**Symptom**: `Failed to parse state file: invalid JSON in ~/.fleet/state.json`
or `Invalid state file structure: ~/.fleet/state.json`.

**Where the state file lives**: `~/.fleet/state.json` on the remote server
(i.e., `/root/.fleet/state.json` when connecting as `root`).

**State file schema** (defined in `src/state/types.ts`):

```json
{
  "fleet_root": "/opt/fleet",
  "caddy_bootstrapped": true,
  "stacks": {
    "myapp": {
      "path": "/opt/fleet/stacks/myapp",
      "compose_file": "docker-compose.yml",
      "deployed_at": "2024-01-15T10:30:00Z",
      "routes": [
        {
          "host": "app.example.com",
          "service": "web",
          "port": 3000,
          "caddy_id": "myapp__web"
        }
      ],
      "env_hash": "abc123...",
      "services": {
        "web": {
          "image": "myapp:latest",
          "definition_hash": "def456...",
          "image_digest": "sha256:...",
          "env_hash": "abc123...",
          "deployed_at": "2024-01-15T10:30:00Z",
          "skipped_at": null,
          "one_shot": false,
          "status": "running"
        }
      }
    }
  }
}
```

**To inspect manually**:

```sh
ssh root@your-server cat ~/.fleet/state.json | jq
```

**To recover from corruption**: If the file is corrupted, you can delete it.
Fleet will treat a missing or empty state file as a default (empty) state with
`caddy_bootstrapped: false` and no stacks. You will need to re-deploy all
stacks afterward.

```sh
ssh root@your-server rm ~/.fleet/state.json
```

The state file uses atomic writes (write to `.tmp`, then `mv`) to reduce the
risk of corruption during write operations. See
[State Management Overview](../state-management/overview.md) for the full
read/write mechanics. However, there is no locking mechanism -- concurrent
operations could cause data loss.

### Ghost routes detected

**Symptom**: `fleet proxy status` shows:

```
Warning: Ghost routes (in Caddy but not in state.json):
  - old.example.com
```

**Cause**: A hostname is registered in Caddy's live configuration but has no
corresponding entry in any stack's routes in `state.json`.

**Common scenarios**:

- A `fleet teardown` removed the stack from state but failed to clean up the
    Caddy route.
- A route was manually added to Caddy via its Admin API.
- The state file was manually edited or replaced.

**Solution**: Ghost routes do not harm the system but indicate drift. To clean
them up:

1. If the route is still needed, re-deploy the stack that should own it.
2. If the route should be removed, delete it manually:

    ```sh
    ssh root@your-server \
      docker exec fleet-proxy curl -s -f -X DELETE \
      http://localhost:2019/id/stackname__servicename
    ```

### Missing routes detected

**Symptom**: `fleet proxy status` shows:

```
Warning: Missing routes (in state.json but not in Caddy):
  - staging.example.com

Run `fleet proxy reload` to reconcile.
```

**Cause**: A hostname is recorded in `state.json` but not present in the live
Caddy configuration. This means **traffic for that hostname is not being
proxied**.

**Solution**: Run `fleet proxy reload` to re-register all routes.

### Reload reports partial failures

**Symptom**: `fleet proxy reload` output:

```
Reload complete: 4/6 routes registered successfully.

Failed routes:
  - staging.example.com (stack: myapp): <error details>
  - dev.example.com (stack: devstack): <error details>
```

**Cause**: The Caddy Admin API rejected the route addition. Common reasons:

| Error | Cause | Solution |
|-------|-------|----------|
| Connection refused in curl | Caddy process crashed mid-reload | Restart Caddy: `docker restart fleet-proxy`, then reload again |
| Invalid JSON | Malformed route data in state | Inspect and fix `state.json` |
| Upstream unreachable | Container for the service is not running | Deploy the stack first |

After fixing the underlying cause, run `fleet proxy reload` again. Since the
loop is idempotent (delete + re-add), previously succeeded routes will simply
be refreshed.

## Directly querying the Caddy Admin API

For debugging outside of Fleet, you can query Caddy directly from the server:

```sh
# View full Caddy configuration
ssh root@your-server \
  docker exec fleet-proxy curl -s http://localhost:2019/config/ | jq

# List all routes
ssh root@your-server \
  docker exec fleet-proxy curl -s \
  http://localhost:2019/config/apps/http/servers/fleet/routes | jq

# View a specific route by ID
ssh root@your-server \
  docker exec fleet-proxy curl -s \
  http://localhost:2019/id/myapp__web | jq

# Delete a specific route
ssh root@your-server \
  docker exec fleet-proxy curl -s -f -X DELETE \
  http://localhost:2019/id/myapp__web

# View Caddy access/error logs
ssh root@your-server docker logs fleet-proxy
ssh root@your-server docker logs fleet-proxy --tail 100 --follow
```

### Caddy Admin API endpoints used by Fleet

| Endpoint | Method | Purpose | Used by |
|----------|--------|---------|---------|
| `/config/` | GET | Retrieve full configuration (including version) | `fleet proxy status` |
| `/config/apps/http/servers/fleet/routes` | GET | List all routes in the Fleet server | `fleet proxy status` |
| `/config/apps/http/servers/fleet/routes` | POST | Append a new route | `fleet proxy reload`, deploy |
| `/id/{caddy_id}` | DELETE | Remove a specific route by its `@id` | `fleet proxy reload`, teardown |
| `/load` | POST | Replace the entire Caddy configuration | Bootstrap only |

The Admin API **default address is `localhost:2019`** inside the container. It
is a REST API that uses JSON for both requests and responses. Configuration
changes via the API are lightweight, efficient, and incur zero downtime --
Caddy automatically handles reloading without dropping connections.

### Caddy route persistence

Caddy stores its configuration **in memory** by default. The `fleet-proxy`
container is started with `caddy run --resume`, which tells Caddy to reload
the last saved configuration on startup. Caddy auto-saves its configuration to
disk after every API change.

However, if the Caddy data volume (`caddy_config`) is lost or corrupted, the
configuration will not survive a restart. In that case, `fleet proxy reload`
will re-register all routes from `state.json`.

### Required Docker version

Fleet uses `docker inspect` and `docker exec`, which are available in all
modern Docker Engine versions (17.03+). Docker Compose V2 (`docker compose`
syntax, not `docker-compose`) is used for managing the proxy stack. Ensure
Docker Engine and the Compose plugin are installed on the remote server. See the
[Server Bootstrap](../bootstrap/bootstrap-sequence.md) documentation for provisioning details
and [Proxy Docker Compose Configuration](../caddy-proxy/proxy-compose.md) for
the generated compose file.

## Related documentation

- [Overview: Proxy Status and Route Reload](./overview.md)
- [Proxy Status Command](./proxy-status.md)
- [Route Reload Command](./route-reload.md)
- [Caddy Reverse Proxy Configuration](../caddy-proxy/overview.md) -- Caddy
    architecture and design decisions
- [Caddy Admin API](../caddy-proxy/caddy-admin-api.md) -- detailed Admin API
    reference used by status and reload
- [Caddy Proxy Troubleshooting](../caddy-proxy/troubleshooting.md) -- Caddy
    container-specific troubleshooting
- [Proxy Docker Compose](../caddy-proxy/proxy-compose.md) -- the generated
    proxy compose file
- [TLS and ACME](../caddy-proxy/tls-and-acme.md) -- certificate management
    and ACME configuration
- [Server State Management](../state-management/overview.md) -- State file
    read/write operations
- [State Operations Guide](../state-management/operations-guide.md) -- how
    to inspect and recover state
- [Server Bootstrap](../bootstrap/bootstrap-sequence.md) -- Initial proxy
    container setup
- [Bootstrap Troubleshooting](../bootstrap/bootstrap-troubleshooting.md) --
    Bootstrap failure modes and recovery
- [Deployment Troubleshooting](../deploy/troubleshooting.md) -- Deploy-specific
    troubleshooting including ghost routes and missing routes
- [SSH Connection Overview](../ssh-connection/overview.md) -- SSH connection
    layer details
- [Configuration Overview](../configuration/overview.md) -- `fleet.yml`
    `server` section used for SSH connections
