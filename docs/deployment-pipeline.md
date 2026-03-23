# Deployment Pipeline

## What This Is

The deployment pipeline is Fleet's core orchestration engine. It takes a local
`fleet.yml` configuration and a Docker Compose file, connects to a remote server
over SSH, and executes a 17-step sequence that ends with running containers,
configured reverse proxy routes, and persisted server state.

The pipeline is invoked by [`fleet deploy`](cli-entry-point/deploy-command.md) and coordinates every other subsystem
in the codebase: configuration loading, validation, SSH connection, state
management, secret resolution, service classification, Docker Compose
orchestration, Caddy reverse proxy management, and health checking.

## Why It Exists

Deploying Docker Compose stacks to remote servers manually involves dozens of
discrete steps: uploading files, pulling images, managing environment variables,
configuring reverse proxy routes, and verifying service health. The deployment
pipeline automates this entire sequence into a single `fleet deploy` command
while adding intelligent features like selective deployment (only redeploy
changed services), host collision detection, and atomic file uploads.

## How It Works

The pipeline executes 17 sequential steps within a single `try/catch/finally`
block. There is no per-step rollback mechanism: if a step fails, the pipeline
exits and the SSH connection is closed in the `finally` block (see
[Connection Lifecycle](ssh-connection/connection-lifecycle.md) for the cleanup
pattern). The operator must
then investigate the partial state on the server and either re-run the deploy or
manually clean up. See
[Failure Recovery](deploy/failure-recovery.md) for detailed recovery procedures.

Four boolean flags control pipeline behavior:

| Flag | Effect |
|------|--------|
| `--force` | Bypasses selective classification; all services are redeployed |
| `--dry-run` | Exits after Step 5 (proxy bootstrap) without deploying |
| `--skip-pull` | Skips the image pull step entirely |
| `--no-health-check` | Skips health check polling |

## Detailed Documentation

- [17-Step Deploy Sequence](deploy/deploy-sequence.md) -- Full walkthrough of
  each pipeline step with decision points and a flowchart
- [Failure Recovery and Partial Deploys](deploy/failure-recovery.md) -- What
  happens when the pipeline fails mid-execution
- [Caddy Route Management](deploy/caddy-route-management.md) -- How the reverse
  proxy routes are registered and managed via the Caddy admin API
- [Secrets Resolution](deploy/secrets-resolution.md) -- Three environment
  variable strategies: inline, file, and Infisical
- [Atomic File Uploads](deploy/file-upload.md) -- How files are written to the
  remote server over SSH
- [Health Checks](deploy/health-checks.md) -- How Fleet verifies service
  availability after deployment
- [Integrations Reference](deploy/integrations.md) -- Docker Engine, Docker
  Compose, Caddy, Infisical, and SSH operational details
- [Troubleshooting](deploy/troubleshooting.md) -- Common issues, debugging
  commands, and recovery procedures

## Source Files

| File | Purpose |
|------|---------|
| `src/deploy/deploy.ts` | Main 17-step orchestration function |
| `src/deploy/helpers.ts` | Helper functions for each discrete pipeline step |
| `src/deploy/types.ts` | TypeScript interfaces for deploy options and context |
| `src/deploy/index.ts` | Barrel re-export module |

## Cross-Group Dependencies

| Dependency | Direction | What It Provides |
|-----------|-----------|-----------------|
| [Fleet Configuration](configuration/overview.md) | Upstream | `loadFleetConfig` parses and validates `fleet.yml` |
| [Docker Compose Parsing](compose/overview.md) | Upstream | `loadComposeFile`, `getServiceNames`, `alwaysRedeploy` |
| [Configuration and Compose Validation](validation/overview.md) | Upstream | `runAllChecks` gates the deploy at Step 1 |
| [SSH Connection Layer](ssh-connection/overview.md) | Upstream | `createConnection` provides `ExecFn` for remote commands |
| [Server State Management](state-management/overview.md) | Bidirectional | `readState` at Step 3, `writeState` at Step 16 |
| [Fleet Root Directory](fleet-root/overview.md) | Upstream | `STACKS_DIR`, `resolveFleetRoot`, `PROXY_DIR` |
| [Caddy Reverse Proxy](caddy-proxy/overview.md) | Downstream | Bootstrap, route add/remove commands |
| [Service Classification and Hashing](deploy/service-classification-and-hashing.md) | Downstream | `classifyServices`, hash computation |
| [Environment and Secrets](env-secrets/overview.md) | Downstream | Infisical SDK integration for secret resolution |
| [CLI Entry Point](cli-entry-point/overview.md) | Consumer | `commands/deploy.ts` invokes the `deploy()` function |

## Related documentation

- [Bootstrap Sequence](bootstrap/bootstrap-sequence.md) -- the bootstrap
  sub-sequence that initializes the Caddy proxy on the server
- [Server Bootstrap](bootstrap/server-bootstrap.md) -- how the Caddy proxy
  container and Docker network are created
- [Deploy Command](cli-entry-point/deploy-command.md) -- the CLI command
  that invokes the deployment pipeline
- [Service Classification and Hashing](deploy/service-classification-and-hashing.md) --
  how Fleet determines which services need redeployment
- [CI/CD Integration Guide](ci-cd-integration.md) -- how to run Fleet
  deployments from CI/CD pipelines
- [Validate Command](validation/validate-command.md) -- pre-flight
  configuration verification
- [Operational Commands](cli-commands/operational-commands.md) -- runtime
  commands (logs, ps, restart, stop, teardown) that complement deployment
- [Stack Lifecycle Operations](stack-lifecycle/overview.md) -- managing
  stacks after deployment
- [State Operations Guide](state-management/operations-guide.md) -- inspecting
  and recovering state after deployment
