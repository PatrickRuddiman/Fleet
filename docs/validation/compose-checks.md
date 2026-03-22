# Compose Configuration Checks

Compose checks validate the parsed Docker Compose file against Fleet's
operational requirements. They catch port conflicts with the reverse proxy,
missing service references, missing image directives, and unsafe restart
policies. These checks run after fleet-level checks in the validation pipeline.

Source: `src/validation/compose-checks.ts`

## How the Compose file is loaded

The validation pipeline loads the compose file in two steps:

1. The compose file path is resolved relative to the `fleet.yml` directory:
   `path.resolve(dir, config.stack.compose_file)` (`src/commands/validate.ts:26`).
2. `loadComposeFile(composePath)` reads and parses the file
   (`src/compose/parser.ts:112-141`), producing a `ParsedComposeFile`.

The `compose_file` field in `fleet.yml` defaults to `"docker-compose.yml"`
(`src/config/schema.ts:50`). If the file does not exist or contains invalid
YAML, the loader throws before validation checks run.

### What format versions are supported?

The parser does not check for a `version` key or validate against any specific
Docker Compose specification version. It looks for a top-level `services` map
and extracts a normalized subset of fields per service. This means:

- Compose v2 and v3 files work as long as they have a `services` key.
- The modern versionless format (Compose Specification) works.
- Features like `extends`, `include`, variable interpolation (`${VAR}`),
  and multi-file merging are **not** handled --- the parser reads the raw YAML
  from a single file.

## Reserved port conflict detection

**Function**: `checkReservedPortConflicts(compose)` at
`src/validation/compose-checks.ts:11-36`

**What it checks**: Whether any service in the compose file binds host ports
80 or 443.

### Why ports 80 and 443 are reserved

Fleet runs a [Caddy reverse proxy](../caddy-proxy/) as the `fleet-proxy`
Docker container. This container binds host ports 80 (HTTP) and 443 (HTTPS)
to serve all deployed stacks through domain-based routing. The port mappings
are hard-coded in `src/proxy/compose.ts:13-14`:

```yaml
ports:
  - "80:80"
  - "443:443"
```

If a user's service also binds these ports, Docker will fail to start one of
the containers due to port conflict. The validation check catches this before
deployment.

### How port bindings are detected

The check delegates to `findReservedPortConflicts()` from
`src/compose/queries.ts:36-42`, which:

1. Calls `findHostPortBindings()` to enumerate all host port mappings across
   all services.
2. Filters for `hostPort === 80 || hostPort === 443`.

The port normalization in `src/compose/parser.ts:9-56` handles both Docker
Compose port syntaxes:

- **Short syntax**: `"8080:80"`, `"80:80"`, `"443:443/tcp"`
- **Long syntax**: `{ published: 80, target: 80 }`

**Can this check be overridden?** No. There is no configuration flag or
annotation to exempt a service from this check. If a service legitimately needs
host port 80 for a non-HTTP protocol, the validation code must be modified.

## Service reference validation

**Function**: `checkServiceNotFound(config, compose)` at
`src/validation/compose-checks.ts:38-56`

**What it checks**: For each route in `fleet.yml` that has an explicit `service`
field, the referenced service must exist in the compose file.

This is a cross-configuration check --- it validates consistency between
`fleet.yml` routes and the Docker Compose service map. The check uses
`serviceExists()` from `src/compose/queries.ts:7-12`, which performs a simple
key lookup in `compose.services`.

**When service is omitted**: The `service` field is optional on routes
(`src/config/schema.ts:40`). When omitted, Fleet infers the service name from
context. This check only fires when the field is explicitly set.

## Host port exposure warning

**Function**: `checkPortExposed(compose)` at
`src/validation/compose-checks.ts:58-74`

**What it checks**: Whether any service binds host ports other than 80 and 443.

This is a **warning**, not an error. Host port bindings are sometimes necessary
(e.g., databases, SMTP servers, or custom protocols), but they bypass the
Caddy reverse proxy and create potential conflicts between stacks sharing the
same server.

