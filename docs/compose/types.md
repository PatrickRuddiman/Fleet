# Compose Type Definitions

## What This Is

The type definitions in [`src/compose/types.ts`](../../src/compose/types.ts)
establish the data model that every consumer of the compose module works with.
Four interfaces define the shape of parsed Docker Compose data as it flows
through Fleet.

## Why These Types Exist

Raw YAML parsing produces untyped JavaScript objects. These interfaces provide
compile-time guarantees that downstream code accesses only the fields the parser
actually extracts, preventing runtime surprises from missing or mis-typed
properties.

## Interfaces

### NormalizedPort

Represents a single port mapping after normalization from any of the four
supported input shapes (see [parser.md](parser.md)).

| Field | Type | Description |
|-------|------|-------------|
| `published` | `number \| null` | The host-side port. `null` when only a container port is specified (no host binding). |
| `target` | `number` | The container-side port. Set to `0` when the input could not be parsed. |

**Design note:** `published` is nullable rather than optional (`?`) because the
distinction between "not bound to the host" and "not present" matters for port
conflict detection. A `null` value explicitly signals there is no host binding;
an `undefined` value would be ambiguous.

### ParsedService

Represents a single service extracted from the compose file. Contains the ~13
fields Fleet acts on.

| Field | Type | Description |
|-------|------|-------------|
| `hasImage` | `boolean` | `true` if the service defines a non-empty `image` string |
| `hasBuild` | `boolean` | `true` if the service defines a `build` key (any non-null value) |
| `ports` | `NormalizedPort[]` | All port mappings, normalized to a uniform shape |
| `image` | `string?` | The image reference, if present |
| `command` | `unknown?` | The `command` override, preserved as-is from YAML |
| `entrypoint` | `unknown?` | The `entrypoint` override, preserved as-is |
| `environment` | `unknown?` | Environment variables (may be array or object form) |
| `volumes` | `unknown?` | Volume mounts, preserved as-is |
| `labels` | `unknown?` | Container labels, preserved as-is |
| `user` | `string?` | The `user` directive |
| `working_dir` | `string?` | The `working_dir` directive |
| `healthcheck` | `unknown?` | Healthcheck configuration, preserved as-is |
| `restart` | `string?` | The restart policy string (`"no"`, `"always"`, `"unless-stopped"`, `"on-failure"`) |
| `restartPolicyMaxAttempts` | `number?` | Extracted from `deploy.restart_policy.max_attempts` if present |

**Why `unknown` for several fields?** Fields like `command`, `environment`, and
`volumes` accept multiple formats in the Docker Compose specification (string,
list, or mapping). Since Fleet passes these values through to deployment without
transforming them, there is no benefit to narrowing the type beyond `unknown`.
The parser preserves whatever structure YAML produced, and downstream code
treats these as opaque payloads.

### ParsedComposeFile

The top-level result returned by `loadComposeFile()`.

| Field | Type | Description |
|-------|------|-------------|
| `services` | `Record<string, ParsedService>` | Map of service name to parsed service data |

This interface currently contains only `services`. Top-level Compose keys like
`volumes`, `networks`, and `configs` are not extracted because Fleet does not
act on them directly.

### HostPortBinding

A flattened representation of a single host port binding, used by query
functions to report port conflicts.

| Field | Type | Description |
|-------|------|-------------|
| `service` | `string` | The name of the service that declares the binding |
| `hostPort` | `number` | The host-side port number |

This interface exists to decouple port-conflict queries from the nested
`ParsedService` > `NormalizedPort` structure, providing a flat list that
validation code can iterate without navigating the service hierarchy.

## Related documentation

- [Overview](overview.md) -- module-level context and design decisions
- [Parser internals](parser.md) -- how raw YAML is transformed into these types
- [Query functions](queries.md) -- functions that operate on `ParsedComposeFile`
- [Compose Module Integration](integration.md) -- cross-module dependency map
  showing how these types are consumed
- [Service Classification and Hashing](../deploy/service-classification-and-hashing.md) --
  how `ParsedService` fields drive deployment decisions
- [Hash Computation Pipeline](../deploy/hash-computation.md) -- how the 10
  runtime-affecting `ParsedService` fields are hashed into definition hashes
- [Compose Configuration Checks](../validation/compose-checks.md) -- validation
  checks that consume `HostPortBinding` and `NormalizedPort`
- [Configuration Schema](../configuration/schema-reference.md) -- how
  `fleet.yml` routes reference compose services
