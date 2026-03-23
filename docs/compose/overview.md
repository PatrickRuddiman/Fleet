# Docker Compose Parsing and Queries

## What This Module Does

The compose module (`src/compose/`) is Fleet's interface to Docker Compose
project definitions. It reads a `docker-compose.yml` (or equivalent) file from
disk, parses its YAML content into typed TypeScript structures, and exposes a
set of pure query functions that other modules use to inspect service
configuration without touching the raw YAML again.

The module is organized into four files:

| File | Responsibility |
|------|---------------|
| [`src/compose/types.ts`](../../src/compose/types.ts) | TypeScript interfaces for the parsed data model |
| [`src/compose/parser.ts`](../../src/compose/parser.ts) | YAML loading, port normalization, service extraction |
| [`src/compose/queries.ts`](../../src/compose/queries.ts) | Pure functions that interrogate a `ParsedComposeFile` |
| [`src/compose/index.ts`](../../src/compose/index.ts) | Barrel re-export of all public types and functions |

## Why This Module Exists

Fleet needs to understand a project's service topology before it can deploy,
validate, or initialize anything. Rather than scattering YAML-parsing logic
across the codebase, the compose module centralizes it behind a single
`loadComposeFile()` call that returns a strongly typed result. Downstream
modules never deal with raw YAML nodes or untyped dictionaries; they work
exclusively with `ParsedComposeFile` and its associated query functions.

This separation provides three benefits:

1. **Single point of parsing** -- YAML edge cases (port syntax variants,
   protocol suffixes, `restart` string coercion) are handled in one place.
2. **Testable queries** -- every query function is pure (no I/O, no side
   effects), making unit testing straightforward.
3. **Selective extraction** -- the parser deliberately extracts only the ~13
   fields Fleet acts on, ignoring the remaining ~40+ Compose attributes it does
   not need. This keeps the data model small and intentional.

## How It Works

### Parse pipeline

1. `loadComposeFile(path)` reads the file synchronously with `fs.readFileSync`.
2. The raw string is parsed with `yaml.parse()` from the
   [`yaml`](https://eemeli.org/yaml/) npm package (YAML 1.2 core schema).
3. The top-level `services` key is extracted; each service value is passed
   through `parseService()`.
4. Within `parseService()`, the `ports` array is normalized via
   `normalizePort()`, which handles four input shapes (number, short string,
   long string with IP prefix, and long-form object).
5. The result is a `ParsedComposeFile` containing a `Record<string, ParsedService>`.

### Query layer

Six exported functions operate on the parsed result:

- `getServiceNames` / `serviceExists` -- basic enumeration
- `findServicesWithoutImageOrBuild` -- validation helper (used by
  [Compose Configuration Checks](../validation/compose-checks.md))
- `findHostPortBindings` / `findReservedPortConflicts` -- port conflict detection
- `alwaysRedeploy` / `getAlwaysRedeploy` -- deployment strategy classification
  (see [Service Classification](../deploy/service-classification-and-hashing.md)
  for how this affects the deploy pipeline)

See [queries.md](queries.md) for detailed behavior of each function.

## Design decisions and rationale

### Synchronous file I/O

`loadComposeFile` uses `fs.readFileSync` rather than an async variant. Fleet is
a CLI tool with a sequential execution model -- commands run one at a time, and
the compose file must be fully loaded before any subsequent step can proceed.
Synchronous I/O simplifies error handling and avoids unnecessary async ceremony
in a context where concurrency provides no benefit.

### No Compose `version` field checking

The parser does not look for or validate a `version` key in the compose file.
The Docker Compose specification deprecated the `version` field in favor of
a versionless schema where the top-level `services` key is always present.
Fleet follows this modern convention.

### YAML 1.2 and the `"no"` string

The `yaml` npm package (v2.x) implements the YAML 1.2 core schema by default.
Under this schema, bare `no` is parsed as the **string** `"no"`, not the
boolean `false` (as it would be under YAML 1.1). This is critical for the
`restart` field: `restart: no` in a compose file produces the string `"no"` in
the parsed output, which `alwaysRedeploy()` correctly matches with a string
comparison. No special boolean-to-string coercion is needed.

### Selective field extraction

`parseService()` extracts 13 fields and ignores everything else (`networks`,
`depends_on`, `cap_add`, `logging`, `deploy.resources`, `dns`, `extra_hosts`,
`sysctls`, and many more). This is intentional -- Fleet only needs the fields
it acts on. Unrecognized fields are silently dropped rather than rejected, so
users can include any valid Compose attributes without triggering errors.

### No support for advanced Compose features

The parser does not handle `extends`, variable interpolation (`${VAR}`), or
merging multiple compose files. These features are part of the full Docker
Compose specification but are outside Fleet's current scope. If a user relies
on these features, they should pre-process their compose file with
`docker compose config` before passing it to Fleet.

### Silent fallback for malformed ports

When `normalizePort()` encounters an input it cannot parse (e.g., a value that
is not a number, string, or object), it returns `{ published: null, target: 0 }`.
This means malformed port entries do not cause the parser to throw; instead,
they produce a target port of `0` that downstream validation can flag. This
fail-open approach keeps parsing resilient while shifting error reporting to the
validation layer (see [../deploy/classification-decision-tree.md](../deploy/classification-decision-tree.md)).

## Related documentation

- [Types reference](types.md) -- detailed field-by-field description of all interfaces
- [Parser internals](parser.md) -- port normalization flowchart and parsing logic
- [Query functions](queries.md) -- behavior and usage of each query
- [Integration and consumers](integration.md) -- which modules depend on compose and how
- [Validation](../deploy/classification-decision-tree.md) -- how parsed compose data feeds into deploy classification
- [Validation Overview](../validation/overview.md) -- pre-flight checks that
  use compose data to detect misconfigurations
- [Compose Configuration Checks](../validation/compose-checks.md) -- compose-
  specific validation rules (port conflicts, service references)
- [Caddy proxy](../caddy-proxy/) -- why ports 80 and 443 are reserved
- [Configuration](../configuration/overview.md) -- project-level configuration that complements compose data
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  the `stack.compose_file` field and route schemas
- [Deployment pipeline](../deployment-pipeline.md) -- how compose parsing fits into the deploy flow
- [Project Initialization](../project-init/overview.md) -- how `fleet init`
  uses compose data to generate `fleet.yml`
- [Validation Troubleshooting](../validation/troubleshooting.md) -- common
  compose-related validation failures and resolutions
- [Fleet Configuration Checks](../validation/fleet-checks.md) -- how compose
  data feeds into fleet.yml validation
