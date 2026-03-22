# Fleet Configuration Schema Reference

This document provides a field-by-field specification of every field in the
`fleet.yml` configuration file, as defined by the Zod schema in
`src/config/schema.ts`.

## Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | `"1"` (literal) | Yes | -- | Schema version. Only `"1"` is supported. |
| `server` | object | Yes | -- | Remote server connection details. |
| `stack` | object | Yes | -- | Docker Compose stack identity. |
| `env` | union | No | -- | Environment variables / secrets configuration. See [Environment Variables](./environment-variables.md). |
| `routes` | array | Yes (min 1) | -- | HTTP routing rules for the Caddy reverse proxy. |

Source: `src/config/schema.ts:53-58`

## `server`

Defines the SSH connection target. The SSH layer (`src/ssh/ssh.ts:14-28`) uses
these fields to construct a `node-ssh` connection. See
[SSH Authentication](../ssh-connection/authentication.md) for details on how
each field is handled.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `host` | string | Yes | -- | IP address or hostname of the remote server. |
| `port` | integer | No | `22` | SSH port number. |
| `user` | string | No | `"root"` | SSH username. |
| `identity_file` | string | No | -- | Path to an SSH private key file (e.g., `~/.ssh/id_ed25519`). |

Source: `src/config/schema.ts:3-8`

### SSH identity file behavior

When `identity_file` is provided, the SSH layer expands `~` to the local
user's home directory and passes the file as `privateKeyPath` to the
`node-ssh` library (`src/ssh/ssh.ts:23-24`).

