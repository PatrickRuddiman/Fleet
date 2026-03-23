# State Operations Guide

This guide covers how to inspect, back up, recover, and troubleshoot Fleet's
server state file. All operations assume SSH access to the target server.

## Inspecting state

### View the full state file

```bash
ssh user@server "cat ~/.fleet/state.json"
```

For formatted output:

```bash
ssh user@server "cat ~/.fleet/state.json" | python3 -m json.tool
```

### Check if a specific stack exists

```bash
ssh user@server "cat ~/.fleet/state.json" | python3 -c "
import json, sys
state = json.load(sys.stdin)
stack = state.get('stacks', {}).get('my-app')
if stack:
    print(json.dumps(stack, indent=2))
else:
    print('Stack not found')
"
```

### Check bootstrap status

```bash
ssh user@server "cat ~/.fleet/state.json" | python3 -c "
import json, sys
state = json.load(sys.stdin)
print('Bootstrapped:', state.get('caddy_bootstrapped', False))
print('Fleet root:', state.get('fleet_root', '(not set)'))
"
```

### Use Fleet commands

The `fleet ps` command reads state and combines it with live Docker container
status:

```bash
fleet ps              # Show all stacks
fleet ps my-app       # Show a specific stack
```

## Backing up state

### Before destructive operations

Before running [`fleet teardown`](../stack-lifecycle/teardown.md) or
[`fleet stop`](../stack-lifecycle/stop.md), back up the state file:

```bash
ssh user@server "cp ~/.fleet/state.json ~/.fleet/state.json.backup"
```

### Automated backups

For CI/CD pipelines, capture state before and after deployments:

```bash
# Pre-deploy backup
ssh user@server "cp ~/.fleet/state.json ~/.fleet/state.json.pre-deploy"

# Run deployment
fleet deploy

# Post-deploy backup (optional)
ssh user@server "cp ~/.fleet/state.json ~/.fleet/state.json.post-deploy"
```

### Restoring from backup

```bash
ssh user@server "cp ~/.fleet/state.json.backup ~/.fleet/state.json"
```

Note that restoring state does not restore the actual Docker containers or
Caddy routes. It only restores Fleet's understanding of the deployment. You
may need to run `fleet deploy` or
[`fleet proxy reload`](../proxy-status-reload/route-reload.md) after restoring
to reconcile the actual server state with the restored state file.

## Recovery scenarios

### Scenario: State file deleted

**Symptom**: Fleet commands fail to find stacks or report empty state.

**What happens**: `readState` returns the default empty state when the file is
missing (`src/state/state.ts:50-52`). Fleet behaves as if the server has
never been deployed to.

**Recovery**:

1. If containers are still running, Fleet will re-register them on the next
   `fleet deploy` (since the missing state makes all services appear "new").
2. If you have a backup, restore it (see above).
3. If no backup exists, run `fleet deploy` for each stack. Fleet will
   re-classify all services as new, re-pull images, and re-register routes.

### Scenario: State file corrupted (invalid JSON)

**Symptom**: Fleet commands throw `"Failed to parse state file: invalid JSON
in ~/.fleet/state.json"`.

**What happens**: The JSON parsing step at `src/state/state.ts:56-62` throws.
All Fleet operations that read state are blocked.

**Recovery**:

1. **Fix the JSON**: SSH into the server and manually repair the file.
   ```bash
   ssh user@server "cat ~/.fleet/state.json"
   # Identify and fix the JSON syntax error
   ssh user@server "vi ~/.fleet/state.json"
   ```

2. **Delete and redeploy**: If the file is beyond repair:
   ```bash
   ssh user@server "rm ~/.fleet/state.json"
   ```
   Then run `fleet deploy` for each stack.

### Scenario: State file has valid JSON but invalid schema

**Symptom**: Fleet throws `"Invalid state file structure: ~/.fleet/state.json
-- ..."` with Zod validation error details.

**What happens**: The Zod schema validation at `src/state/state.ts:64-69`
rejects the parsed data. This can happen if the file was manually edited
with incorrect field types or missing required fields.

