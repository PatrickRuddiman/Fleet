# Bootstrap Troubleshooting

This page covers common failure modes during the [bootstrap process](./bootstrap-sequence.md) and how to
diagnose and recover from them. For the complete bootstrap flow, see
[Server Bootstrap](./server-bootstrap.md).

## Caddy Admin API health check timeout

**Error message:**

```
Caddy Admin API did not become healthy after 10 attempts (30s timeout)
```

**Source:** `src/bootstrap/bootstrap.ts:86-88`

**What happened:** The Caddy container started but the Admin API at
`http://localhost:2019/config/` did not respond with a 200 status within 30
seconds (10 attempts at 3-second intervals). See
[Caddy Admin API](../caddy-proxy/caddy-admin-api.md) for how Fleet communicates
with Caddy.

**Diagnosis steps:**

1. Check if the container is running:

    ```bash
    docker ps -f name=fleet-proxy
    ```

2. Check container logs for startup errors:

    ```bash
    docker logs fleet-proxy --tail 50
    ```

3. Check if the Admin API is listening inside the container:

    ```bash
    docker exec fleet-proxy curl -s http://localhost:2019/config/
    ```

4. Check if port 2019 is bound inside the container:

    ```bash
    docker exec fleet-proxy netstat -tlnp | grep 2019
    ```

**Common causes:**

- **Port conflict:** Another process on the server is using port 80 or 443,
  preventing Caddy from binding. Check with `ss -tlnp | grep -E ':80|:443'`.
- **Resource exhaustion:** The server lacks memory or CPU for the container.
  Check with `docker stats fleet-proxy` and `free -m`.
- **Corrupted Caddy config:** If `caddy run --resume` loads a corrupted
  saved config, Caddy may fail to start. Clear the config volume:
  `docker volume rm caddy_config` then retry.

**Recovery:**

1. Fix the underlying issue (free ports, add resources, clear corrupted config)
2. Remove the container if it exists: `docker rm -f fleet-proxy`
3. Set `caddy_bootstrapped` to `false` in `~/.fleet/state.json` (or delete the
   file)
4. Re-run the deploy

## Failed to start Caddy container

**Error message:**

```
Failed to start Caddy container: command exited with code {N} — {stderr}
```

**Source:** `src/bootstrap/bootstrap.ts:62-64`

**What happened:** `docker compose up -d` returned a non-zero exit code. See
[Proxy Docker Compose Configuration](../caddy-proxy/proxy-compose.md) for the
generated compose file details.

**Diagnosis steps:**

1. Run the compose command manually to see the full error:

    ```bash
    docker compose -f /opt/fleet/proxy/compose.yml -p fleet-proxy up -d
    ```

2. Check if the `fleet-proxy` network exists:

    ```bash
    docker network ls | grep fleet-proxy
    ```

3. Check if the Docker image can be pulled:

    ```bash
    docker pull caddy:2-alpine
    ```

**Common causes:**

- **Network does not exist:** The `fleet-proxy` network must exist before
  `compose up` because it is declared as `external: true`. The bootstrap
  sequence creates it in Step 2, but if that step silently failed (unlikely
  due to `|| true`), the compose will fail.
- **Image pull failure:** No internet access, Docker Hub rate limit, or DNS
  resolution failure on the server.
- **Docker daemon issues:** Docker daemon not running or out of disk space.

**Recovery:**

1. Ensure Docker is running: `systemctl status docker`
2. Create the network manually: `docker network create fleet-proxy`
3. Pull the image manually: `docker pull caddy:2-alpine`
4. Re-run the deploy

## Failed to create proxy directory

**Error message:**

```
Failed to create proxy directory: command exited with code {N} — {stderr}
```

**Source:** `src/bootstrap/bootstrap.ts:48-50`

**What happened:** `mkdir -p {fleetRoot}/proxy` failed.

**Common causes:**

- **Disk full:** No space to create directories
- **Filesystem read-only:** The filesystem may be mounted read-only
- **Permission denied:** The SSH user cannot write to the fleet root directory

**Recovery:**

1. Check disk space: `df -h`
2. Check filesystem mount: `mount | grep ' / '`
3. Check permissions on the fleet root: `ls -la /opt/fleet` or `ls -la ~/fleet`

## Failed to post initial Caddy configuration

**Error message:**

```
Failed to post initial Caddy configuration: command exited with code {N} — {stderr}
```

**Source:** `src/bootstrap/bootstrap.ts:97-99`

**What happened:** The `curl POST` to `http://localhost:2019/load` inside the
container failed.

**Common causes:**

- **Caddy API became unresponsive** between the health check (Step 6) and the
  config post (Step 7) -- this is a race condition but very unlikely.
- **Invalid JSON configuration** -- this should not happen since the config is
  generated programmatically, but a bug in `buildBootstrapCommand()` could
  cause it.

**Diagnosis:**

```bash
# Test the Admin API manually
docker exec fleet-proxy curl -s http://localhost:2019/config/ | jq

# Check Caddy logs for errors
docker logs fleet-proxy --tail 20
```

**Recovery:**

Re-run the deploy. The config POST replaces any existing configuration, so it
is safe to retry.

## State file corruption

**Error message:**

```
Failed to parse state file: invalid JSON in ~/.fleet/state.json
```

