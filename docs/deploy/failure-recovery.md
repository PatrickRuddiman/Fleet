# Failure Recovery and Partial Deploys

## What This Covers

The deployment pipeline wraps all 17 steps in a single `try/catch/finally` block
at `src/deploy/deploy.ts:400-411`. There is no per-step rollback, no
transactional semantics, and no automatic retry. This page explains exactly what
state the server is left in when a failure occurs at each stage, and how to
recover.

## Why There Is No Per-Step Rollback

The pipeline executes a linear sequence of side effects across two systems (local
filesystem reads and remote SSH commands). Rolling back Docker container state,
Caddy route configuration, and file uploads atomically across an SSH connection
would require a distributed transaction protocol that adds significant complexity
for marginal benefit. Instead, Fleet is designed to be **re-runnable**: fixing the
root cause and running `fleet deploy` again is the intended recovery path. See
the [Deployment Pipeline Overview](../deployment-pipeline.md) for the full
17-step sequence.

## The try/catch/finally Pattern

```
try {
    // Steps 1-17
} catch (error) {
    console.error(`Deploy failed: ${error.message}`);
    process.exit(1);
} finally {
    if (connection) {
        await connection.close();
    }
}
```

The `finally` block guarantees the SSH connection is closed regardless of
whether the deploy succeeds or fails. No other cleanup is performed.

## State After Failure at Each Step

### Steps 1-4: Pre-Connection and Validation

**Server state**: Unchanged. These steps only read local files and perform
validation. No SSH commands are executed (Step 2 establishes the connection but
does not modify the server).

**Recovery**: Fix the validation error or host collision in `fleet.yml` and
re-run `fleet deploy`. See also the
[Validation Overview](../validation/overview.md) for details on pre-flight
checks.

### Step 5: Proxy Bootstrap

**Server state**: Partially bootstrapped. The `fleet-proxy` Docker network may
have been created, the proxy compose file may have been written, and the Caddy
container may have been started -- but the `caddy_bootstrapped` flag in state
has not been set (state is only written at Step 16).

**Recovery**: Re-run `fleet deploy`. The bootstrap function checks each
prerequisite independently:
- Network creation uses `2>/dev/null || true` and is idempotent
- `docker compose up -d` is idempotent if the container already exists
- The Caddy bootstrap POST via `/load` is idempotent (replaces the full config)

On re-run, since `caddy_bootstrapped` is still `false`, the entire bootstrap
sequence re-executes.

### Steps 6-8: Directory and File Upload

**Server state**: The stack directory exists, and compose/fleet.yml files may
have been partially written. The atomic `.tmp` + `mv` pattern means either the
complete file exists at the target path or it does not (the `.tmp` file may
remain if `mv` was not reached).

**Recovery**: Re-run `fleet deploy`. File uploads overwrite existing files.
Leftover `.tmp` files are harmless and will be overwritten on the next attempt.

### Step 9: Secret Resolution

**Server state**: The `.env` file may or may not have been written. If the
Infisical CLI bootstrap failed, the CLI may be partially installed.

**Recovery**: Re-run `fleet deploy`. The Infisical bootstrap checks for an
existing installation before attempting to install. Secret resolution overwrites
the `.env` file completely. See
[Secrets Resolution](secrets-resolution.md) for details on how secrets are
written to the server.

### Step 10: Service Classification

**Server state**: Unchanged. Classification is a read-only comparison of computed
hashes against stored state. No remote commands modify server state.

**Recovery**: Not applicable -- classification failures indicate a programming
error.

### Step 11: Image Pull

**Server state**: Some images may have been pulled, others not. Disk space has
been consumed by partially pulled images.

**Recovery**: Re-run `fleet deploy`. Docker handles partial pulls gracefully --
layers already downloaded are reused. If disk space is an issue, run
`docker system prune` on the remote server before retrying.

### Step 12: Container Start (Critical Phase)

**Server state**: This is the most impactful failure point. Some containers may
be running with the new configuration while others have not been started. In
selective mode, the pipeline starts services one at a time, so a failure leaves
a mix of updated and stale containers.

**Key risk**: Containers are running but state has not been written (Step 16).
This means:
- The next `fleet deploy` will see stale hashes in `state.json`
- Service classification on the next run may redundantly redeploy services
  that are already running the new version