**Recovery**:

1. Check the error message for which fields are invalid.
2. SSH into the server and fix the offending fields.
3. Refer to the [schema reference](./schema-reference.md) for the correct
   field types and structure.

### Scenario: State says `caddy_bootstrapped: true` but Caddy is down

**Symptom**: Route registration fails during deployment because the Caddy
container is not running.

**Recovery**:

1. Check if the Caddy container exists:
   ```bash
   ssh user@server "docker ps -a --filter name=fleet-proxy"
   ```

2. If the container exists but is stopped, restart it:
   ```bash
   ssh user@server "docker start fleet-proxy"
   ```

3. If the container does not exist, reset the bootstrap flag and redeploy:
   ```bash
   ssh user@server "cat ~/.fleet/state.json" | \
     python3 -c "import json,sys; s=json.load(sys.stdin); s['caddy_bootstrapped']=False; print(json.dumps(s,indent=2))" | \
     ssh user@server "cat > ~/.fleet/state.json"
   ```
   Then run `fleet deploy`, which will re-bootstrap Caddy.

### Scenario: State references stacks that no longer exist on disk

**Symptom**: `fleet ps` shows stacks, but their containers are gone.

**What happens**: Fleet reads state metadata but `docker compose ps` fails for
the missing stack. The `ps` command gracefully degrades to showing route-based
service info with "unknown" status (`src/ps/ps.ts:118-128`).

**Recovery**: Remove the stale stack from state using `fleet teardown` or by
manually editing the JSON to remove the stack entry from the `stacks` object.

### Scenario: Partial deployment failure left state inconsistent

**Symptom**: State does not reflect containers that are actually running, or
vice versa.

**What happens**: The deploy pipeline writes state only at step 16
(`src/deploy/deploy.ts:367-385`). If a failure occurs between step 12
(starting containers) and step 16 (writing state), containers may be running
but state is stale.

**Recovery**: Run `fleet deploy` again. The classification logic will detect
the existing containers and their hashes, and the pipeline will reconcile
state with reality. If `--force` is needed to bypass hash comparisons, use
`fleet deploy --force`.

## Disk space and the `.tmp` file

The atomic write pattern creates a temporary file (`~/.fleet/state.json.tmp`)
that is renamed on success. If a write operation is interrupted (e.g., SSH
disconnect, disk full), the `.tmp` file may be left behind. This file is
harmless and will be overwritten on the next successful write. To clean up
manually:

```bash
ssh user@server "rm -f ~/.fleet/state.json.tmp"
```

If the disk is full, the write will fail with a non-zero exit code, and Fleet
will throw with the error details including stderr output. Free disk space
and retry the operation.

## SSH connection drops during write

The atomic write pattern (tmp + mv) means that if the SSH connection drops:

- **During the heredoc write**: The `.tmp` file may contain partial data, but
  the original `state.json` is untouched. The next `writeState` call will
  overwrite the `.tmp` file.
- **After the mv**: The state was successfully written before the connection
  dropped. No data loss.
- **Between the write and mv**: The `.tmp` file contains the complete new
  state, but the rename did not execute. The original `state.json` remains.
  On the next write, the `.tmp` file will be overwritten.

In all cases, `state.json` either contains the complete old state or the
complete new state. Partial writes are never visible to readers.

## Filesystem compatibility

The atomic write relies on POSIX `rename(2)` semantics, which guarantee
atomicity when source and destination are on the same filesystem. This is
safe on:

- **ext4, XFS, ZFS, Btrfs**: Standard Linux server filesystems. Atomic.
- **tmpfs**: Atomic (same filesystem).
- **NFS**: May not guarantee atomicity. If your server's home directory is
  NFS-mounted, consider ensuring `~/.fleet/` is on a local filesystem.
- **FUSE-based filesystems**: Depends on the implementation. Most FUSE
  filesystems implement `rename` correctly.

## Integrations

### Zod validation

