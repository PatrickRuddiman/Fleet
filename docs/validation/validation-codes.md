# Validation Codes Reference

Fleet defines 11 validation codes in `src/validation/types.ts`. Each check
function returns zero or more `Finding` objects containing a code, severity,
message, and resolution. This page catalogs every code, when it triggers, and
how to resolve it.

## Finding structure

Every finding follows this interface (defined in `src/validation/types.ts:3-8`):

```
Finding {
  severity: "error" | "warning"
  code:     string          // One of the Codes below
  message:  string          // Human-readable description
  resolution: string        // Actionable fix
}
```

**Errors** block deployment. When [`fleet validate`](./validate-command.md) or
[`fleet deploy`](../deploy/deploy-sequence.md) encounters
any error-severity finding, the process exits with code 1.

**Warnings** do not block deployment. The process exits with code 0, but
warnings are displayed to the operator. In CI pipelines, warnings pass by
default --- there is no built-in mechanism to promote warnings to errors.

## Error codes

### INVALID_STACK_NAME

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/fleet-checks.ts:97-108` |
| Check function | `checkInvalidStackName` |

**Trigger**: The `stack.name` field in `fleet.yml` does not match the pattern
`/^[a-z\d][a-z\d-]*$/`.

**What this means**: Stack names must start with a lowercase letter or digit,
and may only contain lowercase letters, digits, and hyphens. This constraint is
stricter than Docker Compose's own project naming rules (which also allow
underscores and dots). The stricter pattern ensures compatibility with DNS
subdomain labels, Docker container naming, and [Caddy route identifiers](../caddy-proxy/caddy-admin-api.md).

**How Docker Compose names relate**: Docker Compose uses the project name
(set via `-p` flag) as a prefix for container names (`{project}-{service}-{n}`).
Docker Compose project names must contain only lowercase letters, decimal
digits, dashes, and underscores, and must begin with a lowercase letter or
decimal digit. Fleet's regex is a subset of this, omitting underscores.

**Resolution**: Rename the stack to use only lowercase alphanumeric characters
and hyphens. Do not start with a hyphen.

---

### ENV_CONFLICT

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/fleet-checks.ts:4-25` |
| Check function | `checkEnvConflict` |

**Trigger**: Both `env.entries` and `env.infisical` are configured in `fleet.yml`
with non-empty values.

**What this means**: Fleet's [environment resolution](../deploy/secrets-resolution.md) writes a `.env` file on the
remote server. When both sources are present, `env.entries` would write the file
first, then `env.infisical` would overwrite it entirely (using `>`, not `>>`).
The entries would be silently lost. See
[Environment Configuration Shapes](../env-secrets/env-configuration-shapes.md)
for details on each env shape. This check promotes what would be a silent
data loss into an explicit error.

**What happens if bypassed**: If this check were somehow bypassed (e.g., by
modifying the validation code), the Infisical export would overwrite the entries
file. Only Infisical secrets would be available to the deployed containers.

**Resolution**: Use one source:
- Use `env.entries` for inline key-value pairs.
- Use `env.infisical` for Infisical-managed secrets.
- If you need both, consolidate secrets into a single Infisical project, or
  manage a combined `.env` file locally and use `env.file`.

---

### INVALID_FQDN

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/fleet-checks.ts:47-60` |
| Check function | `checkFqdnFormat` |

**Trigger**: A route's `domain` field is not a valid fully qualified domain name
per RFC 1035 rules.

**Validation rules** (implemented in `isValidFqdn` at
`src/validation/fleet-checks.ts:27-45`):

- Total length must be 1--253 characters.
- Must contain at least 2 labels separated by dots (e.g., `app.example.com`).
- Each label must be 1--63 characters.
- Each label must match `/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/`.

**Limitations**:

- **No wildcard support**: Domains like `*.example.com` are rejected because
  the `*` character fails the label regex. If Caddy wildcard certificates or
  routes are needed, this validation would need to be extended.
- **No internationalized domain names (IDN)**: Punycode-encoded domains
  (e.g., `xn--nxasmq6b.example.com`) are accepted because they use only ASCII
  characters. However, Unicode domain names (e.g., `domaine.exemple.fr` with
  accented characters) are rejected. If IDN support is needed, domains must
  be pre-converted to punycode before placing them in `fleet.yml`.
- **No trailing dot**: A trailing dot (e.g., `example.com.`) is technically
  valid in DNS but rejected here because it creates an empty final label.

**Resolution**: Use a valid FQDN such as `app.example.com`. Ensure labels use
only ASCII alphanumeric characters and hyphens, do not start or end with a
hyphen, and the total length stays under 253 characters.

---

### INVALID_PORT_RANGE

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/fleet-checks.ts:62-75` |
| Check function | `checkPortRange` |

**Trigger**: A route's `port` field is less than 1 or greater than 65535.

**What this means**: The port number specifies which container port the Caddy
reverse proxy should forward traffic to. Valid TCP/UDP ports are 1--65535.

