# Deployment Troubleshooting

## What This Covers

A consolidated reference for diagnosing and resolving deployment failures. Each
section maps a symptom to its likely cause and resolution. For step-by-step
failure analysis, see [Failure Recovery](failure-recovery.md).

## Quick Diagnostic Checklist

Before diving into specific errors, verify these common prerequisites:

```bash
# 1. Can you SSH to the server?
ssh user@server "echo ok"

# 2. Is Docker running?
ssh user@server "docker info"

# 3. Is Docker Compose V2 available?
ssh user@server "docker compose version"

# 4. Is the fleet-proxy container running?
ssh user@server "docker ps --filter name=fleet-proxy"

# 5. What does fleet state look like?
ssh user@server "cat ~/.fleet/state.json | jq"
```

## Error Messages and Resolutions

### Validation Errors (Step 1)

**Symptom**: Deploy exits immediately with one or more `[code] message` lines
under "Validation errors:".

**Source**: `src/deploy/deploy.ts:51-57`

**Resolution**: Fix the `fleet.yml` or `compose.yml` issues described in the
error codes. See [Validation Codes Reference](../validation/validation-codes.md) for
the full catalog of codes. Common issues:

| Error Pattern | Likely Cause |
|--------------|-------------|
| Missing required field | `fleet.yml` is incomplete |
| Invalid port/domain format | Typo in route configuration |
| Service referenced in routes not found in compose | Mismatch between `fleet.yml` routes and compose service names |

### Host Collision (Step 4)

**Symptom**: `Host collisions detected: {domain} is already owned by stack "{other}"`.

**Source**: `src/deploy/deploy.ts:80-88`

**Resolution**: Either:
- Remove the domain from the other stack first (`fleet teardown {other}`)
- Choose a different domain for this stack
- If the other stack is stale, manually clean up `state.json` on the server:
  ```bash
  ssh user@server "cat ~/.fleet/state.json | jq"
  # Edit state.json to remove the stale stack entry, then re-deploy
  ```

### Failed to Start Proxy (Step 5)

**Symptom**: `Failed to start proxy: {stderr}`.

**Source**: `src/deploy/helpers.ts:114-116`

**Causes and resolutions**:

| Cause | Resolution |
|-------|-----------|
| Port 80 or 443 already in use | Stop the conflicting process (`sudo lsof -i :80`, `sudo lsof -i :443`) |
| Docker daemon not running | `sudo systemctl start docker` |
| Insufficient permissions | Ensure the SSH user is in the `docker` group |

### Failed to Bootstrap Caddy (Step 5)

**Symptom**: `Failed to bootstrap Caddy: {stderr}`.

**Source**: `src/deploy/helpers.ts:123-125`

This means the Caddy container started but the POST to `/load` failed.

**Resolution**:
```bash
# Check if the Caddy container is actually running
ssh user@server "docker ps --filter name=fleet-proxy"

# Check Caddy logs for startup errors
ssh user@server "docker logs fleet-proxy --tail 50"

# Try the bootstrap command manually
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/config/"
```

### Failed to Create Stack Directory (Step 6)

**Symptom**: `Failed to create stack directory: {stderr}`.

**Source**: `src/deploy/deploy.ts:122-126`

**Causes**: Permission denied on the fleet root directory, or disk full.

**Resolution**:
```bash
# Check disk space
ssh user@server "df -h"

# Check fleet root permissions
ssh user@server "ls -la /opt/fleet"   # or ~/fleet
```

### Failed to Upload File (Steps 7, 8, 9)

**Symptom**: `Failed to upload file to {path}: command exited with code {N} -- {stderr}`.

**Source**: `src/deploy/helpers.ts:156-161` (heredoc), `src/deploy/helpers.ts:186-191` (base64)

| Cause | Resolution |
|-------|-----------|
| Disk full | Free space with `docker system prune -af` or remove old stack directories |
| Permission denied | Ensure the SSH user owns the stack directory |
| `base64` command not found | Install `coreutils` on the remote server (unlikely on standard distros) |

### env.file Not Found (Step 9)

**Symptom**: `env.file not found: {path} (resolved to {absolute})`.

**Source**: `src/deploy/helpers.ts:221-225`

**Resolution**: Verify the `env.file` path in `fleet.yml` is correct and
relative to the `fleet.yml` directory. Check that the file exists locally before
deploying.

