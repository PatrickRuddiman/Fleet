# Server State Management

Fleet persists all deployment metadata in a single JSON file on each target
server. This module defines the data model, [validation rules](../validation/fleet-checks.md), and read/write
operations that form the single source of truth for every Fleet command.

## What it is

The state management layer is a file-based persistence system that tracks:

- Which stacks are deployed and where their files live on disk
- Which services are running within each stack, including their [content hashes](../deploy/service-classification-and-hashing.md)
- Which reverse proxy routes are registered with Caddy
- Whether the Caddy reverse proxy has been bootstrapped
- The fleet root directory path on the server

The state file lives at `~/.fleet/state.json` on the target host and is
read/written through Fleet's [SSH execution abstraction](../ssh-connection/overview.md) (`ExecFn`), meaning the
same code works for both remote servers and local deployments.

## Why a flat JSON file

Fleet targets single-server Docker Compose deployments. A flat JSON file was
chosen over a database or remote service because:

- **Zero dependencies**: No database server, no cloud service, no additional
    infrastructure to provision or maintain on the target host.
- **Inspectability**: Operators can `cat ~/.fleet/state.json` over SSH to
    immediately see the full deployment state.
- **Atomicity**: The write operation uses a POSIX-safe tmp-file-then-rename
    pattern that prevents partial writes without requiring transaction support.
- **Simplicity**: The entire state fits comfortably in a single JSON blob for
    typical deployments (tens of stacks, each with a handful of services).

## How it works

### Core operations

The module exports four functions from `src/state/state.ts`:

| Function | Purpose | Mutates state? |
|---|---|---|
| `readState(exec)` | Read and validate `~/.fleet/state.json` | No |
| `writeState(exec, state)` | Atomically write state to disk | Yes |
| `getStack(state, name)` | Look up a stack by name | No (pure) |
| `removeStack(state, name)` | Return new state without the named stack | No (pure, immutable) |

### Read path

`readState` executes `cat ~/.fleet/state.json` via the SSH layer. Three
outcomes are possible:

1. **File missing or empty** (`code !== 0` or empty stdout): Returns a default
   empty state with `fleet_root: ""`, `caddy_bootstrapped: false`, and no
   stacks. This makes the first deployment on a fresh server work without
   manual setup.

2. **Valid JSON, valid schema**: Returns the parsed and validated `FleetState`.

3. **Invalid JSON**: Throws with the message `"Failed to parse state file:
   invalid JSON in ~/.fleet/state.json"`.

4. **Valid JSON, invalid schema**: Throws with Zod validation error details
   joined into a single message.

See `src/state/state.ts:48-72` for the implementation.

### Write path

`writeState` serializes the state to pretty-printed JSON and writes it using
an atomic two-step pattern:

```
mkdir -p ~/.fleet && cat << 'FLEET_EOF' > ~/.fleet/state.json.tmp
{ ...json... }
FLEET_EOF
&& mv ~/.fleet/state.json.tmp ~/.fleet/state.json
```

The `mv` (rename) on the same filesystem is atomic per POSIX `rename(2)`,
meaning readers will always see either the complete old state or the complete
new state -- never a partially written file. This is safe on ext4, XFS, ZFS,
and other standard Linux filesystems. **NFS or other networked filesystems may
not guarantee atomicity** for rename operations.

See `src/state/state.ts:74-91` for the implementation.

### Immutable data pattern

`removeStack` does not mutate the input state object. Instead, it uses the
spread operator to return a shallow copy without the removed stack:

```typescript
const { [name]: _, ...remainingStacks } = state.stacks;
return { ...state, stacks: remainingStacks };
```

This immutable pattern makes state transitions explicit and testable. Callers
must still call `writeState` to persist the change -- the separation of
in-memory transformation from persistence is intentional.

## Concurrency and locking

**Fleet has no file-level locking mechanism for `state.json`.** The
read-then-modify-then-write pattern in `readState`/`writeState` is not atomic
as a unit. If two Fleet processes target the same server simultaneously, the
following race condition is possible:

