# Integrations Reference

This page documents the external systems, tools, and libraries that the
deployment pipeline and service classification subsystem integrate with. For each
integration, it explains how Fleet uses it, what operational access is needed,
and how to troubleshoot common issues.

## Docker Engine

### How Fleet Uses It

Fleet executes Docker commands on the remote server over SSH for container
management, network operations, image inspection, and health checking.

| Operation | Command | Source |
|-----------|---------|--------|
| Create Docker network | `docker network create fleet-proxy` | `src/deploy/helpers.ts:104` |
| Connect container to network | `docker network connect fleet-proxy {container}` | `src/deploy/helpers.ts:299-301` |
| Execute command in container | `docker exec {container} curl ...` | `src/deploy/helpers.ts:335-336` |
| Inspect image digest | `docker image inspect {image} --format '{{index .RepoDigests 0}}'` | `src/deploy/hashes.ts:16-17` |

### Docker Version Requirements

Fleet uses the **Docker Compose V2 plugin** syntax (`docker compose`, not the
legacy `docker-compose` binary). This requires:

| Component | Minimum Version |
|-----------|----------------|
| Docker Engine | 20.10+ |
| Docker Compose plugin | v2.0.0+ |

To verify on the remote server:

```bash
docker --version          # Should show 20.10 or later
docker compose version    # Should show v2.x
```

### What Happens with Docker Compose V1 Only

If only the legacy `docker-compose` (V1) binary is installed (without the V2
plugin), all `docker compose` commands will fail with `docker: 'compose' is not a
docker command`. Fleet does not fall back to the V1 binary — there is no
compatibility layer or version detection.

**Resolution**: Install the Docker Compose V2 plugin:

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install docker-compose-plugin

# Or install via Docker's official convenience script
# (installs both Docker Engine and Compose plugin)
curl -fsSL https://get.docker.com | sh
```

After installation, verify with `docker compose version`.

### How `<no value>` Is Handled

When `docker image inspect` is run on a locally-built image that was never pushed
to or pulled from a registry, the `RepoDigests` field is empty and the Go
template returns `<no value>`. Fleet normalizes this to `null` at
`src/deploy/hashes.ts:26-28`, which causes the image digest comparison to be
skipped in the [classification decision tree](classification-decision-tree.md).

This is intentional -- locally-built images cannot be compared by digest, so Fleet
falls back to definition hash comparison only.

### Troubleshooting Docker Issues

| Problem | Diagnosis | Resolution |
|---------|-----------|-----------|
| "Cannot connect to Docker daemon" | Docker daemon not running | `sudo systemctl start docker` |
| "No such image" | Image not pulled to server | Check registry access; Fleet pulls at Step 11 |
| `docker compose` not found | Compose V2 plugin not installed | `apt-get install docker-compose-plugin` |
| Digest always null for registry images | Pull may not have completed | Check `docker images`; verify registry credentials |
| Disk space errors | Docker image cache full | `docker system prune -af` |
| "already connected" during network attach | Container re-deployed | Harmless; silently ignored by Fleet |

### Verifying Docker State on the Remote Server

```bash
# Check Docker daemon status
sudo systemctl status docker

# List locally available images
docker images

# Inspect a specific image's digests
docker image inspect <image> --format '{{.RepoDigests}}'

# Check disk space used by Docker
docker system df