### Path Traversal Rejected (Step 9)

**Symptom**: `env.file path "{path}" resolves outside the project directory -- path traversal is not allowed`.

**Source**: `src/deploy/helpers.ts:216-220`

**Resolution**: The `env.file` path must resolve to a location within or at the
same level as the `fleet.yml` directory. Paths like `../../secrets/.env` are
rejected. Move the file into the project directory or use Infisical instead.

### Failed to Install Infisical CLI (Step 9)

**Symptom**: `Failed to install Infisical CLI: command exited with code {N}`.

**Source**: `src/deploy/infisical.ts:19-24`

| Cause | Resolution |
|-------|-----------|
| Not a Debian/Ubuntu server | Install Infisical CLI manually (see [Integrations](integrations.md#infisical)) |
| No outbound HTTPS to `dl.cloudsmith.io` | Allow firewall access or pre-install the CLI |
| `sudo` not available or password required | Configure passwordless sudo for the deploy user, or pre-install |
| `apt-get` lock held by another process | Wait and retry, or kill the blocking process |

### Infisical CLI Installation Could Not Be Verified (Step 9)

**Symptom**: `Infisical CLI installation could not be verified: command exited with code {N}`.

**Source**: `src/deploy/infisical.ts:28-33`

The install command succeeded (exit code 0) but `infisical --version` still
fails. This may indicate a PATH issue or a corrupted installation.

**Resolution**:
```bash
ssh user@server "which infisical"
ssh user@server "infisical --version"
ssh user@server "ls -la /usr/bin/infisical"
```

### Failed to Export Secrets via Infisical CLI (Step 9)

**Symptom**: `Failed to export secrets via Infisical CLI: {stderr}`.

**Source**: `src/deploy/helpers.ts:273-277`

| Cause | Resolution |
|-------|-----------|
| Invalid or expired token | Rotate the Infisical token and update `$INFISICAL_TOKEN` |
| Wrong project ID | Verify `project_id` in `fleet.yml` matches the Infisical dashboard |
| Wrong environment/path | Verify `environment` and `path` in the Infisical configuration |
| No outbound HTTPS to Infisical API | Allow `app.infisical.com` (or self-hosted URL) through the firewall |

### Failed to Pull Images (Step 11)

**Symptom**: `Failed to pull images: {stderr}` or
`Failed to pull image for service {name}: {stderr}`.

**Source**: `src/deploy/helpers.ts:609-611` (force), `src/deploy/helpers.ts:628-630` (selective)

| Cause | Resolution |
|-------|-----------|
| Image not found in registry | Verify the image reference in `compose.yml` |
| Authentication required | Set up Docker registry credentials on the server (`docker login`) |
| Network unreachable | Check outbound access to the container registry |
| Disk full | `docker system prune -af` |

### Failed to Start/Deploy/Restart Containers (Step 12)

**Symptom**: `Failed to start containers: {stderr}`,
`Failed to deploy service {name}: {stderr}`, or
`Failed to restart service {name}: {stderr}`.

**Source**: `src/deploy/deploy.ts:231-233` (force), `src/deploy/deploy.ts:240-242` (selective deploy),
`src/deploy/deploy.ts:249-251` (selective restart)

**Debugging**:
```bash
# Check container status
ssh user@server "docker compose -p {stackName} -f {stackDir}/compose.yml ps -a"

# Check container logs
ssh user@server "docker compose -p {stackName} -f {stackDir}/compose.yml logs {service} --tail 50"

# Check if the .env file is valid
ssh user@server "cat {stackDir}/.env"
```

Common causes: invalid environment variable references in compose, port
conflicts between services, image entrypoint failures.

### Failed to Remove Orphaned Containers (Step 12)

**Symptom**: `Failed to remove orphaned containers: {stderr}`.

**Source**: `src/deploy/deploy.ts:258-260`

This runs `docker compose up -d --remove-orphans --no-recreate` to clean up
containers for services removed from the compose file. Failures here are
unusual.

**Resolution**: Check if any containers are in an unremovable state:
```bash
ssh user@server "docker ps -a --filter label=com.docker.compose.project={stackName}"
```

### Failed to Connect Container to fleet-proxy Network (Step 13)

**Symptom**: `Failed to connect {container} to fleet-proxy: {stderr}`.

**Source**: `src/deploy/helpers.ts:310-313`

Note: "already connected" and "already exists" errors are silently ignored.
This error means something else went wrong.

| Cause | Resolution |
|-------|-----------|
| Container not running | Check `docker ps -a`; the container may have crashed after Step 12 |
| fleet-proxy network does not exist | The proxy bootstrap may have failed; re-run with `--force` |

### Health Check Warnings (Step 14)

**Symptom**: Warning in the deploy summary:
`Health check timed out for {container}{path} after {N}s (last status: {status})`.

**Source**: `src/deploy/helpers.ts:355`

Health check timeouts produce warnings, not failures. The deploy continues. See
[Health Checks](health-checks.md#interpreting-health-check-warnings) for a
table of status codes and their meanings.

**Debugging**:
```bash
# Test the health endpoint manually
ssh user@server "docker exec {stackName}-{service}-1 curl -v http://localhost:{port}{path}"

# Check if curl exists in the container
ssh user@server "docker exec {stackName}-{service}-1 which curl"

# Check container logs for application errors
ssh user@server "docker logs {stackName}-{service}-1 --tail 50"
```

### Failed to Register Route (Step 15)

**Symptom**: `Failed to register route for {domain}: {stderr}`.

**Source**: `src/deploy/helpers.ts:388-392`

The Caddy admin API rejected the route registration. This usually means the
Caddy container is not responding or the route JSON is malformed.

**Debugging**:
```bash
# Check Caddy is running
ssh user@server "docker ps --filter name=fleet-proxy"

# Test Caddy admin API
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/config/ | jq"

# Check Caddy logs
ssh user@server "docker logs fleet-proxy --tail 50"
```

## Operational Issues

### 502 Bad Gateway After Deploy

The route is registered in Caddy but the upstream container is unreachable.

**Checklist**:
1. Is the container running?
   ```bash
   ssh user@server "docker ps --filter name={stackName}-{service}-1"
   ```
2. Is the container on the fleet-proxy network?
   ```bash
   ssh user@server "docker network inspect fleet-proxy --format '{{json .Containers}}' | jq"
   ```
3. Is the application listening on the expected port?
   ```bash
   ssh user@server "docker exec {stackName}-{service}-1 curl -s http://localhost:{port}/"
   ```

### TLS Certificate Not Issued

Caddy obtains certificates automatically via ACME (Let's Encrypt).

**Checklist**:
1. Does DNS for the domain point to the server?
   ```bash
   dig +short {domain}
   ```
2. Are ports 80 and 443 reachable from the internet? (required for ACME challenges)
3. Check Caddy logs for ACME errors:
   ```bash
   ssh user@server "docker logs fleet-proxy 2>&1 | grep -i 'acme\|certificate\|tls'"
   ```
4. Are you hitting Let's Encrypt rate limits? See
   [Rate Limits](https://letsencrypt.org/docs/rate-limits/).

### Stale State After Interrupted Deploy

If a deploy failed between Step 12 (container start) and Step 16 (state write),
`state.json` does not reflect the actual running containers. See
[State Inconsistency Window](failure-recovery.md#state-inconsistency-window) and
[State Management Overview](../state-management/overview.md) for state mechanics.

**Resolution**: Re-run `fleet deploy --force` to reconcile state.

### Ghost Routes in Caddy

Routes present in Caddy but not in `state.json` -- usually left over from a
failed teardown or manual testing. See also
[Proxy Status and Reload Troubleshooting](../proxy-status-reload/troubleshooting.md)
for ghost route handling.

**Diagnosis**:
```bash
fleet proxy status
```

**Resolution**:
```bash
# Remove a specific ghost route
ssh user@server "docker exec fleet-proxy curl -X DELETE http://localhost:2019/id/{stackName}__{serviceName}"

# Or re-register all routes from state
fleet proxy reload
```

### Missing Routes in Caddy

Routes expected in `state.json` but absent from Caddy -- usually caused by a
Caddy container restart without the `--resume` flag loading saved config.

**Diagnosis**:
```bash
fleet proxy status
```

**Resolution**:
```bash
fleet proxy reload
```

### Slow Deploys

The deployment pipeline executes one SSH round-trip per command, and many
operations are sequential.

**Common causes of slow deploys**:

| Phase | Bottleneck | Mitigation |
|-------|-----------|-----------|
| Step 10 | Hash computation (one `docker image inspect` per service) | Use `--force` to skip classification when you know everything changed |
| Step 11 | Image pulls over slow network | Use `--skip-pull` if images are pre-pulled |
| Step 12 | Selective mode starts services one at a time | Use `--force` for batch startup |
| Step 14 | Health check polling waits for timeout on unhealthy services | Use `--no-health-check` or reduce `timeout_seconds` |
| SSH latency | Every `exec()` call is a round-trip | Deploy from a machine with low latency to the server |

### Dry Run Started the Proxy

The `--dry-run` flag exits after Step 5, but proxy bootstrap (Step 5) executes
before the exit point. If the proxy was not previously bootstrapped, a dry run
creates the Docker network and starts the Caddy container.

This is a known design limitation. The proxy bootstrap is not rolled back on
dry-run exit.

**Resolution**: This is harmless -- the proxy running on the server does not
affect any stacks until routes are registered. If you need to remove it:
```bash
ssh user@server "docker compose -f {fleetRoot}/proxy/compose.yml down"
ssh user@server "docker network rm fleet-proxy"
```

### Container Keeps Restarting (One-Shot Services)

Services with `restart: "no"` or `restart: on-failure` are classified as
"one-shot" and are always redeployed on every `fleet deploy`. If you see a
service that runs, exits, and shows as "run" in the summary every time, this is
expected behavior.

If the service is failing:
```bash
ssh user@server "docker logs {stackName}-{service}-1 --tail 50"
```

## Server Inspection Commands

### Full State Dump

```bash
ssh user@server "cat ~/.fleet/state.json | jq"
```

### List All Fleet-Managed Containers

```bash
ssh user@server "docker ps --filter label=com.docker.compose.project --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
```

### Inspect the fleet-proxy Network

```bash
ssh user@server "docker network inspect fleet-proxy"
```

### View All Caddy Routes

```bash
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq"
```

### Check Disk Usage

```bash
ssh user@server "df -h && echo '---' && docker system df"
```

### View Stack Directory Contents

```bash
ssh user@server "ls -la {fleetRoot}/stacks/{stackName}/"
```

### Check .env File Existence and Permissions

```bash
ssh user@server "ls -la {fleetRoot}/stacks/{stackName}/.env"
```

## Nuclear Recovery

When all else fails, reset the server to a clean state:

```bash
# 1. Stop and remove all fleet-managed containers
ssh user@server "docker compose -p {stackName} -f {stackDir}/compose.yml down"

# 2. Stop the proxy
ssh user@server "docker compose -f {fleetRoot}/proxy/compose.yml down"

# 3. Remove the fleet-proxy network
ssh user@server "docker network rm fleet-proxy 2>/dev/null || true"

# 4. Delete the state file
ssh user@server "rm -f ~/.fleet/state.json"

# 5. Optionally clean up Docker artifacts
ssh user@server "docker system prune -af"

# 6. Redeploy from scratch
fleet deploy --force
```

This forces a full bootstrap and redeploy. All stacks must be redeployed because
the state file no longer tracks any existing deployments.

## Related Pages

- [Failure Recovery and Partial Deploys](failure-recovery.md)
- [17-Step Deploy Sequence](deploy-sequence.md)
- [Caddy Route Management](caddy-route-management.md)
- [Secrets Resolution](secrets-resolution.md)
- [Health Checks](health-checks.md)
- [Integrations Reference](integrations.md)
- [Deployment Pipeline Overview](../deployment-pipeline.md)
- [Bootstrap Troubleshooting](../bootstrap/bootstrap-troubleshooting.md) --
  bootstrap-specific failure modes
- [Proxy Status and Reload Troubleshooting](../proxy-status-reload/troubleshooting.md) --
  ghost routes, missing routes, and Caddy issues
- [Stack Lifecycle Failure Modes](../stack-lifecycle/failure-modes.md) --
  stop/restart/teardown failure recovery
- [Validation Codes Reference](../validation/validation-codes.md) -- all
  error and warning codes for Step 1 failures
- [State Management Overview](../state-management/overview.md) -- state file
  schema and recovery
- [SSH Connection Overview](../ssh-connection/overview.md) -- SSH connectivity
  troubleshooting
- [Environment and Secrets Overview](../env-secrets/overview.md) -- env
  push and Infisical troubleshooting
- [Caddy Proxy Troubleshooting](../caddy-proxy/troubleshooting.md) -- Caddy
  container and route issues
