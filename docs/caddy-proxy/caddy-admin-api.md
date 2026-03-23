# Caddy Admin API Reference

Fleet manages Caddy's routing configuration entirely through the
[Caddy Admin API](https://caddyserver.com/docs/api), a REST interface that
listens on `localhost:2019` inside the `fleet-proxy` container. This page
documents every API endpoint Fleet uses, how the command builders map to those
endpoints, and the execution model.

## Access Pattern

All API calls follow the same execution model:

```
docker exec [-i] fleet-proxy curl -s -f [options] http://localhost:2019/{path}
```

- `docker exec` -- Runs `curl` inside the Caddy container, avoiding any network
  exposure of the admin API.
- `-s` -- Silent mode (no progress output).
- `-f` -- Fail silently on HTTP errors (non-zero exit code on 4xx/5xx).
- `-i` -- Used only when piping a JSON body via heredoc (stdin).

The command builders in `src/caddy/commands.ts` produce these shell command
strings. They are never executed directly -- consumer modules pass them to an
SSH `exec` function (see [Connection API](../ssh-connection/connection-api.md)
for the `ExecFn` interface).

## Endpoint Map

### POST /load -- Bootstrap Configuration

**Builder:** `buildBootstrapCommand()` (`src/caddy/commands.ts:19-52`)

Replaces the entire Caddy configuration with an initial skeleton:

```json
{
  "apps": {
    "http": {
      "servers": {
        "fleet": {
          "listen": [":443", ":80"],
          "protocols": ["h1", "h2"],
          "routes": []
        }
      }
    }
  }
}
```

If `acme_email` is provided in `BootstrapOptions`, a TLS automation block is
appended (see [TLS and ACME](./tls-and-acme.md) for certificate lifecycle
details):

```json
{
  "apps": {
    "tls": {
      "automation": {
        "policies": [{
          "issuers": [{
            "module": "acme",
            "email": "admin@example.com"
          }]
        }]
      }
    }
  }
}
```

**Caddy behavior:** Per the
[official Caddy API docs](https://caddyserver.com/docs/api#post-load),
`POST /load`:

- **Blocks** until the reload completes or fails.
- **Incurs zero downtime** -- configuration changes are lightweight and
  efficient; in-flight requests are not dropped.
- **Rolls back automatically** if the new config fails for any reason. The old
  config is restored without downtime.
- **Autosaves** the new config to disk after a successful load, ensuring
  durability via the `caddy_config` volume when used with `caddy run --resume`.
- **Skips reload** if the new config is identical to the current one (unless
  `Cache-Control: must-revalidate` is set).

**Important:** `POST /load` is also used for **route registration and reload**
(not just bootstrap). Both `registerRoutes()` and `reloadRoutes()` use
`buildLoadConfigCommand()` to replace the full config atomically.

**Consumers:**
- `bootstrap()` in `src/bootstrap/bootstrap.ts:91-100` (step 7 -- initial
  empty config)
- `bootstrapProxy()` in `src/deploy/helpers.ts:118-125` (initial config)
- `registerRoutes()` in `src/deploy/helpers.ts:438-442` (full config with
  updated routes)
- `reloadRoutes()` in `src/reload/reload.ts:71` (full config with all routes
  from state)

### POST /config/apps/http/servers/fleet/routes -- Add Route

**Builder:** `buildAddRouteCommand()` (`src/caddy/commands.ts:73-77`)

Appends a new route to the `fleet` server's routes array. The route JSON
includes an `@id` tag for later direct access:

```json
{
  "@id": "mystack__app-example-com",
  "match": [{ "host": ["app.example.com"] }],
  "handle": [{
    "handler": "reverse_proxy",
    "upstreams": [{ "dial": "mystack-web-1:3000" }]
  }]
}
```

**Caddy behavior:** POSTing to an array path appends the element. The `@id`
field registers the route at `/id/mystack__app-example-com` for direct access.
Adding a route with a hostname triggers Caddy's automatic HTTPS -- certificate
provisioning begins immediately.

**Current usage:** This builder is exported but **not currently called** in the
codebase. Both `registerRoutes()` and `reloadRoutes()` use `POST /load` (full
config replacement via `buildLoadConfigCommand()`) instead of appending
individual routes. The builder remains available for potential future use in
manual or interactive operations.

### DELETE /id/{caddy_id} -- Remove Route

**Builder:** `buildRemoveRouteCommand()` (`src/caddy/commands.ts:89-91`)

Removes a route by its `@id` tag. The URL pattern is:

```
DELETE http://localhost:2019/id/{stackName}__{domainSlug}
```

For example: `DELETE http://localhost:2019/id/myapp__app-example-com`

**Caddy behavior:** Deleting via `/id/{name}` removes the element from
whatever array contains it -- no need to know the route's array index.
Returns 404 if the ID does not exist.

**Error handling:** Fleet silently ignores 404 errors from DELETE operations,
making route removal idempotent.

**Consumers:**
- `teardown` in `src/teardown/teardown.ts` -- removes individual stack
  routes during [`fleet teardown`](../stack-lifecycle/teardown.md)

### GET /config/apps/http/servers/fleet/routes -- List Routes

**Builder:** `buildListRoutesCommand()` (`src/caddy/commands.ts:93-95`)

Returns the current routes array as JSON. Used by
[`proxy-status`](../proxy-status-reload/proxy-status.md) to query live
state.

**Consumer:**
- `proxyStatus()` in `src/proxy-status/proxy-status.ts:210`

### GET /config/ -- Get Full Config

**Builder:** `buildGetConfigCommand()` (`src/caddy/commands.ts:97-99`)

Returns the entire Caddy configuration as JSON. Used for:

1. **Health probing** during bootstrap -- the response confirms the admin API
   is accepting requests (`src/bootstrap/bootstrap.ts:73-74`).
2. **Version extraction** -- `parseCaddyVersion()` reads the top-level
   `version` field (`src/proxy-status/proxy-status.ts:14-24`).
3. **Config assembly** during route registration and reload -- the full config
   is fetched, routes are merged in, and the result is posted back via
   `POST /load` (`src/deploy/helpers.ts:420-429`,
   `src/reload/reload.ts:53-62`).

**Consumers:**
- `bootstrap()` in `src/bootstrap/bootstrap.ts:73-74` (health check)
- `proxyStatus()` in `src/proxy-status/proxy-status.ts:209`
- `registerRoutes()` in `src/deploy/helpers.ts:421` (read-modify-write)
- `reloadRoutes()` in `src/reload/reload.ts:54` (read-modify-write)

### PATCH /config/apps/http/servers/fleet/routes -- Replace Routes (Unused)

**Builder:** `buildReplaceRoutesCommand()` (`src/caddy/commands.ts:79-82`)

Generates a `PATCH` request that would replace the entire routes array. Per the
[Caddy API docs](https://caddyserver.com/docs/api#patch-configpath), PATCH
strictly replaces an existing value.

**Status:** This builder is exported but **not called** anywhere in the
codebase. Fleet uses `POST /load` for all route replacement operations, which
provides stronger atomicity guarantees (automatic rollback on failure) compared
to PATCH on a specific config path.

### PUT /config/apps/http/servers/fleet/routes -- Create Routes (Unused)

**Builder:** `buildCreateRoutesCommand()` (`src/caddy/commands.ts:84-87`)

Generates a `PUT` request that would create or insert into the routes array.
Per the [Caddy API docs](https://caddyserver.com/docs/api#put-configpath), PUT
strictly creates a new value or inserts into an array.

**Status:** This builder is exported but **not called** anywhere in the
codebase. Like `buildReplaceRoutesCommand`, it exists as an alternative API
operation that Fleet does not currently use.

## Constants

Defined in `src/caddy/constants.ts`:

| Constant | Value | Purpose |
|---|---|---|
| `CADDY_CONTAINER_NAME` | `"fleet-proxy"` | Docker container name for `docker exec` |
| `CADDY_ADMIN_URL` | `"http://localhost:2019"` | Admin API base URL (inside container) |
| `CADDY_API_ROUTES_PATH` | `"/config/apps/http/servers/fleet/routes"` | Path to the routes array |
| `CADDY_API_CONFIG_PATH` | `"/config/"` | Path to the full config object |
| `CADDY_API_LOAD_PATH` | `"/load"` | Path for full config replacement |
| `CADDY_API_ID_PATH` | `"/id"` | Base path for `@id`-based access |
| `CADDY_SERVER_NAME` | `"fleet"` | Caddy server name in the config tree |

## Request Flow Diagram

```mermaid
sequenceDiagram
    participant Fleet as Fleet CLI
    participant SSH as SSH Connection
    participant Docker as Docker Daemon
    participant Caddy as Caddy Admin API

    Fleet->>SSH: exec(buildAddRouteCommand(...))
    SSH->>Docker: docker exec -i fleet-proxy sh -c 'curl ...'
    Docker->>Caddy: POST /config/.../routes<br/>{ "@id": "stack__svc", ... }
    Caddy-->>Docker: 200 OK
    Docker-->>SSH: exit code 0
    SSH-->>Fleet: { code: 0, stdout, stderr }
    Note over Caddy: Config auto-saved to<br/>caddy_config volume
    Note over Caddy: TLS cert provisioning<br/>begins for new hostname
```

## JSON Payload Delivery

For endpoints that require a JSON body (bootstrap and add-route), Fleet uses a
heredoc pattern to pipe the payload via stdin:

```bash
docker exec -i fleet-proxy sh -c 'curl -s -f -X POST \
  -H "Content-Type: application/json" \
  -d @- http://localhost:2019/load' << 'FLEET_JSON'
{ ... }
FLEET_JSON
```

The `-i` flag on `docker exec` enables stdin forwarding. The `@-` in `curl`
reads the request body from stdin. The `'FLEET_JSON'` delimiter is quoted to
prevent shell variable expansion in the JSON payload.

For simpler operations (delete, list, get-config), the command uses plain
`docker exec` without `-i` since no request body is needed.

## Error Handling

| Scenario | Behavior |
|---|---|
| Route DELETE returns 404 | Silently ignored -- the route may not exist yet |
| `POST /load` fails (during deploy) | `registerRoutes()` throws with the stderr message |
| `POST /load` fails (during reload) | All routes reported as failed in `ReloadResult`; Caddy auto-rolls back to previous config |
| Bootstrap POST fails | `bootstrap()` throws, aborting the sequence |
| Health probe fails | Retried up to 10 times at 3-second intervals (30s total) |
| Container not running | `reloadRoutes()` throws with a user-facing message |

## Concurrent Config Changes

Per the [Caddy API documentation](https://caddyserver.com/docs/api#concurrent-config-changes),
Caddy provides ACID guarantees for individual API requests, but multi-request
changes without synchronization are subject to collisions. Caddy supports
`Etag` and `If-Match` headers for optimistic concurrency control on
`/config/` endpoints.

Fleet does **not** use Etag-based concurrency control. Instead, it mitigates
concurrent access through two mechanisms (see also the
[State Management concurrency discussion](../state-management/overview.md#concurrency-and-locking)
for related concerns at the state file level):

1. **`POST /load` for mutations**: Both `registerRoutes()` and `reloadRoutes()`
   use `POST /load` (full config replacement), which is a single atomic
   request. This avoids the multi-request read-modify-write race condition on
   `/config/` endpoints.
2. **SSH serialization**: Fleet operations are typically initiated by a single
   operator via the CLI. There is no built-in locking, so two concurrent
   `fleet deploy` commands to the same server could produce a race condition
   between the GET and POST /load calls. In practice, this is rare in Fleet's
   target use case (single-operator deployments).

## Related documentation

- [Architecture Overview](./overview.md) -- Network topology and design
  decisions
- [Proxy Compose](./proxy-compose.md) -- Caddy container Docker Compose
  configuration
- [TLS and ACME](./tls-and-acme.md) -- How route addition triggers certificate
  provisioning
- [Troubleshooting](./troubleshooting.md) -- Debugging API failures
- [Bootstrap Integrations](../bootstrap/bootstrap-integrations.md) -- How the
  bootstrap process uses the Admin API
- [Deploy Caddy Route Management](../deploy/caddy-route-management.md) -- Route
  registration during deployment
- [Proxy Status Command](../proxy-status-reload/proxy-status.md) -- Live route
  reconciliation
- [Route Reload](../proxy-status-reload/route-reload.md) -- How route reload
  uses `POST /load` to reconcile state with Caddy
- [State Management Overview](../state-management/overview.md) -- The state
  file that drives route registration and reconciliation
- [Official Caddy Admin API docs](https://caddyserver.com/docs/api)