# List containers on the fleet-proxy network
docker network inspect fleet-proxy
```

### Official Documentation

- [Docker Engine CLI reference](https://docs.docker.com/engine/reference/commandline/cli/)
- [Docker image inspect](https://docs.docker.com/reference/cli/docker/image/inspect/)

---

## Docker Compose

### How Fleet Uses It

Docker Compose orchestrates multi-container applications defined in `compose.yml`
files. Fleet uses it to start, stop, restart, and pull containers.

| Operation | Command | Source |
|-----------|---------|--------|
| Start all (force mode) | `docker compose -p {name} -f {path} up -d --remove-orphans` | `src/deploy/deploy.ts:228-229` |
| Start single service | `docker compose -p {name} -f {path} up -d {service}` | `src/deploy/deploy.ts:237-238` |
| Restart service | `docker compose -p {name} -f {path} restart {service}` | `src/deploy/deploy.ts:246-247` |
| Remove orphans | `docker compose -p {name} -f {path} up -d --remove-orphans --no-recreate` | `src/deploy/deploy.ts:255-256` |
| Pull all images | `docker compose -p {name} -f {path} pull` | `src/deploy/helpers.ts:606-607` |
| Pull single service | `docker compose -p {name} -f {path} pull {service}` | `src/deploy/helpers.ts:624-625` |
| Start proxy | `docker compose -f {proxyDir}/compose.yml up -d` | `src/deploy/helpers.ts:111-112` |

### Key Behaviors

**`--remove-orphans`**: Removes containers for services that were deleted from
the compose file between deploys. In force mode, included in the main `up`
command. In selective mode, a separate `up -d --remove-orphans --no-recreate`
runs after individual service deployments.

**`--env-file`**: Included only when `configHasSecrets()` returns `true` (see
[Secrets Resolution](secrets-resolution.md)). Points to `{stackDir}/.env`.

**Project name (`-p`)**: The stack name from `fleet.yml` serves as the Docker
Compose project name. Container names follow the pattern
`{projectName}-{serviceName}-1` (e.g., `myapp-web-1`).

### Troubleshooting

**`docker compose pull` fails for one service**: In selective mode, a pull
failure for any service aborts the deploy. Check the image reference and that
the remote server can reach the container registry.

**Orphan containers not removed**: Verify the project name matches between the
current and previous deployment.

### Official Documentation

- [Docker Compose CLI reference](https://docs.docker.com/compose/reference/)
- [Docker Compose file specification](https://docs.docker.com/compose/compose-file/)

---

## Caddy Reverse Proxy

### How Fleet Uses It

Caddy runs as a Docker container (`fleet-proxy`) providing reverse proxying and
automatic HTTPS. Fleet manages Caddy's configuration programmatically via the
JSON admin API. See [Caddy Route Management](caddy-route-management.md) for the
full details, and [TLS and ACME Certificate Management](../caddy-proxy/tls-and-acme.md)
for how certificates are provisioned and renewed.

### Container Details

| Property | Value |
|----------|-------|
| Image | `caddy:2-alpine` (floating tag) |
| Container name | `fleet-proxy` |
| Host ports | 80, 443 |
| Admin API | `localhost:2019` (inside container, not exposed to host) |
| Data volume | `caddy_data` (TLS certificates) |
| Config volume | `caddy_config` (persisted configuration) |
| Command | `caddy run --resume` |

### Admin API Endpoints Used by Fleet

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/load` | POST | Replace entire Caddy configuration atomically |
| `/config/` | GET | Export current full configuration |
| `/id/{caddyId}` | DELETE | Remove a route by its `@id` (used by `fleet proxy reload`) |
| `/config/apps/http/servers/fleet/routes` | POST | Append a route (used by individual route operations) |

During deployment, Fleet uses the **atomic `/load` pattern**: it GETs the full
config, merges all stacks' routes from Fleet state, and POSTs the complete config
to `/load`. This replaces the entire configuration atomically, ensuring
idempotency and preventing duplicate `@id` errors. See
[Caddy Route Management](caddy-route-management.md) for details.

The `@id` field in route JSON objects provides a shortcut for addressing routes
without traversing the full config path. Fleet uses the format
`{stackName}__{domain-slug}` for route IDs, where `domain-slug` is the domain
with non-alphanumeric characters replaced by hyphens and lowercased (e.g.,
`myapp__example-com` for domain `example.com`). See `src/caddy/commands.ts:11-17`.

### Debugging Caddy

```bash
# View full Caddy configuration
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/config/ | jq"

# List all registered routes
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq"

# Check a specific route by @id (domain slug format)
ssh user@server "docker exec fleet-proxy curl -s http://localhost:2019/id/{stackName}__{domain-slug} | jq"

# View Caddy logs
ssh user@server "docker logs fleet-proxy --tail 100"
```

### Troubleshooting

