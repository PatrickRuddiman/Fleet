# Fleet Directory Layout

The fleet root directory is the base path on the target server under which Fleet
organizes all deployment artifacts. For details on how the fleet root is
resolved, see [Fleet Root Overview](./overview.md) and
[Resolution Flow](./resolution-flow.md). Two constants in
`src/fleet-root/constants.ts` define the top-level subdirectory names:

| Constant     | Value      | Purpose                                          |
|-------------|------------|--------------------------------------------------|
| `PROXY_DIR`  | `"proxy"`  | Contains the Caddy reverse proxy compose file    |
| `STACKS_DIR` | `"stacks"` | Contains per-stack deployment directories         |

## Full directory tree

The following tree shows every file and directory that Fleet creates on the
target server. Paths are relative to the fleet root (either `/opt/fleet` or
`~/fleet`).

```
<fleet-root>/                          # /opt/fleet or ~/fleet
├── proxy/                             # PROXY_DIR constant
│   └── compose.yml                    # Caddy reverse proxy Docker Compose file
│
└── stacks/                            # STACKS_DIR constant
    └── <stack-name>/                  # One directory per deployed stack
        ├── compose.yml                # Uploaded Docker Compose file for the stack
        └── .env                       # Environment secrets file (if configured)
```

Additional files exist outside the fleet root:

```
~/.fleet-root                          # Single-line text file with the fleet root path
~/.fleet/
└── state.json                         # Fleet server state (JSON)
```

## Who creates what

| Path                                       | Created by                         | Source reference                         |
|-------------------------------------------|------------------------------------|------------------------------------------|
| `<fleet-root>/`                           | `resolveFleetRoot`                 | `src/fleet-root/resolve.ts:13` or `:34`  |
| `<fleet-root>/proxy/`                     | Bootstrap pipeline                 | `src/bootstrap/bootstrap.ts:46`          |
| `<fleet-root>/proxy/compose.yml`          | `writeProxyCompose`                | `src/proxy/compose.ts:33-51`             |
| `<fleet-root>/stacks/<name>/`             | Deploy pipeline (step 6)           | `src/deploy/deploy.ts:117-126`           |
| `<fleet-root>/stacks/<name>/compose.yml`  | Deploy pipeline (step 7)           | `src/deploy/deploy.ts:128-134`           |
| `<fleet-root>/stacks/<name>/.env`         | [`resolveSecrets`](../deploy/secrets-resolution.md) | `src/deploy/helpers.ts:198-287`          |
| `~/.fleet-root`                           | `resolveFleetRoot`                 | `src/fleet-root/resolve.ts:15` or `:41`  |
| `~/.fleet/state.json`                     | [`writeState`](../state-management/state-lifecycle.md#atomic-write-protocol) | `src/state/state.ts:74-91`              |

## How constants are used across the codebase

### `PROXY_DIR`

Imported by modules that need to locate or create the proxy configuration
directory:

- **`src/bootstrap/bootstrap.ts:46`** — creates `<fleet-root>/proxy/` during
  bootstrap.
- **`src/bootstrap/bootstrap.ts:57`** — references
  `<fleet-root>/proxy/compose.yml` to start the Caddy container.
- **`src/deploy/helpers.ts:109`** — constructs the proxy directory path during
  the deploy bootstrap step.
- **`src/proxy/compose.ts:38`** — uses `PROXY_DIR` to determine where to write
  the generated compose file.

### `STACKS_DIR`

Imported by the deployment pipeline to construct per-stack directories:

- **`src/deploy/deploy.ts:117`** — builds the stack directory as
  `<fleet-root>/stacks/<stack-name>` and creates it via `mkdir -p`.

## Stack name constraints

Stack directory names are governed by the `STACK_NAME_REGEX` in
`src/config/schema.ts:46`:

```
/^[a-z\d][a-z\d-]*$/
```

This ensures stack names:

- Start with a lowercase letter or digit
- Contain only lowercase letters, digits, and hyphens
- Produce valid directory names and Docker Compose project names

The regex is enforced during [configuration validation](../configuration/schema-reference.md)
and [project initialization](../project-init/overview.md). See
[Validation Troubleshooting](../validation/troubleshooting.md#invalid_stack_name)
for common stack name errors.

## Relationship between fleet root and state

The fleet root path is stored redundantly in two locations:

| Location                   | Format            | Written by              | Read by                              |
|---------------------------|-------------------|-------------------------|--------------------------------------|
| `~/.fleet-root`            | Plain text file   | `resolveFleetRoot`      | `readFleetRoot` (currently unused)   |
| `~/.fleet/state.json`      | JSON (`fleet_root` field) | Bootstrap / Deploy | All operational commands              |

During normal operations, the `FleetState.fleet_root` field from `state.json`
is the authoritative source. The `~/.fleet-root` file acts as a secondary
record. See the [overview](./overview.md) for details on this dual-storage
design.

## Inspecting the directory layout on a server

To examine Fleet's directory structure on a running server:

```bash
# View the fleet root path
cat ~/.fleet-root

# List the full directory tree
tree $(cat ~/.fleet-root)

# Or without tree installed
find $(cat ~/.fleet-root) -type f
```

For state inspection:

```bash
# View the full server state
cat ~/.fleet/state.json | python3 -m json.tool
```

## Related documentation

- [Fleet Root Overview](./overview.md) -- fleet root resolution and design
  decisions
- [Resolution Flow](./resolution-flow.md) -- step-by-step resolution logic
- [Fleet Root Troubleshooting](./troubleshooting.md) -- diagnosing fleet root
  issues
- [State Management Overview](../state-management/overview.md) -- the state
  file stored alongside the fleet root
- [State Schema Reference](../state-management/schema-reference.md) -- field-by-
  field state file documentation
- [Bootstrap Integrations](../bootstrap/bootstrap-integrations.md) -- how
  bootstrap creates the fleet root and proxy directory
- [Deploy Sequence](../deploy/deploy-sequence.md) -- how deployment creates
  stack directories under the fleet root
- [Secrets Resolution](../deploy/secrets-resolution.md) -- how `.env` files
  are written to stack directories
- [Proxy Docker Compose](../caddy-proxy/proxy-compose.md) -- the Caddy compose
  file stored under the proxy directory
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  `STACK_NAME_REGEX` and stack naming constraints
