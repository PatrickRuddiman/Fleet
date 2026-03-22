# State Schema Reference

This page documents every field in Fleet's server state file
(`~/.fleet/state.json`). The state is validated at read time using Zod schemas
defined in `src/state/state.ts:5-38`, and its TypeScript interfaces are
declared in `src/state/types.ts`.

## FleetState

The top-level object stored in the state file.

| Field | Type | Required | Description |
|---|---|---|---|
| `fleet_root` | `string` | Yes | Absolute path to the Fleet root directory on the server (e.g., `/opt/fleet` or `~/fleet`). Empty string on a fresh default state. Resolved during [bootstrap](../bootstrap/server-bootstrap.md) and stored here for all subsequent operations. |
| `caddy_bootstrapped` | `boolean` | Yes | Whether the Caddy reverse proxy has been initialized. When `true`, the bootstrap step is skipped during deployment. Set to `true` at the end of a successful bootstrap sequence. |
| `stacks` | `Record<string, StackState>` | Yes | Map of stack names to their deployment state. Keys are the stack names from `fleet.yml` (must match `^[a-z\d][a-z\d-]*$`). An empty object `{}` on a fresh server. |

### Example

```json
{
  "fleet_root": "/opt/fleet",
  "caddy_bootstrapped": true,
  "stacks": {
    "my-app": { ... }
  }
}
```

## StackState

Represents a single deployed stack. Stored as a value in `FleetState.stacks`.

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Absolute path to the stack's directory on the remote server (e.g., `/opt/fleet/stacks/my-app`). |
| `compose_file` | `string` | Yes | Filename of the Docker Compose file used for this stack (e.g., `docker-compose.yml` or `compose.yml`). |
| `deployed_at` | `string` | Yes | ISO 8601 timestamp of the most recent deployment (e.g., `2026-03-22T10:30:00.000Z`). |
| `routes` | `RouteState[]` | Yes | Array of reverse proxy routes registered with Caddy for this stack. May be empty if the stack has no routed services. |
| `env_hash` | `string` | No | SHA-256 hash of the environment file (`.env`) on the remote server. Used to detect environment changes during selective deploy. Absent on stacks deployed before this field was introduced. |
| `services` | `Record<string, ServiceState>` | No | Per-service deployment metadata. Absent on stacks deployed before Fleet V1.2 (the version that introduced per-service tracking). When absent, the [`fleet ps` command](../process-status/ps-command.md) falls back to stack-level `deployed_at` for timestamp display. |

### Example

```json
{
  "path": "/opt/fleet/stacks/my-app",
  "compose_file": "docker-compose.yml",
  "deployed_at": "2026-03-22T10:30:00.000Z",
  "routes": [
    {
      "host": "app.example.com",
      "service": "web",
      "port": 3000,
      "caddy_id": "my-app__web"
    }
  ],
  "env_hash": "a1b2c3d4e5f6...",
  "services": {
    "web": { ... },
    "worker": { ... }
  }
}
```

## ServiceState

Per-service deployment metadata within a stack.

### Zod schema vs. TypeScript interface

The Zod schema (`src/state/state.ts:12-23`) and TypeScript interface
(`src/state/types.ts:10-19`) intentionally differ. The Zod schema marks
fields added in later versions as `.optional()` so that older state files pass
validation. The TypeScript interface declares all fields as required for
type-safety at call sites, relying on optional chaining and runtime checks
where the data may actually be absent.

| Field | Zod | TypeScript | Type | Description |
|---|---|---|---|---|
| `definition_hash` | required | required | `string` | SHA-256 hash of the service's runtime-affecting Compose fields (`image`, `command`, `entrypoint`, `environment`, `ports`, `volumes`, `labels`, `user`, `working_dir`, `healthcheck`). Used by the [classification decision tree](../deploy/classification-decision-tree.md) to detect definition changes. |
| `deployed_at` | required | required | `string` | ISO 8601 timestamp of when this service was last deployed or restarted. |
| `status` | required | required | `string` | Deployment status (e.g., `"deployed"`, `"restarted"`, `"skipped"`). |
| `image` | optional | required | `string` | Docker image reference used by this service (e.g., `nginx:latest`). Absent in state files from versions before this field was added. |
| `image_digest` | optional | required | `string` | Content-addressable digest of the Docker image (e.g., `sha256:abc123...`). Null or absent for locally-built images that have no registry digest. Compared during selective deploy to detect image updates. |
| `env_hash` | optional | required | `string` | SHA-256 hash of the environment file at the time of this service's deployment. |
| `skipped_at` | optional, nullable | `string \| null` | `string \| null` | ISO 8601 timestamp of the most recent skip. `null` when the service was not skipped. Used by `fleet ps` to show "skipped N minutes ago" annotations. |
| `one_shot` | optional | required | `boolean` | Whether this service uses a limited restart policy (`restart: "no"` or `restart: "on-failure"`). One-shot services are always redeployed regardless of hash comparison. |

