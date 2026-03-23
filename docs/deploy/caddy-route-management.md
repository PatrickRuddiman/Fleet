# Caddy Route Management

## What This Covers

Fleet uses [Caddy](https://caddyserver.com/) as its reverse proxy, managing
routes programmatically through Caddy's JSON admin API. This page explains how
routes are bootstrapped, registered, removed, and debugged.

## Why Caddy

Caddy provides automatic HTTPS via ACME (Let's Encrypt) with zero configuration,
a JSON-native admin API for programmatic route management, and a lightweight
Docker image (`caddy:2-alpine`). Fleet leverages these features to provide
automatic TLS certificate provisioning and hot-reloadable reverse proxy routes
without requiring Nginx configuration files or manual certificate management.

## Architecture: Three-Tier Remote Execution

All Caddy API interactions follow a three-tier execution model (local CLI → SSH
→ docker exec → Caddy). For details, see
[Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md#access-pattern).

## The Caddy Admin API

Fleet uses five Caddy admin API endpoints for route management. For the
complete endpoint reference, builders, and error handling, see
[Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md).

## Bootstrap Process

On first deployment (when `caddy_bootstrapped` is `false`), the proxy bootstrap
at `src/deploy/helpers.ts:90-134` performs these steps (see also
[Server Bootstrap](../bootstrap/server-bootstrap.md) for the standalone
bootstrap module):

1. **Resolve fleet root**: Determines where Fleet stores files on the server
   (`/opt/fleet` or `~/fleet`). See
   [Fleet Root Resolution](../fleet-root/overview.md) for details.
2. **Create Docker network**: `docker network create fleet-proxy 2>/dev/null || true`
3. **Write proxy compose file**: Generates and uploads a `compose.yml` for the
   Caddy container
4. **Start Caddy**: `docker compose -f {proxyDir}/compose.yml up -d`
5. **Post bootstrap config**: Sends the initial JSON config to `/load`

The bootstrap config creates an HTTP server named `fleet` listening on ports 80
and 443 with an empty routes array. If an `acme_email` is provided in any route
configuration, a TLS automation policy with an ACME issuer is included.

### Caddy Container Configuration

The Caddy container is defined in `src/proxy/compose.ts:7-31`:

- **Image**: `caddy:2-alpine` (floating tag -- updates on `docker compose pull`)
- **Container name**: `fleet-proxy`
- **Ports**: 80 and 443 mapped to the host
- **Networks**: Joins the `fleet-proxy` external network
- **Volumes**: `caddy_data` (certificates) and `caddy_config` (configuration)
- **Command**: `caddy run --resume`

The `--resume` flag tells Caddy to load its last saved configuration from disk
on startup. This is important because Caddy saves its config to the `caddy_config`
volume after each change via the admin API. If the container restarts (e.g., after
a server reboot), `--resume` restores all previously registered routes without
needing Fleet to re-register them.

## Route Registration

During Step 14 of the deploy pipeline, `registerRoutes()` at
`src/deploy/helpers.ts:377-444` performs an **atomic full-config replacement**
via the Caddy `/load` endpoint. This approach makes route registration
idempotent — routes are always derived from Fleet state (the source of truth),
not from Caddy's current live config.

The process:

1. **Derive other stacks' routes from state**: Iterates all stacks in
   `state.json` except the current one, building route objects for each stored
   route. This ensures routes from other stacks are preserved.

2. **Build new routes for this stack**: Creates route objects for each route in
   the current `fleet.yml` configuration, including `@id`, host matcher, and
   reverse proxy handler.

3. **GET full Caddy config**: Fetches the current config from
   `GET /config/` to preserve TLS automation policies, server settings, and
   other non-route configuration.

4. **Merge routes into config**: Replaces
   `config.apps.http.servers.fleet.routes` with the combined array of other
   stacks' routes and new routes. Deep path initialization ensures missing
   intermediate objects are created.

5. **POST /load**: Sends the complete config to `POST /load`, which atomically
   replaces the entire Caddy configuration. The `@id` index is rebuilt from
   scratch by Caddy, preventing duplicate-ID errors.

This design avoids the race conditions and partial-failure states that a
per-route delete-then-post approach would introduce. If the `/load` POST fails,
the previous configuration remains intact.

### Route ID Format

The Caddy `@id` is constructed by `buildCaddyId()` at
`src/caddy/commands.ts:11-17` as `{stackName}__{domain-slug}` (double
underscore separator), where the domain slug is created by replacing
non-alphanumeric characters with hyphens and lowercasing:

- `example.com` → `myapp__example-com`
- `api.example.com` → `myapp__api-example-com`
- `sub.domain.io` → `myapp__sub-domain-io`

This ID is stored in `state.json` as `caddy_id` in each route state entry and
can be used for direct route inspection via `GET /id/{caddyId}`.

### Upstream Host Resolution

The upstream host is the container name following Docker Compose's default
naming convention: `{stackName}-{serviceName}-1`. This works because both the
application container and the Caddy container are connected to the same
`fleet-proxy` Docker bridge network, which provides DNS resolution by container
name.

## The fleet-proxy Docker Network

The `fleet-proxy` network is a user-defined Docker bridge network that enables
container-to-container routing. Unlike the default Docker bridge:

- **DNS resolution**: Containers can reach each other by name
- **Isolation**: Only containers explicitly connected to the network can
  communicate
- **External declaration**: The network is created by Fleet and declared as
  `external: true` in the proxy compose file, meaning Docker Compose does not
  manage its lifecycle

During Step 13 of the deploy pipeline, `attachNetworks()` at
`src/deploy/helpers.ts:304-327` connects each routed service container to this
network. "Already connected" errors are silently ignored, making the operation
idempotent.

## TLS and ACME Certificates

Caddy provides automatic HTTPS through the ACME protocol (typically using
Let's Encrypt). When a route has `tls: true` (the default), Caddy automatically:

1. Obtains a TLS certificate from Let's Encrypt for the route's domain
2. Stores the certificate in the `caddy_data` Docker volume
3. Renews the certificate before expiration
4. Redirects HTTP to HTTPS

The `acme_email` field in `fleet.yml` routes is passed to Caddy's TLS automation
policy. It serves as the contact email for Let's Encrypt certificate
notifications (expiration warnings, policy changes). If omitted, Caddy may still
obtain certificates but without a contact email registered with the ACME provider.

For more details on TLS certificate provisioning and management, see
[TLS and ACME](../caddy-proxy/tls-and-acme.md).

### Where Certificates Are Stored

TLS certificates are stored in the `caddy_data` Docker volume, persisted across
container restarts. The actual path inside the volume is managed by Caddy and
follows its internal directory structure under `/data`.

### Certificate Renewal

Caddy handles certificate renewal automatically. Certificates are renewed
approximately 30 days before expiration. If renewal fails (DNS issues, rate
limits, domain validation failures), Caddy logs the error and retries. Check
Caddy container logs for renewal issues:

```bash
ssh user@server "docker logs fleet-proxy --tail 50"
```

## Host Collision Detection

Before any routes are registered, Step 4 of the deploy pipeline checks for host
collisions at `src/deploy/helpers.ts:62-84`. This function iterates all domains
in the incoming routes and compares them against all routes in all *other* stacks
recorded in `state.json`. If a domain is already claimed by a different stack,
the deploy fails with an error listing the conflicts.

Routes within the same stack are not flagged because re-deploying a stack
naturally re-registers its own routes.

## How to Debug Routes

### View Current Caddy Configuration

```bash
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/config/ | jq"
```

### List All Registered Routes

```bash
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq"
```

### Check a Specific Route by ID

```bash
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/id/{stackName}__{domain-slug} | jq"
```

### Force Re-Register All Routes

Use the Fleet CLI:

```bash
fleet proxy reload
```

This rebuilds the full route set from `state.json` and performs an atomic
`/load` replacement, effectively synchronizing the live Caddy configuration
with the desired state.
See [Proxy Status Command](../proxy-status-reload/proxy-status.md) and
[Route Reload](../proxy-status-reload/route-reload.md) for details.

### Check for Ghost or Missing Routes

```bash
fleet proxy status
```

This compares the live Caddy routes against `state.json` and reports:
- **Ghost routes**: Present in Caddy but not in state (e.g., manually added or
  left over from a failed teardown)
- **Missing routes**: Expected in state but not present in Caddy (e.g., lost
  after a container restart without `--resume`)

## Related documentation

- [17-Step Deploy Sequence](deploy-sequence.md)
- [Integrations Reference](integrations.md)
- [Troubleshooting](troubleshooting.md)
- [Deployment Pipeline Overview](../deployment-pipeline.md)
- [Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md) -- complete
  endpoint reference and command builders
- [Caddy Proxy Troubleshooting](../caddy-proxy/troubleshooting.md) -- debugging
  Caddy failures including route issues
- [TLS and ACME](../caddy-proxy/tls-and-acme.md) -- certificate provisioning
  details
- [Proxy Status Command](../proxy-status-reload/proxy-status.md) -- ghost and
  missing route detection
- [State Management Overview](../state-management/overview.md) -- how route
  state is persisted
- [Bootstrap Integrations](../bootstrap/bootstrap-integrations.md) -- proxy
  bootstrap and network creation
- [Validation Troubleshooting](../validation/troubleshooting.md) -- resolving
  validation errors related to route and proxy configuration
- [Deploy Failure Recovery](./failure-recovery.md) -- recovery procedures when
  route registration or bootstrap fails
- [Fleet Root Resolution](../fleet-root/overview.md) -- how the fleet root
  directory is determined on the server
- [SSH Connection Layer](../ssh-connection/overview.md) -- how remote commands
  are executed over SSH