- `fleet ps` may show stale deployment timestamps

**Recovery**: Re-run `fleet deploy --force`. Force mode bypasses classification
and redeploys all services, ensuring a consistent state. Alternatively, re-run
`fleet deploy` without `--force` -- the pipeline will compute fresh hashes
and may redundantly deploy already-updated services, but the end state will be
correct.

### Step 13: Network Attachment

**Server state**: Some containers may not be connected to the `fleet-proxy`
network. These containers are running but unreachable from the Caddy reverse
proxy.

**Recovery**: Re-run `fleet deploy`. Network attachment is idempotent ("already
connected" errors are silently ignored).

### Step 14: Health Checks

**Server state**: All containers are running and attached to the network. Health
check timeouts add warnings but do not fail the deploy. A true failure here
would be an unexpected error from `docker exec`.

**Recovery**: If a health check timeout is the concern (warning, not failure),
investigate the service logs with `fleet logs {stack}`. If `docker exec` itself
fails, the container may have crashed -- check `docker ps -a` and
`docker logs {container}` on the remote server.

### Step 15: Route Registration

**Server state**: Some Caddy routes may have been registered, others not. The
delete-then-post pattern means a route that was deleted but not re-added leaves
that domain unreachable.

**Recovery**: Re-run `fleet deploy`. Route registration performs delete-then-add
for each route, so re-running produces the correct final state. Alternatively,
use `fleet proxy reload` to re-register all routes from the current state.
See [Proxy Status and Route Reload](../proxy-status-reload/overview.md) for
details on how `fleet proxy reload` works.

### Step 16: State Write

**Server state**: Everything is deployed and running, but `state.json` does not
reflect the current deployment. This is the gap described in Question 2 from the
exploration findings.

**Recovery**: Re-run `fleet deploy`. The pipeline reads the (stale) state,
recomputes hashes, and writes updated state. In the worst case, some services
may be redundantly restarted because their hashes in state do not match their
actual running state.

### Step 17: Summary Print

**Server state**: Fully deployed and state is written. A failure here (e.g.,
stdout write error) is cosmetic.

**Recovery**: None needed. The deployment is complete.

## State Inconsistency Window

The most significant design limitation is the gap between container start
(Step 12) and state write (Step 16). During steps 12-15, the server has running
containers whose state is not recorded in `state.json`. If any step in this
window fails:

1. Containers may be running with configurations that `state.json` does not
   reflect
2. The next `fleet deploy` (without `--force`) may make incorrect classification
   decisions because stored hashes are stale
3. `fleet ps` and `fleet proxy status` may show outdated information

There is no reconciliation logic that compares running containers against stored
state. The `state.json` file is treated as the source of truth for the
classification system, even when it may be stale.

## Manual Recovery Procedures

For situations where re-running `fleet deploy` is not sufficient:

### Inspect the Remote State

```bash
# SSH into the server and check the state file
ssh user@server "cat ~/.fleet/state.json | jq"
```

### Check Running Containers

```bash
# Via fleet CLI
fleet ps {stack-name}

# Or directly on the server
ssh user@server "docker compose -p {stack-name} -f {fleet-root}/stacks/{stack-name}/compose.yml ps"
```

### Force a Clean Redeploy

```bash
fleet deploy --force
```

### Manual State Reset

As a last resort, delete the state file and redeploy:

```bash
ssh user@server "rm ~/.fleet/state.json"
fleet deploy --force
```

This forces a full bootstrap and deploy from scratch. All stacks will need to be
redeployed because the state file no longer tracks any existing deployments.

## Related Pages

- [17-Step Deploy Sequence](deploy-sequence.md)
- [Troubleshooting](troubleshooting.md) -- common issues, debugging commands,
  and recovery procedures
- [Deployment Pipeline Overview](../deployment-pipeline.md)
- [State Management Schema](../state-management/schema-reference.md) -- the
  structure of `state.json` referenced throughout this page
- [Stack Lifecycle Failure Modes](../stack-lifecycle/failure-modes.md) --
  failure recovery for stop, restart, and teardown operations
- [Proxy Status and Route Reload](../proxy-status-reload/overview.md) --
  inspecting and repairing Caddy route state
- [State Lifecycle](../state-management/state-lifecycle.md) -- how state
  flows through the deploy pipeline and the implications for failure recovery