State is validated on every read using [Zod](https://zod.dev) v4. Validation
errors include all failing field descriptions joined into a single error
message. To debug validation failures:

1. Read the raw file: `ssh user@server "cat ~/.fleet/state.json"`
2. Compare against the [schema reference](./schema-reference.md)
3. Look for type mismatches (e.g., `port` as string instead of number) or
   missing required fields

### SSH execution layer

All state operations use the `ExecFn` abstraction from the
[SSH connection layer](../ssh-connection/overview.md). Troubleshooting:

- **SSH authentication failures**: Check `fleet.yml` for correct `host`,
  `port`, `user`, and `identity_file` values, or ensure `SSH_AUTH_SOCK` is
  set for agent-based authentication.
- **Command timeouts**: Neither `readState` nor `writeState` set timeouts on
  the underlying SSH exec call. A hanging command will block indefinitely.
  Check the remote server's responsiveness.
- **Permission errors**: The user specified in `fleet.yml` must have read/write
  access to `~/.fleet/`. On most servers, this is the SSH user's home
  directory and permissions are not an issue.

### Remote filesystem

The state file path (`~/.fleet/state.json`) is hardcoded. The `~` is expanded
by the remote shell to the SSH user's home directory. There is no
configuration option to change this path.

### Directory permissions

The `~/.fleet/` directory is created with `mkdir -p` (see
`src/state/state.ts:80`), which inherits the default `umask` of the SSH user's
session -- typically `0022`, resulting in `drwxr-xr-x` (755) permissions.
No explicit `chmod` is applied.

Requirements:

- The SSH user must have **read and write** access to `~/.fleet/` and its
  contents.
- On most Linux servers where the SSH user owns their home directory, this
  is satisfied automatically.
- If the home directory is root-owned or shared, ensure the SSH user's
  `umask` and directory ownership allow writing to `~/.fleet/`.

### State file versioning and history

Fleet does **not** maintain any built-in versioning or history of the state
file. Each `writeState` call overwrites the previous content atomically.
There is no rollback log, no version counter, and no previous-state backup.

If you need state history for auditing or recovery, implement it externally:

- **Manual snapshots**: Copy the state file before and after deployments
  (see [Backing up state](#backing-up-state) above).
- **CI/CD integration**: Capture `~/.fleet/state.json` as a build artifact
  in your deployment pipeline.
- **Filesystem-level snapshots**: On ZFS or Btrfs, use filesystem snapshots
  to capture the entire `~/.fleet/` directory at known-good points.

## Related documentation

- [State management overview](./overview.md) -- architecture and design
  decisions
- [State schema reference](./schema-reference.md) -- field-by-field
  documentation
- [State lifecycle](./state-lifecycle.md) -- how state flows through the
  deploy pipeline
- [Bootstrap Sequence](../bootstrap/bootstrap-sequence.md) -- how state is
  initialized during bootstrap (Steps 1 and 8)
- [Deploy Command](../cli-entry-point/deploy-command.md) -- how the deploy
  pipeline reads and writes state
- [Stack Lifecycle Operations](../stack-lifecycle/overview.md) -- stop and
  teardown operations that modify state
- [Process Status Troubleshooting](../process-status/troubleshooting.md) --
  state-related issues affecting `fleet ps` and `fleet logs`
- [Proxy Route Reload](../proxy-status-reload/route-reload.md) -- reconciling
  Caddy routes with state after recovery
- [SSH Connection Layer](../ssh-connection/overview.md) -- the `ExecFn`
  abstraction used for all state operations
- [Fleet Root Troubleshooting](../fleet-root/troubleshooting.md) -- diagnosing
  and resolving fleet root resolution issues
- [Security Model](../env-secrets/security-model.md) -- state file security
  properties and hardening recommendations
- [Deployment Pipeline](../deployment-pipeline.md) -- the full deploy workflow
  that reads and writes state
- [CI/CD Integration](../ci-cd-integration.md) -- capturing state as build
  artifacts in CI/CD pipelines
