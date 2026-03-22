# Bootstrap Integrations and Operations

The bootstrap module depends on several external systems and internal
abstractions. This page documents each integration, explains how it is used
during bootstrap, and answers the operational questions that arise from the
source code.

## Docker Engine

**Type:** Container runtime / infrastructure
**Used in:** `src/bootstrap/bootstrap.ts:43` (network create), `:58-59`
(compose up), `:73` (docker exec)

### How Docker is used

Bootstrap interacts with Docker Engine in three ways:

1. **Network creation** -- `docker network create fleet-proxy` creates a bridge
   network that all Fleet containers share.
2. **Container orchestration** -- `docker compose up -d` starts the Caddy proxy
   container.
3. **In-container execution** -- `docker exec fleet-proxy curl ...` runs health
   probes and config posts inside the running Caddy container.

### Docker Engine version requirements

The code uses `docker compose` (Compose V2, the plugin form) rather than
`docker-compose` (the standalone V1 binary). Docker Engine 20.10+ ships with
Compose V2 as a CLI plugin. Older installations that only have the standalone
`docker-compose` binary will fail. See the
[Docker Compose Integration](../process-status/docker-compose-integration.md)
page for version requirements and JSON output format details.

**Minimum requirement:** Docker Engine 20.10 or later with the `compose` CLI
plugin installed.

### Inspecting the fleet-proxy network

To see which containers are connected to the shared network:

```bash
docker network inspect fleet-proxy
```

The output includes a `Containers` object listing each connected container, its
IP address, and MAC address. During normal operation you should see `fleet-proxy`
(the Caddy container) plus one container per deployed service.

### Troubleshooting Docker connectivity

If bootstrap fails at the Docker commands, check:

1. **Docker daemon is running:** `systemctl status docker` (or
   `docker info` via SSH).
2. **User has Docker permissions:** The SSH user must be in the `docker`
   group or run as root. Check with `groups` on the remote server.
3. **Docker socket is accessible:** The default socket path is
   `/var/run/docker.sock`. Verify with `ls -la /var/run/docker.sock`.

## Docker Compose

**Type:** Container orchestration
**Used in:** `src/bootstrap/bootstrap.ts:57-65`, `src/proxy/compose.ts:7-31`

### Generated compose file

The compose file is written to `{fleetRoot}/proxy/compose.yml` on the target
server. On a typical server, this is `/opt/fleet/proxy/compose.yml` or
`~/fleet/proxy/compose.yml`.

The generated content (from `src/proxy/compose.ts:7-31`):

```yaml
services:
  fleet-proxy:
    image: caddy:2-alpine
    container_name: fleet-proxy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    networks:
      - fleet-proxy
    volumes:
      - caddy_data:/data
      - caddy_config:/config
    command: caddy run --resume

networks:
  fleet-proxy:
    external: true

volumes:
  caddy_data:
  caddy_config:
```

### Managing the proxy stack manually

To bring down the proxy stack:

```bash
docker compose -f /opt/fleet/proxy/compose.yml -p fleet-proxy down
```

To restart it:

```bash
docker compose -f /opt/fleet/proxy/compose.yml -p fleet-proxy restart
```

To view logs:

```bash
docker compose -f /opt/fleet/proxy/compose.yml -p fleet-proxy logs -f
```

### Docker image versioning

The proxy uses `caddy:2-alpine`, which is a **floating tag** -- it resolves to
the latest Caddy 2.x release on the Alpine Linux base. This means:

- **Automatic updates:** Running `docker compose pull` followed by
  `docker compose up -d` will update to the latest 2.x patch.
- **No pinning:** The image is not pinned to a specific digest. A
  `docker compose pull` at different times may yield different Caddy versions.
- **Recommendation:** For production stability, consider pinning to a specific
  version (e.g., `caddy:2.8-alpine`) by editing the compose file on the server.

## Caddy Web Server

**Type:** Reverse proxy / TLS termination
**Used in:** `src/bootstrap/bootstrap.ts:73-78` (health check),
`:92-99` (config post), `src/caddy/commands.ts`, `src/caddy/constants.ts`