or

```
Invalid state file structure: ~/.fleet/state.json — {validation errors}
```

**Source:** `src/state/state.ts:59-69`

**What happened:** The state file exists but contains invalid JSON or does not
match the expected schema. See
[Server State Management](../state-management/overview.md) for the state schema
and read/write mechanics.

**Common causes:**

- Partial write due to a crash during `writeState()` (unlikely due to atomic
  write pattern, but possible if `mv` failed)
- Manual editing with a syntax error
- Disk corruption

**Recovery:**

```bash
# Back up the corrupted file
cp ~/.fleet/state.json ~/.fleet/state.json.backup

# Delete it -- Fleet will recreate with defaults
rm ~/.fleet/state.json
```

After deletion, Fleet treats the server as un-bootstrapped and will re-run the
full [bootstrap sequence](./bootstrap-sequence.md) on the next deploy. Existing
Docker containers and networks remain unaffected.

## SSH connection failures during bootstrap

**Symptoms:** Any bootstrap step fails with connection-related errors like
`Connection refused`, `Connection timed out`, or `Authentication failed`.

**Diagnosis:**

1. Verify SSH connectivity manually:

    ```bash
    ssh user@server 'echo ok'
    ```

2. Check the SSH key or credentials being used
3. Check firewall rules on the target server

**Recovery:**

Fix the SSH connection issue and re-run the deploy. All bootstrap steps are
idempotent, so partial progress from a previous attempt will not cause problems.

See the [SSH connection documentation](../ssh-connection/overview.md) for
detailed SSH setup and troubleshooting.

## Docker Compose V1 vs V2

**Symptom:** `docker compose` command not found, or error about unrecognized
command.

**Cause:** The server has the legacy standalone `docker-compose` (V1) but not
the modern `docker compose` (V2) plugin.

**Diagnosis:**

```bash
# Check for V2 plugin
docker compose version

# Check for V1 standalone
docker-compose --version
```

**Resolution:** Install Docker Compose V2 as a CLI plugin:

```bash
# For most Linux distributions
sudo apt-get update && sudo apt-get install docker-compose-plugin

# Or via Docker's official install script
DOCKER_CONFIG=${DOCKER_CONFIG:-$HOME/.docker}
mkdir -p $DOCKER_CONFIG/cli-plugins
curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o $DOCKER_CONFIG/cli-plugins/docker-compose
chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose
```

## Re-bootstrapping a server

To force a complete re-bootstrap (e.g., after manual changes or to change the
ACME email):

```bash
# On the target server:

# 1. Stop the proxy
docker compose -f /opt/fleet/proxy/compose.yml -p fleet-proxy down

# 2. Reset the bootstrap flag
cat ~/.fleet/state.json | jq '.caddy_bootstrapped = false' > /tmp/state.json \
  && mv /tmp/state.json ~/.fleet/state.json

# 3. Re-deploy from your local machine
fleet deploy
```

To fully wipe and start over:

```bash
# On the target server:

# 1. Stop all Fleet containers
docker compose -f /opt/fleet/proxy/compose.yml -p fleet-proxy down

# 2. Remove the Docker network
docker network rm fleet-proxy

# 3. Remove Caddy data (this deletes all TLS certificates)
docker volume rm caddy_data caddy_config

# 4. Delete the state file
rm ~/.fleet/state.json

# 5. Optionally remove the fleet root
rm -rf /opt/fleet  # or ~/fleet

# 6. Re-deploy from your local machine
fleet deploy
```

**Warning:** Removing `caddy_data` deletes all cached TLS certificates. Caddy
will re-obtain them on the next bootstrap, but this is subject to Let's Encrypt
rate limits (50 certificates per registered domain per week). Avoid doing this
frequently for the same domains. See [TLS and ACME](../caddy-proxy/tls-and-acme.md)
for more on certificate management.

## Related Documentation

- [Bootstrap Sequence](./bootstrap-sequence.md) -- the full step-by-step
  bootstrap flow
- [Server Bootstrap](./server-bootstrap.md) -- standalone bootstrap function
  details
- [Bootstrap Integrations](./bootstrap-integrations.md) -- external
  dependencies and integration points
- [Proxy Docker Compose Configuration](../caddy-proxy/proxy-compose.md) --
  the generated Caddy compose file
- [Caddy Admin API](../caddy-proxy/caddy-admin-api.md) -- how Fleet
  communicates with Caddy after startup
- [TLS and ACME](../caddy-proxy/tls-and-acme.md) -- certificate management
  and Let's Encrypt rate limits
- [Caddy Proxy Troubleshooting](../caddy-proxy/troubleshooting.md) -- Caddy-specific
  troubleshooting
- [Server State Management](../state-management/overview.md) -- state file
  schema, read/write mechanics, and recovery
- [SSH Connection Overview](../ssh-connection/overview.md) -- SSH setup
  and troubleshooting
- [Fleet Root Resolution](../fleet-root/resolution-flow.md) -- how the fleet
  root directory is resolved
- [Deployment Troubleshooting](../deploy/troubleshooting.md) -- troubleshooting
  deploy-time issues including proxy bootstrap failures
- [Deploy Sequence](../deploy/deploy-sequence.md) -- the 17-step deploy
  pipeline that triggers bootstrap at Step 5