**Resolution**: Set the route port to a valid number between 1 and 65535. This
should match the port your service listens on inside its container (the
`target` port in Docker Compose terms), not a host-mapped port.

---

### DUPLICATE_HOST

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/fleet-checks.ts:77-95` |
| Check function | `checkDuplicateHosts` |

**Trigger**: Two or more routes in the same `fleet.yml` file use the same
`domain` value.

**What this means**: Each route registers a host-based match in the Caddy
reverse proxy. If two routes claimed the same domain, the second registration
would either fail or overwrite the first, creating unpredictable routing.

**Resolution**: Ensure each route uses a unique domain. If multiple services
need to share a domain, they must be differentiated by path prefix, which
is not currently supported by Fleet's routing model.

---

### PORT_80_CONFLICT

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/compose-checks.ts:18-24` |
| Check function | `checkReservedPortConflicts` |

**Trigger**: A Docker Compose service binds host port 80.

**Why port 80 is reserved**: The Fleet reverse proxy ([Caddy](../caddy-proxy/overview.md)) binds to host
ports 80 and 443 to serve HTTP and HTTPS traffic for all deployed stacks. The
proxy is defined in the [`fleet-proxy` Docker Compose project](../caddy-proxy/proxy-compose.md)
(`src/proxy/compose.ts:13`) and started during [bootstrap](../bootstrap/bootstrap-sequence.md). If a service also
binds port 80, Docker will fail to start one of them due to the port conflict.

**Resolution**: Remove the host port 80 binding from the service in
`compose.yml`. The Caddy reverse proxy handles port 80. Route traffic to your
service by configuring a domain in `fleet.yml` routes --- Caddy will forward
requests to the service's internal container port.

---

### PORT_443_CONFLICT

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/compose-checks.ts:25-31` |
| Check function | `checkReservedPortConflicts` |

**Trigger**: A Docker Compose service binds host port 443.

**Why port 443 is reserved**: Same as port 80 --- the Caddy reverse proxy
binds port 443 for HTTPS traffic with automatic TLS certificate provisioning
via [ACME/Let's Encrypt](../caddy-proxy/tls-and-acme.md).

**Resolution**: Remove the host port 443 binding. Let Caddy handle HTTPS
termination. TLS is enabled by default on routes (`tls: true` in the route
schema at `src/config/schema.ts:41`).

**Overriding this check**: There is currently no mechanism to override the port
80/443 reservation. If a legitimate use case requires binding these ports (e.g.,
a non-HTTP service on port 443), the validation code would need to be modified.

---

### SERVICE_NOT_FOUND

| Field | Value |
|-------|-------|
| Severity | error |
| Source | `src/validation/compose-checks.ts:38-56` |
| Check function | `checkServiceNotFound` |

**Trigger**: A route in `fleet.yml` specifies a `service` field that references
a service name that does not exist in the Docker Compose file.

**What this means**: The `service` field on a route tells Fleet which Docker
Compose service should receive traffic for that domain. If the referenced
service does not exist, the route cannot be wired up.

**Note**: The `service` field is optional in the route schema
(`src/config/schema.ts:40`). This check only fires when `service` is explicitly
set and does not match any key in the compose file's `services` map.

**Resolution**: Either add the missing service to `compose.yml`, or correct
the `service` name in the `fleet.yml` route.

## Warning codes

### PORT_EXPOSED

| Field | Value |
|-------|-------|
| Severity | warning |
| Source | `src/validation/compose-checks.ts:58-74` |
| Check function | `checkPortExposed` |

**Trigger**: A Docker Compose service binds a host port other than 80 or 443.

**What this means**: Host port bindings make a service directly accessible from
the internet on that port, bypassing the Caddy reverse proxy. This can create
port conflicts between stacks on the same server and exposes the service without
TLS termination.

**When this is acceptable**: Some services legitimately need direct host port
access (e.g., a database that must be reachable on a specific port, or a
non-HTTP protocol like SMTP on port 25).

**Resolution**: If external access is not required, remove the host port binding
and route traffic through the Caddy proxy via a Fleet route. If the binding is
intentional, the warning can be safely ignored --- it will not block deployment.

---

### NO_IMAGE_OR_BUILD

| Field | Value |
|-------|-------|
| Severity | warning |
| Source | `src/validation/compose-checks.ts:76-90` |
| Check function | `checkNoImageOrBuild` |

**Trigger**: A Docker Compose service has neither an `image` nor a `build`
directive.

**What this means**: Docker Compose requires at least one of `image` or `build`
to know how to create a container. A service missing both will fail at
`docker compose up`. This is a warning rather than an error because some Compose
extensions or third-party tools may provide images through other mechanisms.

**Resolution**: Add an `image` (to pull from a registry) or `build` (to build
from a Dockerfile) directive to the service in `compose.yml`.

---

### ONE_SHOT_NO_MAX_ATTEMPTS

| Field | Value |
|-------|-------|
| Severity | warning |
| Source | `src/validation/compose-checks.ts:92-113` |
| Check function | `checkOneShotNoMaxAttempts` |

**Trigger**: A Docker Compose service uses `restart: "on-failure"` without
setting `deploy.restart_policy.max_attempts`.

**What `restartPolicyMaxAttempts` maps to**: This corresponds to the
`deploy.restart_policy.max_attempts` field in the Docker Compose file. In the
Docker Compose specification, `max_attempts` controls the maximum number of
restart attempts before giving up. When not set, Docker retries indefinitely.

**Docker Compose file example**:

```yaml
services:
  worker:
    image: myapp/worker
    restart: "on-failure"
    deploy:
      restart_policy:
        condition: on-failure
        max_attempts: 3
        window: 120s