### What Caddy does in Fleet

Caddy serves as the single entry point for all HTTP/HTTPS traffic on the server.
It:

- Listens on ports 80 and 443
- Terminates TLS using automatically-provisioned certificates
- Routes requests to backend containers by hostname matching
- Persists its configuration across restarts via `caddy run --resume`

### The `caddy run --resume` command

The container command `caddy run --resume` has specific meaning:

- **`caddy run`** starts Caddy in the foreground (required for Docker containers)
- **`--resume`** loads the last auto-saved configuration instead of starting
  with a blank config

This is critical because Caddy auto-saves configuration changes made via the
Admin API to disk. On container restart (e.g., after a server reboot),
`--resume` restores all previously-configured routes without requiring
Fleet to re-deploy. The configuration is saved to the `caddy_config` Docker
volume mounted at `/config` inside the container.

Without `--resume`, a container restart would lose all routes and require a
full re-bootstrap.

### Caddy Admin API

The Admin API is the primary interface Fleet uses to configure Caddy. It listens
on `http://localhost:2019` inside the container (not exposed to the host network).
For the complete endpoint reference and command builders, see the
[Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md).

**Key endpoints used by Fleet:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/config/` | GET | Health check -- confirms API is responsive |
| `/load` | POST | Replaces the entire active configuration |
| `/config/apps/http/servers/fleet/routes` | POST | Appends a new route |
| `/id/{caddy_id}` | DELETE | Removes a route by its `@id` |

**How to access the Admin API manually:**

```bash
# View current configuration
docker exec fleet-proxy curl -s http://localhost:2019/config/ | jq

# View configured routes
docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq

# View all upstreams
docker exec fleet-proxy curl -s http://localhost:2019/reverse_proxy/upstreams | jq
```

The Admin API provides ACID guarantees for individual requests. For concurrent
modifications, Caddy supports optimistic concurrency control via `Etag` and
`If-Match` headers. Fleet does not currently use this mechanism, relying instead
on the sequential nature of the deploy pipeline.

### TLS certificates and data storage

Caddy stores TLS certificates and ACME account data in the `caddy_data` Docker
volume, mounted at `/data` inside the container. This volume persists across
container restarts and image upgrades. For detailed TLS and certificate
lifecycle information, see [TLS and ACME](../caddy-proxy/tls-and-acme.md).

**Viewing certificate status:**

```bash
# List certificates (requires Caddy 2.7+)
docker exec fleet-proxy caddy list-certificates

