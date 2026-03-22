# Troubleshooting Fleet Root Resolution

This page covers operational issues related to the fleet root directory, the
`~/.fleet-root` persistence file, and the remote filesystem interactions that
the `fleet-root` module performs.

## Common issues

### Permission denied during resolution

**Symptom**: `resolveFleetRoot` falls back to `~/fleet` instead of using
`/opt/fleet`.

**Cause**: The SSH user does not have write access to `/opt`. This is expected
on servers where Fleet connects as a non-root user (e.g., `ubuntu`, `deploy`,
`ec2-user`).

**How to verify**:

```bash
# SSH into the server and check
ls -la /opt
# If the user cannot write to /opt, the fallback is correct
```

**Resolution options**:

1. **Accept the fallback** — `~/fleet` works correctly for all Fleet operations.
   There is no functional difference between `/opt/fleet` and `~/fleet`.
2. **Grant `/opt` write access** — if you prefer the system-wide location:
    ```bash
    sudo mkdir -p /opt/fleet
    sudo chown $(whoami) /opt/fleet
    ```
    Then re-run `fleet deploy` to re-resolve the root.
3. **Connect as root** — set `user: root` in `fleet.yml`. This gives the SSH
   session write access to `/opt` but has broader security implications.

### Non-permission filesystem errors

**Symptom**: `resolveFleetRoot` throws `"Failed to create fleet root at
/opt/fleet: <error>"` without falling back.

**Cause**: The `mkdir -p /opt/fleet` command failed with an error that is not
a permission error. Common causes include:

- **Read-only filesystem**: the root partition or `/opt` is mounted read-only
- **Disk full**: no space left on the device
- **Filesystem corruption**: the underlying block device has errors

**How to diagnose**:

```bash
# Check filesystem status
df -h /opt
mount | grep "on /opt"

# Check for read-only mount
touch /opt/test-write && rm /opt/test-write
```

The error detection in `src/fleet-root/resolve.ts:6-9` specifically checks for
the strings "permission denied" and "operation not permitted" (case-insensitive).
Any other `stderr` content from a failed `mkdir` causes an immediate throw
rather than a fallback.

### Stale `~/.fleet-root` pointing to a deleted directory

**Symptom**: operations succeed at the SSH/state level but fail when trying to
write files to the fleet root directory.

**Cause**: the fleet root directory was manually deleted (e.g.,
`rm -rf /opt/fleet`) but `~/.fleet-root` and `~/.fleet/state.json` still
reference it.

**Why this happens**: `readFleetRoot` in `src/fleet-root/resolve.ts:45-50` reads
the `~/.fleet-root` file but does not validate that the path still exists on
disk. Similarly, the `FleetState.fleet_root` field in state is never
re-validated after initial storage.

**Resolution**:

```bash
# Option 1: Re-create the directory
mkdir -p $(cat ~/.fleet-root)

# Option 2: Delete the stale references and re-deploy
rm ~/.fleet-root
rm ~/.fleet/state.json
# Then run `fleet deploy` to re-resolve and re-bootstrap
```

**Note**: deleting `state.json` causes Fleet to lose knowledge of all deployed
stacks. The Caddy proxy and running containers will still exist on the server,
but Fleet will treat them as unknown. You would need to re-deploy each stack.
See [State Management Operations Guide](../state-management/operations-guide.md)
for instructions on inspecting and backing up state.

### Multiple Fleet installations on the same server

**Symptom**: deploying from one project overwrites the fleet root set by another.

**Cause**: `~/.fleet-root` is a per-user file with no project or stack scoping.
If the same SSH user manages multiple Fleet projects on the same server, the
last `resolveFleetRoot` call wins. However, this is normally harmless because:

1. The fleet root resolution is deterministic — given the same user permissions,
   it always resolves to the same path.
2. Multiple stacks coexist under `<fleet-root>/stacks/<stack-name>/`, each in
   their own directory.
3. The shared `~/.fleet/state.json` tracks all stacks in a single state object.

This only becomes a problem if you intentionally want different Fleet projects
to use different root directories on the same server, which is not currently
supported.

## Understanding the SSH user context

The entire permission-detection and fallback logic depends on which user the SSH
connection authenticates as. The SSH user is configured in `fleet.yml`:

```yaml
server:
  host: "your-server.example.com"
  port: 22
  user: "deploy"                    # defaults to "root" if omitted
  identity_file: "~/.ssh/id_ed25519"  # optional; uses SSH agent if omitted
```

Key details from the [SSH connection layer](../ssh-connection/overview.md):

- **`user`** defaults to `"root"` per `src/config/schema.ts:6`.
- **`identity_file`** is optional. When omitted, the SSH agent
  (`SSH_AUTH_SOCK`) is used for authentication.
- **`host`** values of `localhost` or `127.0.0.1` bypass SSH entirely and use
  local `child_process` execution.

When the SSH user is `root`, `/opt/fleet` is almost always writable. When the
user is non-root, the fallback to `~/fleet` is the expected behavior.

## Inspecting and resetting the fleet root

### Read the current fleet root

```bash
# From the ~/.fleet-root file
ssh user@server "cat ~/.fleet-root"

# From state.json (authoritative)
ssh user@server "cat ~/.fleet/state.json" | python3 -c "import sys,json; print(json.load(sys.stdin)['fleet_root'])"
```

### Reset the fleet root

To force Fleet to re-resolve the root directory:

```bash
ssh user@server "rm ~/.fleet-root"
# Edit or delete state.json to clear fleet_root
ssh user@server "rm ~/.fleet/state.json"
# Then re-deploy
fleet deploy
```

### Verify directory permissions

```bash
ssh user@server "ls -la $(cat ~/.fleet-root)"
ssh user@server "ls -la $(cat ~/.fleet-root)/proxy/"
ssh user@server "ls -la $(cat ~/.fleet-root)/stacks/"
```

## Filesystem error handling reference

The table below maps filesystem conditions to the behavior of `resolveFleetRoot`:

| Condition                        | Primary (`/opt/fleet`)          | Fallback (`~/fleet`)            |
|---------------------------------|----------------------------------|---------------------------------|
| Directory already exists         | Returns `/opt/fleet`             | N/A (primary succeeds)          |
| Permission denied on `/opt`      | Falls back to `~/fleet`          | Creates `~/fleet`               |
| Disk full                        | Throws error (no fallback)       | Throws error                    |
| Read-only filesystem             | Throws error (no fallback)       | Throws error                    |
| `$HOME` unresolvable             | N/A                              | Throws `"Failed to resolve home directory"` |
| Permission denied on `~/fleet`   | N/A                              | Throws error                    |

The permission-error detection (`src/fleet-root/resolve.ts:6-9`) matches
case-insensitively against:

- `"permission denied"`
- `"operation not permitted"`

Any other `stderr` content from a failed `mkdir -p` is treated as a
non-recoverable error.

## Related documentation

- [Fleet Root Overview](./overview.md) — module purpose and architecture
- [Directory Layout](./directory-layout.md) — full directory tree reference
- [Resolution Flow](./resolution-flow.md) — flowchart of the resolution logic
- [SSH Connection](../ssh-connection/overview.md) — how commands are executed
  on the remote host
- [SSH Authentication](../ssh-connection/authentication.md) — diagnosing SSH
  connection and permission issues
- [Server Bootstrap](../bootstrap/server-bootstrap.md) — the bootstrap sequence
  that calls `resolveFleetRoot`
- [State Management Schema](../state-management/schema-reference.md) — the
  `fleet_root` field in `state.json`
- [State Management Operations](../state-management/operations-guide.md) —
  inspecting, backing up, and recovering state
