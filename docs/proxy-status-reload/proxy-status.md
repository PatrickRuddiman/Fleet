# Proxy Status Command

## What it does

`fleet proxy status` inspects the live Caddy reverse proxy configuration on
the remote server and reconciles it against the expected state recorded in
`~/.fleet/state.json`. It reports:

- Whether the Caddy container is running
- The Caddy version
- A table of all live routes (hostname and upstream address)
- Warnings for **ghost routes** and **missing routes**

## How to run

```sh
fleet proxy status
```

There are no flags or arguments. The command reads `fleet.yml` from the current
working directory and connects to the server defined in `config.server`.

## How it works

The command is implemented in `src/proxy-status/proxy-status.ts:181-239` as the
`proxyStatus()` function. It proceeds through five steps:

### Step 1: Load configuration and connect

```
const config = loadFleetConfig(path.resolve("fleet.yml"));
connection = await createConnection(config.server);
const state = await readState(exec);
```

The `fleet.yml` file must be in the current directory. The `server` block
provides SSH connection parameters (see
[fleet.yml configuration](#what-fleetyml-contains) below). The state file is
read from `~/.fleet/state.json` on the remote server.

### Step 2: Check container status

```
docker inspect --format '{{.State.Status}}' fleet-proxy
```

If the container is not running (or does not exist), the command prints the
container status and **returns early** -- no further API queries are attempted.

### Step 3: Query Caddy Admin API

Two queries are executed via `docker exec fleet-proxy curl ...` (see
[Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md) for full
endpoint documentation):

| Query | Caddy API endpoint | Purpose |
|-------|--------------------|---------|
| Full config | `GET /config/` | Extract Caddy version string |
| Route list | `GET /config/apps/http/servers/fleet/routes` | Get all live routes |

The full config response is a JSON object with a top-level `version` field. If
parsing fails, the version is reported as `"unknown"`.

Each route in the routes array is expected to have the structure:

```json
{
  "@id": "stackName__serviceName",
  "match": [{ "host": ["example.com"] }],
  "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": "host:port" }] }]
}
```

Routes that do not match this structure are silently skipped.

### Step 4: Reconcile live vs. expected routes

The reconciliation logic (`src/proxy-status/proxy-status.ts:84-100`) performs
a set-difference operation between two hostname lists:

- **Live hostnames**: Extracted from the Caddy routes query
- **Expected hostnames**: Collected from all stacks' `routes[].host` fields
    in `state.json`

This produces:

- **Ghost routes**: Hostnames present in Caddy but not in `state.json`
- **Missing routes**: Hostnames present in `state.json` but not in Caddy

### Step 5: Format and print output

The output looks like:

```
Proxy container: running
Caddy version: v2.8.4

HOSTNAME               UPSTREAM
app.example.com        myapp-web-1:3000
api.example.com        myapp-api-1:8080

Warning: Ghost routes (in Caddy but not in state.json):
  - old.example.com

Warning: Missing routes (in state.json but not in Caddy):
  - staging.example.com

Run `fleet proxy reload` to reconcile.
```

## What is a ghost route?

A ghost route is a hostname that exists in the live Caddy configuration but has
no corresponding entry in `state.json`. Ghost routes occur when:

- A stack was torn down (`fleet teardown`) but Caddy route cleanup failed or
    was interrupted.
- Someone manually added a route via the Caddy Admin API.
- A previous deploy added a route, then the state file was corrupted or
    manually edited to remove it.

Ghost routes are not necessarily harmful -- they may still route traffic
correctly if the upstream container exists. However, they indicate state drift
that should be investigated.

**To remove ghost routes**, you can either:

1. Re-deploy the stack that should own the route (it will re-register properly).
2. Manually delete via `docker exec fleet-proxy curl -X DELETE http://localhost:2019/id/{caddy_id}` on the server.

## What is a missing route?

A missing route is a hostname recorded in `state.json` that has no
corresponding entry in the live Caddy configuration. Missing routes mean
**traffic for that hostname is not being proxied**. They occur when:

- The Caddy container was restarted and `caddy run --resume` failed to restore
    the configuration (possibly due to corrupted Caddy config storage).
- A deploy recorded the route in state but the Caddy API call to add it failed.
- Someone manually deleted a route via the Caddy Admin API.

**To fix missing routes**, run `fleet proxy reload`. This will re-register all
routes from `state.json` into Caddy.

## What `fleet.yml` contains

The `server` block of `fleet.yml` provides the connection parameters used by
both proxy status and reload:

```yaml
version: "1"
server:
  host: 203.0.113.10      # Server hostname or IP (required)
  port: 22                 # SSH port (default: 22)
  user: root               # SSH username (default: "root")
  identity_file: ~/.ssh/id_ed25519  # Path to private key (optional)
```

- If `identity_file` is provided, that key is used for authentication.
- If `identity_file` is omitted, the SSH agent (`SSH_AUTH_SOCK`) is used.
- If `host` is `localhost` or `127.0.0.1`, commands run locally instead of
    over SSH.

See the [Fleet Configuration](../configuration/overview.md) documentation for
the full schema, or the
[Configuration Schema Reference](../configuration/schema-reference.md) for
field-by-field details.

## Type definitions

Defined in `src/proxy-status/types.ts`:

- **`LiveRoute`** -- A hostname-to-upstream mapping extracted from Caddy:
    `{ hostname: string; upstream: string }`
- **`ContainerStatus`** -- Whether the container is running:
    `{ running: boolean; status: string }`
- **`ReconciliationResult`** -- The output of set-difference reconciliation:
    `{ ghostRoutes: string[]; missingRoutes: string[] }`

## Related documentation

- [Overview: Proxy Status and Route Reload](./overview.md)
- [Route Reload Command](./route-reload.md)
- [Troubleshooting Guide](./troubleshooting.md)
- [Caddy Admin API Reference](../caddy-proxy/caddy-admin-api.md) -- endpoint
  details for the API queries used by proxy status
- [Caddy Proxy Troubleshooting](../caddy-proxy/troubleshooting.md) -- debugging
  Caddy container and API issues
- [State Management Overview](../state-management/overview.md) -- how state.json
  stores expected route information
- [Deploy Caddy Route Management](../deploy/caddy-route-management.md) -- how
  routes are registered during deployment
- [Stack Lifecycle Teardown](../stack-lifecycle/teardown.md) -- how teardown
  removes routes (potential source of ghost routes)
