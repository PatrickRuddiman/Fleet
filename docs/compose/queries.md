# Compose Query Functions

## What

The query module ([`src/compose/queries.ts`](../../src/compose/queries.ts))
provides six pure functions that interrogate a `ParsedComposeFile` without
performing any I/O or mutations. These functions are the primary interface
through which other Fleet modules inspect service configuration.

## Why

Separating queries from parsing keeps the parser focused on data transformation
and ensures that inspection logic is independently testable. Every query
function takes a `ParsedComposeFile` (or `ParsedService`) as input and returns
a derived value -- no file system access, no side effects.

## Functions

### getServiceNames

```
getServiceNames(compose: ParsedComposeFile): string[]
```

Returns the names of all services defined in the compose file as an array of
strings. This is equivalent to `Object.keys(compose.services)`.

**Consumers:** Used by the deployment pipeline
([`src/deploy/deploy.ts`](../../src/deploy/deploy.ts),
[`src/deploy/helpers.ts`](../../src/deploy/helpers.ts)) to enumerate which
services to process.

### serviceExists

```
serviceExists(compose: ParsedComposeFile, name: string): boolean
```

Returns `true` if a service with the given name exists in the compose file.
Uses an `in` operator check against the services record.

### findServicesWithoutImageOrBuild

```
findServicesWithoutImageOrBuild(compose: ParsedComposeFile): string[]
```

Returns the names of services that have neither an `image` nor a `build`
directive. In Docker Compose, every service must specify at least one of these;
a service with neither is invalid and cannot be deployed.

**Consumers:** Used by validation
([`src/validation/compose-checks.ts`](../../src/validation/compose-checks.ts))
to flag misconfigured services before deployment begins. See
[Compose Configuration Checks](../validation/compose-checks.md) for details.

### findHostPortBindings

```
findHostPortBindings(compose: ParsedComposeFile): HostPortBinding[]
```

Returns a flat list of all host port bindings across all services. Only ports
where `published` is not `null` are included -- container-only ports (those
without a host binding) are excluded.

Each entry in the result contains the `service` name and the `hostPort` number,
making it straightforward to detect duplicates or conflicts without navigating
the nested service/port structure.

### findReservedPortConflicts

```
findReservedPortConflicts(compose: ParsedComposeFile): HostPortBinding[]
```

Returns host port bindings that conflict with ports reserved by Fleet's
infrastructure. Currently, the reserved ports are **80** and **443**.

**Why these ports?** Fleet deploys a [Caddy reverse proxy](../caddy-proxy/overview.md)
that binds to ports 80 (HTTP) and 443 (HTTPS) on the host. If a user's service
also binds to either of these ports, the containers will fail to start due to
port conflicts. This function detects that situation so the
[validation layer](../validation/compose-checks.md) can warn the user
before deployment. See also the
[validate command](../validation/validate-command.md) for how these checks are
invoked.

The reserved ports are hardcoded in the function body as a filter on
`findHostPortBindings` results. If Fleet's proxy architecture changes, this
list would need to be updated.

### alwaysRedeploy

```
alwaysRedeploy(service: ParsedService): boolean
```

Returns `true` for services whose restart policy indicates they should be
redeployed on every `fleet deploy`, regardless of whether their definition has
changed.

The function matches two restart policy values:

| Restart policy | Behavior | Why always redeploy? |
|---------------|----------|---------------------|
| `"no"` | Run-once container; does not restart after exit | These containers execute a task and stop. Without redeployment, they would never run again after their initial execution. |
| `"on-failure"` | Restarts only on non-zero exit | Without redeployment, these services would not pick up new images or configuration changes on a successful run. |

Services with `restart: "always"` or `restart: "unless-stopped"` are not
flagged because Docker's restart mechanism handles keeping them running with
updated configuration.

**Important:** The `restart` field comparison works correctly because Fleet uses
the `yaml` npm package with YAML 1.2 core schema, which parses bare `no` as
the string `"no"` rather than boolean `false`. See
[parser.md](parser.md#yaml-12-core-schema-implications) for details.

**Note on `startsWith`:** The check for `"on-failure"` uses
`service.restart.startsWith("on-failure")` rather than strict equality. This
accommodates the Docker Compose convention where `on-failure` can optionally
include a max retry count suffix (e.g., `on-failure:3`), though the Compose
specification typically handles this via `deploy.restart_policy.max_attempts`
instead.

### getAlwaysRedeploy

```
getAlwaysRedeploy(compose: ParsedComposeFile): string[]
```

Returns the names of all services in the compose file for which
`alwaysRedeploy` returns `true`. This is a convenience wrapper that maps
`alwaysRedeploy` across all services.

**Consumers:** Used by the deployment pipeline
([`src/deploy/deploy.ts`](../../src/deploy/deploy.ts),
[`src/deploy/classify.ts`](../../src/deploy/classify.ts),
[`src/deploy/helpers.ts`](../../src/deploy/helpers.ts)) to determine which
services need redeployment on every deploy cycle.

## Related documentation

- [Overview](overview.md) -- module context and design decisions
- [Types reference](types.md) -- interfaces used by these functions
- [Parser internals](parser.md) -- how the data these functions query is produced
- [Integration](integration.md) -- full map of which modules consume these functions
- [Compose Configuration Checks](../validation/compose-checks.md) -- validation
  checks that use these query functions
- [Classification Decision Tree](../deploy/classification-decision-tree.md) --
  how `alwaysRedeploy` affects deployment decisions
- [Service Classification](../deploy/service-classification-and-hashing.md) --
  overview of the classification system that consumes these queries