When `identity_file` is omitted, the SSH layer falls back to SSH agent
forwarding by reading the `SSH_AUTH_SOCK` environment variable
(`src/ssh/ssh.ts:26`). This means your local SSH agent must have a key loaded
that the remote server accepts. The standard key discovery that raw `ssh`
performs (trying `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc.) does **not**
apply -- Fleet uses the `node-ssh` library, which requires either an explicit
key path or an agent socket.

Supported key formats are whatever the `ssh2` library (which `node-ssh` wraps)
supports: OpenSSH format, PEM-encoded RSA/DSA/ECDSA/Ed25519 keys, and
PPK format. Encrypted keys are supported if an agent or passphrase is
configured in the `ssh2` connection options (Fleet does not expose a
passphrase field, so encrypted keys must be loaded into the SSH agent).

## `stack`

Identifies the Docker Compose project to deploy.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | -- | Stack name, used as the Docker Compose project name (`-p` flag). |
| `compose_file` | string | No | `"docker-compose.yml"` | Path to the Compose file, relative to `fleet.yml`. |

Source: `src/config/schema.ts:48-51`

### Stack name constraints (`STACK_NAME_REGEX`)

The `name` field must match the regex `/^[a-z\d][a-z\d-]*$/`
(`src/config/schema.ts:46`). This means:

- Only lowercase letters (`a-z`), digits (`0-9`), and hyphens (`-`)
- Must start with a letter or digit (not a hyphen)
- No uppercase letters, underscores, dots, or other special characters

**Why these constraints exist:** The stack name is passed directly as the
Docker Compose project name via the `-p` flag. Docker Compose uses the project
name to derive container names (e.g., `stackname-service-1`), network names,
and volume names. Docker restricts these identifiers to `[a-zA-Z0-9][a-zA-Z0-9_.-]*`.
Fleet further restricts to lowercase-only to ensure consistency in container
naming (since Docker normalizes project names to lowercase) and to avoid
ambiguity in Caddy route IDs, which use the pattern `{stackName}__{serviceName}`
(`src/caddy/commands.ts:11-13`).

The regex is also exported as `STACK_NAME_REGEX` and reused by the
[`fleet init` command](../cli-entry-point/init-command.md) and the
[validation module](../validation/overview.md)
(`src/validation/fleet-checks.ts:97-107`).

## `env` (union type)

The `env` field accepts three mutually exclusive shapes. This is the most
complex part of the schema -- see [Environment Variables](./environment-variables.md)
for full details on each mode, how they interact, and the `$VAR` expansion
mechanism.

| Shape | Type signature | Use case |
|-------|---------------|----------|
| Array mode | `Array<{ key: string, value: string }>` | Inline key-value pairs |
| File mode | `{ file: string }` | Reference a local `.env` file |
| Object mode | `{ entries?: Array<{key, value}>, infisical?: InfisicalConfig }` | Combined entries and/or Infisical secrets |

Source: `src/config/schema.ts:57`

## `routes`

An array of at least one route object. Each route tells the Caddy reverse
proxy how to expose a service.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `domain` | string | Yes | -- | Fully qualified domain name for this route. |
| `port` | integer | Yes | -- | Container port to proxy traffic to. |
| `service` | string | No | -- | Docker Compose service name. Defaults to `"default"` at deploy time. |
| `tls` | boolean | No | `true` | Whether to enable HTTPS via automatic TLS. |
| `acme_email` | string (email) | No | -- | Email for ACME (Let's Encrypt) certificate registration. |
| `health_check` | object | No | -- | Health check configuration for this route's service. |

Source: `src/config/schema.ts:37-44`

### Domain validation

The schema accepts any string for `domain`. Additional validation is performed
by [`fleet validate`](../validation/validate-command.md), which checks that domains are valid FQDNs
(`src/validation/fleet-checks.ts:27-45`): at least two labels, each 1-63
characters of `[a-zA-Z0-9-]`, total length under 253 characters. Duplicate
domains across routes are also flagged (`src/validation/fleet-checks.ts:77-95`).
See the [Validation Codes Reference](../validation/validation-codes.md) for
the specific error codes produced by these checks.

### TLS and ACME email

TLS defaults to `true`. When TLS is enabled, Caddy automatically obtains and
renews certificates via the ACME protocol (Let's Encrypt by default). Caddy
handles this entirely -- Fleet simply passes the `tls` and `acme_email`
values through to the Caddy configuration at bootstrap and route registration
time.

If `acme_email` is provided, Caddy registers the ACME account with that email
address, which Let's Encrypt uses for expiration notices and account recovery.
If `acme_email` is omitted, Caddy can still obtain certificates but will use
its internal ACME account with no recovery email. Providing an email is
strongly recommended for production deployments.

Certificate renewal is handled automatically by Caddy. Caddy renews
certificates before they expire (typically 30 days before expiration for
Let's Encrypt certificates). Certificate data is persisted in the
`caddy_data` Docker volume, so certificates survive container restarts.

For more details, see the [Caddy Automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https)
and [TLS and ACME Certificate Management](../caddy-proxy/tls-and-acme.md).

### Port validation

The schema accepts any integer for `port`. The `fleet validate` command
additionally checks that port values are in the valid range 1-65535
(`src/validation/fleet-checks.ts:62-75`).

## `health_check`

Nested under a route object. Defines how the deployment pipeline verifies
that a service is healthy after deployment.

| Field | Type | Required | Default | Range |
|-------|------|----------|---------|-------|
| `path` | string | No | `"/"` | -- |
| `timeout_seconds` | integer | No | `60` | 1 - 3600 |
| `interval_seconds` | integer | No | `2` | 1 - 60 |

Source: `src/config/schema.ts:31-35`

### How health checks are executed

The health check configuration is consumed by the
[deployment pipeline](../deployment-pipeline.md)
(`src/deploy/helpers.ts:321-356`). During deployment, Fleet runs `curl`
inside the service's Docker container to poll the health endpoint:

```
docker exec {stackName}-{serviceName}-1 \
  curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:{port}{path}
```

The pipeline polls every `interval_seconds` until it receives a 2xx HTTP
status code or the `timeout_seconds` limit is reached. On timeout, a warning
is added to the deploy summary -- the deployment does **not** fail. This
allows services with slow startup times to complete their initialization
while still alerting the operator.

The health check can be disabled per-deployment using the `--no-health-check`
CLI flag on `fleet deploy`.

## `infisical` (nested under `env`)

Configuration for the [Infisical](https://infisical.com/docs) secrets
management platform.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `token` | string | Yes | -- | Infisical service token or `$VAR` reference. |
| `project_id` | string | Yes | -- | Infisical project identifier or `$VAR` reference. |
| `environment` | string | Yes | -- | Target environment (e.g., `production`, `staging`). |
| `path` | string | No | `"/"` | Secret path within the Infisical project. |

Source: `src/config/schema.ts:19-24`

All four fields support `$VAR` expansion. See
[Environment Variables](./environment-variables.md#var-expansion-mechanism) for
details.

## Exported types

The configuration module exports these TypeScript types, inferred from the Zod
schemas (`src/config/schema.ts:61-69`):

| Type | Derived from | Used by |
|------|-------------|---------|
| `FleetConfig` | `fleetConfigSchema` | Nearly all modules |
| `ServerConfig` | `serverSchema` | SSH connection layer |
| `StackConfig` | `stackSchema` | Deploy pipeline, init |
| `RouteConfig` | `routeSchema` | Deploy, proxy, validation |
| `EnvConfig` | `envSchema` | Environment/secrets modules |
| `EnvEntry` | `envEntrySchema` | Environment modules |
| `InfisicalConfig` | `infisicalSchema` | Deploy, env modules |
| `HealthCheckConfig` | `healthCheckSchema` | Deploy pipeline |
| `EnvFileConfig` | `envFileSchema` | Deploy, env modules |

## Related Documentation

- [Environment Variables and Secrets](./environment-variables.md) -- detailed
  explanation of the three `env` modes and `$VAR` expansion
- [Loading and Validation](./loading-and-validation.md) -- how the config
  file is loaded, parsed, and validated
- [Configuration Overview](./overview.md) -- architecture of the configuration
  module
- [Validation Overview](../validation/overview.md) -- pre-flight checks that
  validate `fleet.yml` and compose files
- [Validation Codes Reference](../validation/validation-codes.md) -- error
  and warning codes produced by validation checks
- [Fleet Configuration Checks](../validation/fleet-checks.md) -- checks
  applied to `fleet.yml` values (domains, ports, stack name)
- [SSH Authentication](../ssh-connection/authentication.md) -- how the
  `server` fields are used for SSH connections
- [TLS and ACME Certificate Management](../caddy-proxy/tls-and-acme.md) --
  how `tls` and `acme_email` route fields affect certificate provisioning
- [Deployment Pipeline](../deployment-pipeline.md) -- how the config is
  consumed during deployment
- [Validation Troubleshooting](../validation/troubleshooting.md) -- common
  validation failures and how to resolve them