## RouteState

Represents a single reverse proxy route registered with the Caddy server.

| Field | Type | Description |
|---|---|---|
| `host` | `string` | The domain name matched by this route (e.g., `app.example.com`). Caddy uses this for host-based routing and automatic TLS certificate provisioning. |
| `service` | `string` | The Docker Compose service name that this route proxies to. |
| `port` | `number` | The container port that Caddy forwards traffic to. |
| `caddy_id` | `string` | The identifier used by the [Caddy admin API](../caddy-proxy/overview.md) to address this route. Constructed as `{stackName}__{serviceName}` (double underscore separator) by `buildCaddyId()` in `src/caddy/commands.ts:11-13`. This ID enables direct route removal via the Caddy API endpoint `/id/{caddy_id}` without needing array index tracking. |

### How `caddy_id` maps to the Caddy admin API

The Caddy server's [admin API](https://caddyserver.com/docs/api) supports
addressing configuration objects by `@id`. When Fleet registers a route, it
includes an `@id` field set to the `caddy_id` value. This allows:

- **Route removal**: `DELETE /id/{caddy_id}` removes the route by ID
- **Route lookup**: `GET /id/{caddy_id}` retrieves a specific route's config

The `{stackName}__{serviceName}` format ensures uniqueness within a Fleet
deployment. A collision would occur only if two stacks shared the same name,
which is prevented by the host collision detection in
`src/deploy/helpers.ts:60-82`.

## Default state

When the state file does not exist (first deployment on a fresh server) or
is empty, `readState` returns:

```json
{
  "fleet_root": "",
  "caddy_bootstrapped": false,
  "stacks": {}
}
```

This default allows the bootstrap and deployment pipeline to proceed without
requiring manual state initialization.

## State file growth

The entire state -- all stacks, all services, all routes -- is serialized into
a single JSON blob. As the number of stacks and services grows, the file grows
proportionally. For a typical deployment:

- **1 stack with 5 services and 3 routes**: ~2-3 KB
- **10 stacks with 5 services each**: ~20-30 KB
- **50 stacks with 10 services each**: ~100-150 KB

These sizes are well within the limits of shell-based read (`cat`) and write
(heredoc) operations. Performance concerns would only arise with hundreds of
stacks on a single server, which is outside Fleet's intended use case.

## Related documentation

- [State management overview](./overview.md) -- architecture, operations, and
  concurrency model
- [Operations guide](./operations-guide.md) -- inspect, back up, and recover
  state
- [State lifecycle](./state-lifecycle.md) -- how state flows through the
  deploy pipeline
- [Deployment Pipeline](../deployment-pipeline.md) -- how state is read at
  Step 3 and written at Step 16
- [Deploy Failure Recovery](../deploy/failure-recovery.md) -- what happens
  when state write fails during deployment
- [Ps Command](../process-status/ps-command.md) -- how `fleet ps` uses
  `StackState` and `ServiceState` for display
- [Server Bootstrap](../bootstrap/server-bootstrap.md) -- how `fleet_root`
  and `caddy_bootstrapped` are initialized
- [Caddy Admin API](../caddy-proxy/caddy-admin-api.md) -- how `caddy_id`
  maps to Caddy route management
- [Service Classification](../deploy/service-classification-and-hashing.md) --
  how `definition_hash`, `image_digest`, and `env_hash` drive selective deployment
- [Directory Layout](../fleet-root/directory-layout.md) -- how the Fleet root
  directory structure relates to state file paths