```

**What this means**: Without `max_attempts`, a failing container with
`restart: "on-failure"` will restart indefinitely, consuming server resources
and potentially masking the underlying failure. This is especially problematic
for one-shot or migration containers that should fail definitively. See the
[Stack Lifecycle Overview](../stack-lifecycle/overview.md) for how Fleet manages
these container types.

**Fleet's deployment behavior**: Services with `restart: "on-failure"` are
classified as "always redeploy" by Fleet's [deployment classification system](../deploy/service-classification-and-hashing.md)
(see [compose queries](../compose/queries.md), `src/compose/queries.ts:57-68`). They are redeployed on every
`fleet deploy` regardless of hash changes.

**Resolution**: Add `deploy.restart_policy.max_attempts` to the service in
`compose.yml` to cap the number of restart attempts (e.g., 3).

## Quick reference table

| Code | Severity | Category | Trigger summary |
|------|----------|----------|----------------|
| `INVALID_STACK_NAME` | error | Fleet config | Stack name does not match `^[a-z\d][a-z\d-]*$` |
| `ENV_CONFLICT` | error | Fleet config | Both `env.entries` and `env.infisical` are set |
| `INVALID_FQDN` | error | Fleet config | Route domain is not a valid FQDN |
| `INVALID_PORT_RANGE` | error | Fleet config | Route port is outside 1--65535 |
| `DUPLICATE_HOST` | error | Fleet config | Same domain used by multiple routes |
| `PORT_80_CONFLICT` | error | Compose | Service binds host port 80 (reserved for Caddy) |
| `PORT_443_CONFLICT` | error | Compose | Service binds host port 443 (reserved for Caddy) |
| `SERVICE_NOT_FOUND` | error | Compose | Route references a service not in compose file |
| `PORT_EXPOSED` | warning | Compose | Service binds a non-reserved host port |
| `NO_IMAGE_OR_BUILD` | warning | Compose | Service lacks both `image` and `build` |
| `ONE_SHOT_NO_MAX_ATTEMPTS` | warning | Compose | `on-failure` restart without `max_attempts` |

## Related documentation

- [Validation Overview](./overview.md)
- [Fleet Configuration Checks](./fleet-checks.md) -- implementation details
  for fleet config checks
- [Compose Configuration Checks](./compose-checks.md) -- implementation
  details for compose checks
- [Validation Troubleshooting](./troubleshooting.md) -- diagnosing validation
  failures
- [Validate Command](./validate-command.md) -- CLI command reference
- [Configuration Overview](../configuration/overview.md) -- `fleet.yml`
  structure validated by these checks
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  field-by-field specification
- [Compose Types](../compose/types.md) -- data model used by compose checks
- [Deploy Sequence](../deploy/deploy-sequence.md) -- validation runs at Step 1
- [Deployment Troubleshooting](../deploy/troubleshooting.md) -- how validation
  errors manifest during deployment
- [Caddy Proxy Overview](../caddy-proxy/overview.md) -- context for port
  80/443 reservation
- [Environment and Secrets](../env-secrets/overview.md) -- context for
  `ENV_CONFLICT` validation
- [State Management Overview](../state-management/overview.md) -- server state
  used for cross-stack collision detection (DUPLICATE_HOST, PORT_80/443_CONFLICT)
- [Fleet Root Resolution Flow](../fleet-root/resolution-flow.md) -- how
  `fleet_root` determines directory names affected by INVALID_STACK_NAME
- [Configuration Loading and Validation](../configuration/loading-and-validation.md) --
  how `fleet.yml` is loaded and parsed before validation codes are checked
- [Stack Lifecycle Overview](../stack-lifecycle/overview.md) -- context for
  one-shot containers and the ONE_SHOT_NO_MAX_ATTEMPTS warning
- [Bootstrap Sequence](../bootstrap/bootstrap-sequence.md) -- how the Caddy
  proxy is started, providing context for PORT_80/443_CONFLICT codes
- [Environment Configuration Shapes](../env-secrets/env-configuration-shapes.md) --
  the three env shapes relevant to the ENV_CONFLICT code