1. Process A reads state (version N)
2. Process B reads state (version N)
3. Process A writes state (version N+1)
4. Process B writes state (version N+1'), overwriting A's changes

In practice, Fleet is designed as a single-operator CLI tool where concurrent
deployments to the same server are uncommon. The deploy pipeline does not
guard against this at the application level. If you run Fleet from CI/CD, you
should ensure that only one deployment job targets a given server at any time
(e.g., using CI/CD concurrency groups or job-level mutex locks).

## Validation

State is validated on every read using [Zod](https://zod.dev) (v4). The Zod
schema is defined in `src/state/state.ts:5-38` and enforces the structure
documented in the [State Schema Reference](./schema-reference.md):

- `fleet_root`: string (may be empty on fresh state)
- `caddy_bootstrapped`: boolean
- `stacks`: record of stack name to `StackState`

Each `StackState` contains routes (validated as objects with `host`, `service`,
`port`, and `caddy_id` fields) and optional service-level metadata.

Zod validation errors are surfaced as a single joined `Error` message
containing all issue descriptions. This means a corrupted state file that
passes JSON parsing but fails schema validation will produce a clear,
actionable error message.

### Performance impact

Zod v4 (used by Fleet per `package.json`) is significantly faster than Zod v3.
For the typical state file size (a few KB for most deployments), validation
overhead is negligible -- well under 1ms.

## Schema evolution and backward compatibility

The Zod schema in `src/state/state.ts:12-23` marks several `ServiceState`
fields as `.optional()`:

- `image`
- `image_digest`
- `env_hash`
- `skipped_at` (nullable and optional)
- `one_shot`

These fields were added in later Fleet versions. Older state files that lack
them will still pass Zod validation. See the
[State Data Model](../env-secrets/state-data-model.md) for how `env_hash`
is used during environment change detection.

**Important caveat**: The TypeScript interface in `src/state/types.ts:10-19`
declares all `ServiceState` fields as required (non-optional). This means
TypeScript code consuming `ServiceState` assumes all fields are present, but
the Zod-validated data may lack the optional ones. In practice, this
discrepancy is handled at call sites -- for example,
`src/deploy/classify.ts:56` uses optional chaining (`stackState.services?.[name]`)
and `src/ps/ps.ts:150-172` has explicit fallback logic for pre-V1.2 state
without per-service data. See
[Service Classification and Hashing](../deploy/service-classification-and-hashing.md)
for how the classification module consumes state.

No formal migration mechanism exists for the state schema. When new fields are
added, they are made optional in the Zod schema for backward compatibility and
populated on the next deployment.

### Unknown field stripping

Zod's `z.object()` schemas use a **strip** strategy for unrecognized keys by
default (as opposed to `z.strictObject()` which rejects them, or
`z.looseObject()` which passes them through). This means that if a state file
contains fields added by a newer version of Fleet, an older Fleet CLI will:

1. Parse the file successfully (unknown fields do not cause validation errors).
2. **Silently drop** the unrecognized fields from the parsed result.
3. Write the stripped state back to disk on the next `writeState` call,
   **permanently removing** the newer fields.

This is a known limitation of the current design. In practice, it only
matters if you downgrade Fleet after deploying with a newer version, and then
run a command that writes state (deploy, stop, teardown). Read-only commands
(ps, logs, env, proxy status) do not write state and are safe.

To mitigate this risk:

- Back up the state file before downgrading Fleet (see the
  [operations guide](./operations-guide.md#backing-up-state)).
- Avoid running write-capable commands with an older Fleet version after
  deploying with a newer one.

## Cross-module dependencies

The state module is one of the most widely imported modules in Fleet. Nearly
every operational command depends on it:

| Consumer group | Read | Write | Purpose |
|---|---|---|---|
| [Deployment pipeline](../deployment-pipeline.md) | Yes | Yes | Read at step 3, write at step 16 |
| [Server bootstrap](../bootstrap/server-bootstrap.md) | Yes | Yes | Check/set `caddy_bootstrapped` |
| [Stack lifecycle](../stack-lifecycle/overview.md) | Yes | Yes | Stop/teardown remove stacks from state |
| [Process status](../process-status/overview.md) | Yes | No | Display stack and service info |
| [Proxy status/reload](../proxy-status-reload/overview.md) | Yes | No | Reconcile live Caddy routes with state |
| [Environment secrets](../env-secrets/overview.md) | Yes | No | Look up stack directory |
| [Service classification](../deploy/classification-decision-tree.md) | Yes | No | Compare stored hashes |
| [Validation](../validation/overview.md) | No | No | Does not directly consume state, but validates config that produces state |

The module also re-exports `ExecFn` and `ExecResult` from the
[SSH connection layer](../ssh-connection/overview.md), making
`import { ExecFn } from "../state"` a common pattern in the codebase.

## Related documentation

- [State schema reference](./schema-reference.md) -- full field-by-field
  documentation of all types
- [Operations guide](./operations-guide.md) -- how to inspect, back up, and
  recover state
- [State lifecycle](./state-lifecycle.md) -- how state flows through the
  deploy pipeline
- [Deploy Sequence](../deploy/deploy-sequence.md) -- state read at Step 3,
  write at Step 16
- [Deployment Troubleshooting](../deploy/troubleshooting.md) -- diagnosing
  state-related deploy failures
- [Bootstrap Troubleshooting](../bootstrap/bootstrap-troubleshooting.md) --
  state file corruption recovery
- [Fleet Root Resolution](../fleet-root/resolution-flow.md) -- how the
  `fleet_root` field is determined
- [SSH Connection Layer](../ssh-connection/overview.md) -- how `ExecFn`
  reads/writes state on the remote host
- [Proxy Status Troubleshooting](../proxy-status-reload/troubleshooting.md) --
  state file issues affecting proxy commands
- [Stack Lifecycle Overview](../stack-lifecycle/overview.md) -- how stop and
  teardown modify state
- [Configuration Overview](../configuration/overview.md) -- `fleet.yml`
  configuration that drives state creation
- [Proxy Status](../proxy-status-reload/proxy-status.md) -- how live Caddy
  routes are compared against state
- [Fleet Root Directory Layout](../fleet-root/directory-layout.md) -- on-server
  directory structure referenced by `fleet_root`
- [State Data Model](../env-secrets/state-data-model.md) -- how environment
  hashing and per-service state fields are structured
- [Change Detection Overview](../deploy/change-detection-overview.md) -- how
  stored hashes in state drive selective redeployment
- [Service Classification and Hashing](../deploy/service-classification-and-hashing.md) --
  how content hashes are computed and compared against state
- [Compose Queries](../compose/queries.md) -- how service metadata is extracted
  from Docker Compose files and stored in state
- [Caddy Admin API](../caddy-proxy/caddy-admin-api.md) -- how Caddy route
  state tracked in `state.json` is applied via the admin API
- [Fleet Configuration Checks](../validation/fleet-checks.md) -- validation
  rules for configuration that produces state
- [Validation Codes Reference](../validation/validation-codes.md) -- catalog
  of codes triggered by state-affecting configuration issues
- [Security Model](../env-secrets/security-model.md) -- security implications
  of the state file and secrets stored on the remote host