| Problem | Diagnosis | Resolution |
|---------|-----------|-----------|
| 502 Bad Gateway | Upstream container unreachable | Check container is running and on fleet-proxy network |
| Certificate issuance fails | ACME error in Caddy logs | Verify DNS, port 80/443 access, and rate limits |
| Route not found after restart | `--resume` flag not loading config | Run `fleet proxy reload` to re-register routes |
| Route conflict | Two stacks claim same domain | Host collision detection should catch this; check `state.json` |

### TLS Certificate Storage

Certificates are stored in the `caddy_data` Docker volume, persisted across
container restarts. Caddy renews certificates approximately 30 days before
expiration. Check certificate status:

```bash
ssh user@server "docker logs fleet-proxy 2>&1 | grep -i 'certificate\|tls\|acme'"
```

### Official Documentation

- [Caddy documentation](https://caddyserver.com/docs/)
- [Caddy admin API](https://caddyserver.com/docs/api)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy `run --resume`](https://caddyserver.com/docs/command-line#caddy-run)

---

## Infisical

### How Fleet Uses It

[Infisical](https://infisical.com/docs) is a secrets management platform. Fleet
integrates via the **`@infisical/sdk` Node.js SDK**, which runs locally on the
machine executing `fleet deploy` (not on the remote server). The SDK fetches
secrets from the Infisical API, formats them as dotenv content, and uploads the
resulting `.env` file to the remote server. See
[Secrets Resolution](secrets-resolution.md) for configuration details.

**Source files**:

- `src/deploy/helpers.ts:3` -- `import { InfisicalSDK } from "@infisical/sdk"`
- `src/deploy/helpers.ts:279-298` -- SDK client instantiation, authentication,
  secret retrieval, and `.env` upload

### How It Works

The integration follows three steps, all within `resolveSecrets()`:

1. **Instantiate client**: `new InfisicalSDK()`
2. **Authenticate**: `client.auth().accessToken(token)` — uses a pre-obtained
   access token (typically from Universal Auth or another machine identity method)
3. **Fetch secrets**: `client.secrets().listSecrets({ projectId, environment, secretPath })`
4. **Format and upload**: Secrets are formatted as `KEY=VALUE` lines and uploaded
   to the remote server as `{stackDir}/.env` via base64 encoding

No CLI installation or remote server tooling is required. The Infisical SDK
runs entirely in the local Node.js process.

### Authentication and Token Management

The `token` field in the `fleet.yml` Infisical configuration provides a
pre-obtained access token. This token is passed to
`client.auth().accessToken(token)` which sets it for all subsequent API calls.

The token field supports `$VAR` expansion at config load time, allowing CI/CD
pipelines to inject the token via environment variables:

```yaml
env:
  infisical:
    token: $INFISICAL_TOKEN
    project_id: proj_abc123
    environment: production
    path: /
```

**Token types**: The SDK's `accessToken()` method accepts a pre-obtained token.
In practice, this is typically obtained through:

- **Universal Auth**: Client credentials flow using a client ID and client
  secret, producing an access token. See
  [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth).
- **Service tokens** (legacy): Older Infisical token type, still supported.

**Token rotation**: Generate a new token in the Infisical dashboard (or via the
API), update the environment variable or `fleet.yml`, and redeploy. No token
state is cached locally or on the remote server.

### Network Requirements

The **local machine** (where `fleet deploy` runs) needs outbound HTTPS access to:

| Hostname | Purpose |
|----------|---------|
| `app.infisical.com` (or self-hosted URL) | SDK API calls for secret retrieval |

The remote server does **not** need access to Infisical — secrets are fetched
locally and uploaded over SSH.

### Accessing the Infisical Dashboard

- **Infisical Cloud**: [https://app.infisical.com/](https://app.infisical.com/)
- **Self-hosted**: Navigate to your instance URL

### Troubleshooting

| Problem | Diagnosis | Resolution |
|---------|-----------|-----------|
| "Unauthorized" or 401 from SDK | Token is invalid or expired | Rotate the token in the Infisical dashboard |
| Wrong secrets returned | Incorrect `project_id`, `environment`, or `path` | Verify values against the Infisical dashboard |
| Network timeout | Local machine cannot reach Infisical API | Check firewall rules, proxy settings, and DNS |
| `$INFISICAL_TOKEN` not expanded | Environment variable not set | Export the variable before running `fleet deploy` |

### Official Documentation

- [Infisical Node.js SDK](https://infisical.com/docs/sdks/languages/node)
- [Universal Auth](https://infisical.com/docs/documentation/platform/identities/universal-auth)
- [Infisical Secrets API](https://infisical.com/docs/api-reference/endpoints/secrets/list)

---

## SSH (Remote Execution)

### How Fleet Uses It

All remote operations execute through the `ExecFn` abstraction, which runs
commands on the remote server over SSH and returns stdout, stderr, and exit code.

```typescript
type ExecFn = (command: string) => Promise<ExecResult>;

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
```

### Authentication

Configured in `fleet.yml`:

```yaml
server:
  host: 1.2.3.4
  user: deploy
  port: 22
  identity_file: ~/.ssh/id_ed25519  # optional
```

If `identity_file` is omitted, the SSH agent is used.

### Connection Lifecycle

1. **Connect**: Step 2 of the deploy pipeline (`src/deploy/deploy.ts:66`)
2. **Use**: Steps 3-16 use `exec` for all remote operations
3. **Close**: `finally` block at `src/deploy/deploy.ts:407-410`

### Failure Behavior

No automatic reconnection or retry logic exists. If the connection drops, the
current `exec` call fails, the pipeline catches the error and exits. The `finally`
block closes the connection (no-op if already disconnected).

### Limitations

- **No batching**: One SSH round-trip per `exec` call. Serial execution creates
  latency for stacks with many services during hash computation.
- **No streaming**: Full stdout/stderr captured. Not a concern for short-output
  commands but relevant for long-running operations.
- **No explicit timeout**: Timeouts are determined by SSH library defaults and
  server-side SSH configuration.

### Official Documentation

- [node-ssh on npm](https://www.npmjs.com/package/node-ssh)
- [SSH Connection Layer](../ssh-connection/overview.md) -- Fleet's SSH abstraction

---

## Node.js `crypto` Module

### How Fleet Uses It

Computes SHA-256 hashes of service definitions locally at
`src/deploy/hashes.ts:162`:

```typescript
crypto.createHash("sha256").update(json).digest("hex")
```

### Hash Stability

SHA-256 produces identical output for identical input across all Node.js versions
and platforms. The deterministic serialization pipeline (field selection, null
removal, key sorting, JSON.stringify) ensures consistent hashes.

Hash collisions in the 256-bit space are negligible (~2^-128 probability). Fleet
does not handle hash collisions.

### Official Documentation

- [Node.js Crypto](https://nodejs.org/api/crypto.html)

---

## Zod (Schema Validation)

### How Fleet Uses It

Zod validates `fleet.yml` configuration at `src/config/schema.ts` and `state.json`
structure at `src/state/state.ts:34-38`. Validation errors are formatted using
Zod v4's `prettifyError` for user-friendly messages. See the
[Configuration Schema Reference](../configuration/schema-reference.md) for
the full schema and the [Validation Overview](../validation/overview.md) for
pre-flight checks.

### Official Documentation

- [Zod documentation](https://zod.dev)

## Related documentation

- [Service Classification and Hashing Overview](service-classification-and-hashing.md)
- [Classification Decision Tree](classification-decision-tree.md)
- [Hash Computation Pipeline](hash-computation.md)
- [Failure Recovery and Partial Deploys](failure-recovery.md) -- what happens
  when integrations fail mid-deployment
- [Infisical Integration](../env-secrets/infisical-integration.md)
- [Env Secrets Troubleshooting](../env-secrets/troubleshooting.md) -- detailed
  troubleshooting for Infisical SDK and secret resolution
- [Deployment Pipeline](../deployment-pipeline.md)
- [TLS and ACME Certificate Management](../caddy-proxy/tls-and-acme.md) --
  how Caddy handles TLS certificates
- [SSH Authentication](../ssh-connection/authentication.md) -- SSH key and
  agent configuration details
- [SSH Connection Lifecycle](../ssh-connection/connection-lifecycle.md) -- how
  SSH connections are managed during deployment
- [Security Model](../env-secrets/security-model.md) -- security properties
  of secrets transport and Infisical token isolation