# View TLS-related config
docker exec fleet-proxy curl -s http://localhost:2019/config/apps/tls | jq
```

**Volume location on host:**

```bash
docker volume inspect caddy_data
```

## ACME / Let's Encrypt

**Type:** Certificate authority / TLS automation
**Used in:** `src/bootstrap/types.ts:2`, `src/caddy/commands.ts:29-44`

### How ACME email affects TLS

The `acme_email` option in `BootstrapOptions` controls whether Fleet configures
a specific ACME issuer in Caddy's TLS automation policy.

**When `acme_email` is provided:**

Caddy's initial configuration includes a TLS automation policy that explicitly
registers with the ACME CA (Let's Encrypt by default) using the provided email.
This email receives:

- Expiration warnings (30, 14, and 7 days before expiry)
- Revocation notices
- Policy change notifications from Let's Encrypt

The generated configuration adds:

```json
{
  "apps": {
    "tls": {
      "automation": {
        "policies": [{
          "issuers": [{
            "module": "acme",
            "email": "user@example.com"
          }]
        }]
      }
    }
  }
}
```

**When `acme_email` is not provided:**

No TLS automation policy is set in the bootstrap configuration. Caddy will
still obtain certificates automatically -- this is Caddy's default behavior for
any hostname with public DNS. However:

- Caddy will use its default issuers (Let's Encrypt and ZeroSSL as fallback)
- No email will be registered with the ACME CA
- No expiration warnings will be sent
- Some CAs may impose stricter rate limits on registrations without an email

For production deployments, providing an `acme_email` is strongly recommended.

### How to change the ACME email after bootstrap

The ACME email is part of the Caddy configuration, not the Fleet state. To
change it:

1. POST an updated TLS automation policy to the Caddy Admin API:

    ```bash
    docker exec -i fleet-proxy sh -c 'curl -s -X PATCH \
      -H "Content-Type: application/json" \
      -d @- http://localhost:2019/config/apps/tls/automation/policies/0/issuers/0' << 'EOF'
    {
      "module": "acme",
      "email": "new-email@example.com"
    }
    EOF
    ```

2. Or re-bootstrap by setting `caddy_bootstrapped: false` in the state file and
   re-deploying with the new email.

### ACME failure handling

If certificate issuance fails (e.g., DNS not pointing to the server, rate
limits, port 80/443 blocked), Caddy handles it automatically:

1. Retries once after a brief pause
2. Tries alternative challenge types (HTTP, TLS-ALPN)
3. Falls back to alternative issuers (Let's Encrypt -> ZeroSSL)
4. Backs off exponentially, up to 1 day between attempts, for up to 30 days

Caddy does not currently notify Fleet or the user about certificate failures
beyond Caddy's own logs. To monitor:

```bash
docker logs fleet-proxy 2>&1 | grep -i "certificate\|acme\|tls"
```

### Let's Encrypt requirements

For public domain certificates, ensure:

- The domain's A/AAAA DNS records point to the server
- Ports 80 and 443 are externally accessible
- The `caddy_data` volume is writable and persistent

## Fleet State Persistence

**Type:** File-based persistence (internal)
**Used in:** `src/bootstrap/bootstrap.ts:23, :40, :107`,
`src/state/state.ts:48-91`

### State file location

The state file lives at `~/.fleet/state.json` on the target server. The `~`
resolves to the home directory of the SSH user.

### State file structure

After a successful bootstrap, the state file contains:

```json
{
  "fleet_root": "/opt/fleet",
  "caddy_bootstrapped": true,
  "stacks": {}
}
```

### Inspecting the state file

```bash
cat ~/.fleet/state.json | jq
```

### Recovering from a corrupted state file

If the state file is corrupted (invalid JSON or invalid schema), `readState()`
will throw an error. To recover:

```bash
# Delete the state file -- falls back to defaults
rm ~/.fleet/state.json
```

This resets `caddy_bootstrapped` to `false`, so the next deploy will
re-bootstrap. Since all bootstrap steps are idempotent, this is safe. Existing
Docker containers and networks are not affected by the state file deletion, but
Fleet will lose track of which stacks are deployed.

### Concurrency and atomicity

The state file uses an atomic write pattern: content is written to a temporary
file (`~/.fleet/state.json.tmp`) then moved (`mv`) to the final path. This
prevents partial writes from corrupting the file. For details on the state
lifecycle across all Fleet operations, see
[State Lifecycle](../state-management/state-lifecycle.md).

However, the **read-check-write cycle is not atomic**. If two bootstrap
processes run concurrently:

1. Both read `caddy_bootstrapped: false`
2. Both proceed to execute the full sequence
3. Both succeed (steps are idempotent), but the last writer wins

In practice this is unlikely because Fleet typically runs a single deploy
pipeline at a time. There is no file-locking mechanism.

## SSH / Remote Execution Layer

**Type:** Remote execution abstraction (internal)
**Used in:** `src/bootstrap/bootstrap.ts:1, :19`

### How `ExecFn` works

The `ExecFn` type (from `src/ssh/types.ts`) is a function that takes a shell
command string and returns a promise with `{ code, stdout, stderr }`. The
bootstrap function receives an `ExecFn` as its first parameter and uses it
for every remote operation.

The abstraction supports two implementations:

- **SSH execution** -- Commands run on a remote server via an SSH connection
- **Local execution** -- Commands run on the local machine (for testing or
  local development)

See the [SSH connection documentation](../ssh-connection/overview.md)
for details on connection setup, credential management, and timeout handling.

### Error handling

All remote commands return exit codes rather than throwing exceptions. The
bootstrap function checks `result.code !== 0` after each critical command and
throws a descriptive `Error` with the exit code and stderr content. This means
SSH connectivity issues surface as command failures with non-zero exit codes.

The SSH layer itself may throw connection errors (timeout, authentication
failure, host key mismatch) before any commands execute. These are not handled
within the bootstrap module and will propagate up to the calling code.

## The fleet-proxy Docker Network

**Type:** Docker bridge network

### Purpose

The `fleet-proxy` network is the communication backbone between the Caddy proxy
and all deployed application containers. Without it, Caddy cannot reach the
upstream services to proxy traffic.

### How containers join

1. The Caddy proxy container joins `fleet-proxy` via its compose file
   (`networks: [fleet-proxy]` with `external: true`).
2. Application containers are connected after deployment via
   `docker network connect fleet-proxy {container-name}` (see
   `src/deploy/helpers.ts:292-315`).

### Inspecting network membership

```bash
docker network inspect fleet-proxy --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
```

### What happens if the network is deleted

If the `fleet-proxy` network is accidentally deleted while containers are
running, Caddy will lose connectivity to all upstream services. To recover:

1. Stop all Fleet containers: `docker compose -p fleet-proxy down`
2. Re-bootstrap by setting `caddy_bootstrapped: false` in the state file
3. Re-deploy all stacks

## Fleet Root Directory

**Type:** Filesystem path resolution (internal)
**Used in:** `src/bootstrap/bootstrap.ts:30-33`, `src/fleet-root/resolve.ts`

### Resolution logic

The fleet root is determined by `resolveFleetRoot()`:

1. Try `mkdir -p /opt/fleet` -- if it succeeds, use `/opt/fleet`
2. If it fails with a permission error, fall back to `~/fleet`
3. If it fails with any other error, throw

The resolved path is recorded in `~/.fleet-root` for reference and stored in
the state file.

### Typical locations

| Server setup | Fleet root |
|--------------|------------|
| Root user or `/opt` writable | `/opt/fleet` |
| Non-root user, no `/opt` write access | `~/fleet` |

### Directory structure under fleet root

After bootstrap, the fleet root contains:

```
/opt/fleet/
  proxy/
    compose.yml      # Caddy proxy compose file