The check excludes ports 80 and 443 (which are already caught as errors by
`checkReservedPortConflicts`). All other host port bindings produce a warning
suggesting the operator consider removing them unless external access is
required.

## Missing image or build directive

**Function**: `checkNoImageOrBuild(compose)` at
`src/validation/compose-checks.ts:76-90`

**What it checks**: Whether any service lacks both an `image` and a `build`
directive.

Docker Compose requires at least one of these to create a container. The check
uses `findServicesWithoutImageOrBuild()` from `src/compose/queries.ts:14-20`,
which inspects the `hasImage` and `hasBuild` boolean flags on each
`ParsedService`.

This is a **warning** because:
- Some advanced Compose configurations may provide images through other
  mechanisms.
- The actual failure would occur at `docker compose up` on the remote server,
  which will produce its own error. This check provides earlier feedback.

## One-shot restart policy without max attempts

**Function**: `checkOneShotNoMaxAttempts(compose)` at
`src/validation/compose-checks.ts:92-113`

**What it checks**: Whether any service uses `restart: "on-failure"` without
setting `restartPolicyMaxAttempts`.

### How restartPolicyMaxAttempts maps to Docker Compose

The `restartPolicyMaxAttempts` field on `ParsedService` corresponds to the
`deploy.restart_policy.max_attempts` field in a Docker Compose file:

```yaml
services:
  worker:
    image: myapp/worker
    restart: "on-failure"
    deploy:
      restart_policy:
        condition: on-failure
        max_attempts: 3    # <-- This field
        window: 120s
```

Per the Docker Compose specification, `max_attempts` controls how many times
Docker will attempt to restart a failed container before giving up. When not
set, retries are unlimited.

### Why this matters for Fleet

Fleet's deployment classification system
(see [Service Classification](../deploy/service-classification-and-hashing.md))
treats services with `restart: "on-failure"` as "always redeploy" targets
(`src/compose/queries.ts:57-68`). See the
[classification decision tree](../deploy/classification-decision-tree.md) for the
full priority-ordered logic. These are redeployed on every `fleet deploy`
regardless of whether their definition hash has changed. Without `max_attempts`,
a persistently failing container would restart indefinitely between deploys,
consuming CPU and memory.

### The check logic

The check iterates all services in the compose file
(`src/validation/compose-checks.ts:97-109`):

1. Service has `restart` defined (not `undefined`).
2. `restart` starts with `"on-failure"` (handles both `"on-failure"` and the
   legacy `"on-failure:3"` syntax).
3. `restartPolicyMaxAttempts` is `undefined` (the Compose parser did not find
   a `deploy.restart_policy.max_attempts` value).

If all three conditions are true, a warning is produced.

## Relationship between checks and compose queries

The compose checks are thin wrappers around query functions from
`src/compose/queries.ts`. This separation keeps validation logic (what to report)
separate from data extraction (how to find things in the compose structure):

| Check function | Query function used |
|----------------|---------------------|
| `checkReservedPortConflicts` | `findReservedPortConflicts()` |
| `checkServiceNotFound` | `serviceExists()` |
| `checkPortExposed` | `findHostPortBindings()` |
| `checkNoImageOrBuild` | `findServicesWithoutImageOrBuild()` |
| `checkOneShotNoMaxAttempts` | Direct iteration over `compose.services` |

## Related pages

- [Validation Overview](./overview.md)
- [Validation Codes Reference](./validation-codes.md) --- Full catalog with
  resolutions.
- [Fleet Configuration Checks](./fleet-checks.md) --- Checks against
  `fleet.yml` values.
- [Validate Command](./validate-command.md) --- CLI usage and output format.
- [Caddy Reverse Proxy](../caddy-proxy/overview.md) --- Why ports 80 and 443
  are reserved.
- [Compose Query Functions](../compose/queries.md) --- Query functions used by
  these checks.
- [Service Classification](../deploy/service-classification-and-hashing.md) ---
  How restart policies affect deployment decisions.
- [Configuration Loading](../configuration/loading-and-validation.md) --- How
  the fleet config is loaded before validation runs.
