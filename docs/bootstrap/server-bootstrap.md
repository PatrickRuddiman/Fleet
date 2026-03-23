# Server Bootstrap

The server bootstrap module initializes Fleet's reverse-proxy infrastructure on a
target server. It is the first operation that must complete before any application
stack can be deployed, because it establishes the Caddy reverse proxy that routes
traffic to deployed services.

## Why it exists

Fleet deploys Docker Compose stacks to remote servers via SSH. Every deployed
service that needs to be reachable over HTTP/HTTPS requires a reverse proxy to
terminate TLS and route requests by hostname. The bootstrap module sets up this
reverse proxy (Caddy) as a Docker container, creates the shared Docker network
that connects it to application containers, and posts an initial configuration
to the [Caddy Admin API](../caddy-proxy/caddy-admin-api.md). For how Fleet
validates configurations before deployment, see the
[Validation Overview](../validation/overview.md).

Without bootstrap, there is no proxy to route traffic, no Docker network for
inter-container communication, and no
[state file](../state-management/overview.md) to track what has been deployed.

## Source files

| File | Purpose |
|------|---------|
| `src/bootstrap/bootstrap.ts` | Core 8-step bootstrap orchestration function |
| `src/bootstrap/types.ts` | `BootstrapOptions` interface (ACME email configuration) |
| `src/bootstrap/index.ts` | Public exports: `bootstrap` and `BootstrapOptions` |

## How it works

The `bootstrap()` function accepts an `ExecFn` (a remote execution abstraction
from the [SSH connection layer](../ssh-connection/overview.md)) and a
`BootstrapOptions` object. It executes an 8-step sequence entirely through
remote commands, meaning the function runs locally but all side effects occur
on the target server.

The sequence is **idempotent**: if the state file already has
`caddy_bootstrapped: true`, the function returns immediately without performing
any work.

For the detailed step-by-step breakdown, see
[Bootstrap Sequence](./bootstrap-sequence.md).

## Configuration

The `BootstrapOptions` interface (defined in `src/bootstrap/types.ts`) accepts:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `acme_email` | `string` | No | Email address for ACME/Let's Encrypt certificate registration |

When `acme_email` is provided, the initial Caddy configuration includes a TLS
automation policy with an ACME issuer. See
[ACME and TLS Integration](./bootstrap-integrations.md#acme--lets-encrypt) and
[TLS and ACME Certificate Management](../caddy-proxy/tls-and-acme.md) for
details on what happens with and without this option.

## Dual implementation note

There are **two implementations** of the bootstrap logic in the codebase:

1. **`src/bootstrap/bootstrap.ts:18`** -- The standalone `bootstrap()` function
   documented here. It includes a health-check retry loop (10 attempts, 3-second
   intervals) and persists state at multiple points during the process.

2. **`src/deploy/helpers.ts:90`** -- The `bootstrapProxy()` function used by the
    [deployment pipeline](../deployment-pipeline.md). This
   version omits the health-check retry loop, does not use the `-p fleet-proxy`
   project flag for Docker Compose, and returns an updated state object rather
   than persisting it directly.

The deployment pipeline (`src/deploy/deploy.ts:93`) exclusively calls the
`deploy/helpers.ts` version. The standalone `bootstrap/bootstrap.ts` version is
not imported outside its own `index.ts`. This suggests the standalone module is
either an earlier version that was superseded, or is intended for use outside the
deploy pipeline (e.g., a future standalone `fleet bootstrap` CLI command).

**Key behavioral differences:**

| Aspect | `bootstrap/bootstrap.ts` | `deploy/helpers.ts` |
|--------|--------------------------|---------------------|
| Health-check retry | 10 attempts, 3s interval (30s timeout) | None |
| Docker Compose project flag | `-p fleet-proxy` | Not specified |
| State persistence | Writes state at steps 1 and 8 | Returns updated state to caller |
| Logging | No console output | Logs each substep to console |

## Cross-group dependencies

- **[State Management](../state-management/overview.md)** -- Reads and
  writes `~/.fleet/state.json` via `readState()` and `writeState()`
- **[SSH Connection](../ssh-connection/overview.md)** -- All remote
  operations run through the `ExecFn` abstraction
- **[Fleet Root](../fleet-root/overview.md)** -- Resolves the installation
  directory via `resolveFleetRoot()`
- **[Caddy Proxy](../caddy-proxy/overview.md)** -- Generates the proxy
  compose file and Caddy configuration commands
- **[Deployment Pipeline](../deployment-pipeline.md)** --
  Contains the alternative `bootstrapProxy()` implementation that is used in
  production deploys

## Related documentation

- [Bootstrap Sequence](./bootstrap-sequence.md) -- Step-by-step orchestration
  flow with diagram
- [Integrations and Operations](./bootstrap-integrations.md) -- Docker, Caddy,
  ACME, and state persistence details
- [Troubleshooting](./bootstrap-troubleshooting.md) -- Common failure modes and
  recovery procedures
- [TLS and ACME Certificate Management](../caddy-proxy/tls-and-acme.md) --
  How Caddy provisions and renews TLS certificates
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  Full `fleet.yml` field specification including `acme_email`
- [Deploy Failure Recovery](../deploy/failure-recovery.md) -- What happens when
  the pipeline fails at the bootstrap step
- [Operational Commands](../cli-commands/operational-commands.md) -- CLI commands
  that depend on a bootstrapped server
- [Deploy Integrations](../deploy/integrations.md) -- Docker, Caddy, and SSH
  integration details used during bootstrap