```

After deploying application stacks, additional directories appear:

```
/opt/fleet/
  proxy/
    compose.yml
  {stack-name}/
    compose.yml
    .env             # (if secrets are configured)
```

See the [Fleet Root documentation](../fleet-root/overview.md) for more
details. For the complete directory tree including stack directories, see
[Directory Layout](../fleet-root/directory-layout.md).

## Related Documentation

- [Bootstrap Sequence](./bootstrap-sequence.md) -- step-by-step bootstrap
  process
- [Bootstrap Troubleshooting](./bootstrap-troubleshooting.md) -- diagnosing
  bootstrap failures
- [Server Bootstrap](./server-bootstrap.md) -- server-side bootstrap details
- [Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md) -- complete
  API endpoint documentation
- [Caddy Proxy Troubleshooting](../caddy-proxy/troubleshooting.md) -- debugging
  Caddy proxy issues
- [TLS and ACME](../caddy-proxy/tls-and-acme.md) -- certificate lifecycle
- [Fleet Root Overview](../fleet-root/overview.md) -- fleet root resolution
- [Directory Layout](../fleet-root/directory-layout.md) -- server filesystem
  layout
- [SSH Connection Overview](../ssh-connection/overview.md) -- SSH connection
  setup and credential management
- [State Lifecycle](../state-management/state-lifecycle.md) -- how state flows
  through bootstrap and deploy
- [State Schema Reference](../state-management/schema-reference.md) -- state
  file field definitions
- [Deploy Sequence](../deploy/deploy-sequence.md) -- the full 17-step deploy
  pipeline
