# Health Checks

## What This Covers

Fleet performs post-deployment health checks by polling HTTP endpoints inside
running containers. This page explains how the health check mechanism works, how
to configure it, and what happens when checks fail.

## Why Health Checks Exist

After starting containers (Step 12) and before registering Caddy routes
(Step 15), Fleet verifies that services are actually responding to HTTP requests.
This catches common deployment issues:

- Application fails to start due to missing configuration
- Application crashes during initialization
- Port binding conflicts inside the container
- Slow startup (application needs time to become ready)

## How It Works

The `checkHealth()` function at `src/deploy/helpers.ts:321-356` polls a health
endpoint by running `curl` *inside* the target container via `docker exec`:

```bash
docker exec {stackName}-{serviceName}-1 curl -s -o /dev/null -w "%{http_code}" http://localhost:{port}{path}
```

This approach:

- Tests the application from inside the container, avoiding network routing
  issues
- Requires `curl` to be available in the container image
- Uses `localhost:{port}` because the check runs inside the container's network
  namespace

### Poll Loop

The health check polls repeatedly at a configured interval until one of two
conditions is met:

1. **Success**: The HTTP response has a status code in the 2xx range (200-299).
   The check passes and no warning is produced.
2. **Timeout**: The configured timeout expires without a 2xx response. The last
   observed status is recorded.

The maximum number of attempts is calculated as:
`ceil(timeout_seconds / interval_seconds)`.

Between attempts, the function executes `sleep {interval_seconds}` on the remote
server via SSH.

### Timeout Behavior

**On timeout, a warning is added rather than failing the deploy.** The
deployment continues to route registration (Step 15), state write (Step 16), and
summary (Step 17). The warning appears in the final summary output.

This design choice means a service can be deployed and made reachable via Caddy
even if its health check does not pass. This is intentional -- some services may
take longer to start than the configured timeout, or the health check path may
not be available until after initial data loading.

## Configuration

Health checks are configured per-route in [`fleet.yml`](../configuration/overview.md):

```yaml
routes:
  - domain: app.example.com
    service: web
    port: 3000
    health_check:
      path: /health
      timeout_seconds: 60
      interval_seconds: 5
```

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `path` | `string` | Any valid URL path | The HTTP path to poll (e.g., `/health`, `/ready`) |
| `timeout_seconds` | `number` | 1-3600 | Maximum time to wait for a healthy response |
| `interval_seconds` | `number` | 1-60 | Time between poll attempts |

Health checks are optional. If `health_check` is not specified on a route, no
check is performed for that route's service.

## The --no-health-check Flag

Passing `--no-health-check` to `fleet deploy` skips all health checks entirely.
Step 14 prints a message and proceeds directly to Step 15 (route registration).

Use this flag when:

- You need a fast deployment and trust the application is healthy
- The container images do not include `curl`
- The application does not expose an HTTP health endpoint
- You are deploying infrastructure services that are not HTTP-based

## Requirements

### curl in the Container

The health check runs `curl` inside the container via `docker exec`. If the
container image does not include `curl`, the check fails immediately on each
attempt with a non-zero exit code. After the timeout expires, this produces a
warning like:

```
Health check timed out for mystack-web-1/health after 60s (last status: exit code 126)
```

Common images that include `curl`: most Debian/Ubuntu-based images, Alpine with
`curl` package. Common images that do not: minimal scratch or distroless images.

### HTTP Endpoint

The health check expects an HTTP endpoint (not HTTPS) on `localhost` inside the
container. The application must:

- Listen on the configured port
- Respond to the configured path
- Return a 2xx status code when healthy

## Interpreting Health Check Warnings

| Warning Message | Likely Cause |
|----------------|-------------|
| `last status: no response` | Container not running or curl not available |
| `last status: exit code 7` | Connection refused -- app not listening on the port yet |
| `last status: exit code 126` | `curl` not found in the container |
| `last status: HTTP 500` | Application is running but returning an error |
| `last status: HTTP 503` | Application is starting up (service unavailable) |

## Related Pages

- [17-Step Deploy Sequence](deploy-sequence.md) -- health checks run at Step 14
- [Troubleshooting](troubleshooting.md) -- diagnosing health check failures
- [Deployment Pipeline Overview](../deployment-pipeline.md)
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  `health_check` field specification
- [Caddy Route Management](caddy-route-management.md) -- Step 15, which
  runs after health checks pass
- [Validation Overview](../validation/overview.md) -- pre-deploy checks that
  run before health checks
