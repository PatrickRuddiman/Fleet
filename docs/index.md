# Fleet Documentation

Fleet is a TypeScript CLI tool for deploying and managing Docker Compose-based
applications on remote servers. It connects to a server over SSH, uploads your
Compose and environment files, starts containers, and configures a Caddy reverse
proxy with automatic HTTPS — all driven by a single `fleet.yml` configuration
file. Fleet targets developers and small teams who want a straightforward,
code-defined deployment workflow without the operational overhead of a full
container orchestration platform.

At its core, Fleet solves three problems: **getting containers running on a
remote host**, **routing traffic to them with TLS**, and **knowing what is
already deployed so it can make the smallest possible change**. A 17-step
deployment pipeline reads your local configuration, classifies each service as
needing a full redeploy, a restart, or no action at all by comparing
content-addressable hashes (service definitions, image digests, and environment
files) against server-side state, then executes only the necessary Docker and
Caddy operations over SSH. The result is fast, incremental deployments with
minimal container churn.

## Key concepts

- **`fleet.yml`** — A Zod-validated YAML configuration file that defines your
  stack: server connection details, services to deploy, domain routing, and
  environment/secrets strategy. Every Fleet command starts by loading this file.

- **Content-addressable service classification** — Fleet computes SHA-256 hashes
  of service definitions, Docker image digests, and environment files, then
  compares them against the last-deployed state. Services are bucketed into
  deploy, restart, or skip, preventing unnecessary container restarts.

- **Caddy reverse proxy** — Fleet bootstraps a Caddy container on the remote
  server and manages routes dynamically through Caddy's Admin REST API.
  Automatic TLS is handled via ACME/Let's Encrypt. All Compose stacks share a
  common `fleet-proxy` Docker network so they are reachable by the proxy.

- **Server-side state (`~/.fleet/state.json`)** — A JSON file on the remote host
  that records deployed stacks, service hashes, and registered routes. It is the
  single source of truth for what is currently running and is read/written
  atomically over SSH.

- **SSH execution abstraction (`ExecFn`)** — A uniform interface that every
  module uses to run commands on the remote server. It is the most pervasive
  cross-cutting dependency in the codebase.

- **Environment and secrets strategies** — Three mutually exclusive approaches
  for providing environment variables: inline key-value entries in `fleet.yml`,
  uploading a local `.env` file, or exporting secrets from Infisical.

- **Stack lifecycle operations** — A severity gradient of destructive commands:
  `restart` (lightest, no state change), `stop` (halts containers, removes
  routes), and `teardown` (destroys containers, networks, and optionally
  volumes).

- **Fleet root** — The base directory on the remote server (`/opt/fleet` or
  `~/fleet`) where Compose files, environment files, and stack artifacts are
  stored. Resolved once and persisted for subsequent operations.

## Reading guide

The documentation is organized around Fleet's major subsystems. The suggested
reading order below moves from foundational concepts to operational details.

**Start with configuration.** The `fleet.yml` schema is the contract that every
command depends on. Read the configuration docs to understand server settings,
service definitions, domain routing, and environment variable strategies.

**Understand the SSH layer.** The SSH connection docs explain the
`ExecFn`/`Connection` abstraction that underpins every remote operation — deploy,
bootstrap, state management, proxy configuration, and lifecycle commands all flow
through it.

**Learn the deployment pipeline.** Begin with the deployment classification docs
to see how Fleet's six-branch decision tree determines whether each service is
deployed, restarted, or skipped. Then read the deploy command docs for the full
17-step orchestration flow, including file upload, Docker operations, Caddy route
registration, and health checks.

**Explore the Caddy proxy.** The Caddy proxy docs cover how Fleet bootstraps the
reverse proxy, manages routes via the Admin API, provisions TLS certificates, and
recovers from misconfigurations. The proxy status and reload docs explain route
reconciliation and fault-tolerant recovery.

**Review server bootstrap and state.** The bootstrap docs describe the 8-step
idempotent initialization sequence. The state management docs detail how
`~/.fleet/state.json` is structured, read, and updated.

**Check validation and lifecycle.** The validation docs catalog the pre-flight
checks Fleet runs against your configuration and Compose files. The stack
lifecycle docs cover restart, stop, and teardown semantics.

**Operational commands and initialization.** The CLI command docs describe logs,
ps, and other operational commands. The project init docs explain how `fleet init`
scaffolds a `fleet.yml` from an existing Docker Compose file. The CI/CD
integration guide covers using Fleet in automated pipelines.

## Quick navigation

- [Architecture Overview](./architecture.md) — High-level system design and component interactions

## Bootstrap

- [Bootstrap Integrations](./bootstrap/bootstrap-integrations.md)
- [Bootstrap Sequence](./bootstrap/bootstrap-sequence.md)
- [Bootstrap Troubleshooting](./bootstrap/bootstrap-troubleshooting.md)
- [Server Bootstrap](./bootstrap/server-bootstrap.md)

## Caddy Proxy

- [Caddy Admin API](./caddy-proxy/caddy-admin-api.md)
- [Overview](./caddy-proxy/overview.md)
- [Proxy Compose](./caddy-proxy/proxy-compose.md)
- [Tls And Acme](./caddy-proxy/tls-and-acme.md)
- [Troubleshooting](./caddy-proxy/troubleshooting.md)

## Cli Commands

- [Integrations](./cli-commands/integrations.md)
- [Operational Commands](./cli-commands/operational-commands.md)

## Cli Entry Point

- [Architecture](./cli-entry-point/architecture.md)
- [Deploy Command](./cli-entry-point/deploy-command.md)
- [Env Command](./cli-entry-point/env-command.md)
- [Init Command](./cli-entry-point/init-command.md)
- [Overview](./cli-entry-point/overview.md)
- [Proxy Commands](./cli-entry-point/proxy-commands.md)

## Compose

- [Integration](./compose/integration.md)
- [Overview](./compose/overview.md)
- [Parser](./compose/parser.md)
- [Queries](./compose/queries.md)
- [Types](./compose/types.md)

## Configuration

- [Environment Variables](./configuration/environment-variables.md)
- [Integrations](./configuration/integrations.md)
- [Loading And Validation](./configuration/loading-and-validation.md)
- [Overview](./configuration/overview.md)
- [Schema Reference](./configuration/schema-reference.md)

## Deploy

- [Caddy Route Management](./deploy/caddy-route-management.md)
- [Classification Decision Tree](./deploy/classification-decision-tree.md)
- [Deploy Sequence](./deploy/deploy-sequence.md)
- [Failure Recovery](./deploy/failure-recovery.md)
- [File Upload](./deploy/file-upload.md)
- [Hash Computation](./deploy/hash-computation.md)
- [Health Checks](./deploy/health-checks.md)
- [Integrations](./deploy/integrations.md)
- [Secrets Resolution](./deploy/secrets-resolution.md)
- [Service Classification And Hashing](./deploy/service-classification-and-hashing.md)
- [Troubleshooting](./deploy/troubleshooting.md)

## Env Secrets

- [Env Configuration Shapes](./env-secrets/env-configuration-shapes.md)
- [Infisical Integration](./env-secrets/infisical-integration.md)
- [Overview](./env-secrets/overview.md)
- [Troubleshooting](./env-secrets/troubleshooting.md)

## Fleet Root

- [Directory Layout](./fleet-root/directory-layout.md)
- [Overview](./fleet-root/overview.md)
- [Resolution Flow](./fleet-root/resolution-flow.md)
- [Troubleshooting](./fleet-root/troubleshooting.md)

## Process Status

- [Docker Compose Integration](./process-status/docker-compose-integration.md)
- [Logs Command](./process-status/logs-command.md)
- [Overview](./process-status/overview.md)
- [Ps Command](./process-status/ps-command.md)
- [State Version Compatibility](./process-status/state-version-compatibility.md)
- [Troubleshooting](./process-status/troubleshooting.md)

## Project Init

- [Compose File Detection](./project-init/compose-file-detection.md)
- [Fleet Yml Generation](./project-init/fleet-yml-generation.md)
- [Integrations](./project-init/integrations.md)
- [Overview](./project-init/overview.md)
- [Utility Functions](./project-init/utility-functions.md)

## Proxy Status Reload

- [Overview](./proxy-status-reload/overview.md)
- [Proxy Status](./proxy-status-reload/proxy-status.md)
- [Route Reload](./proxy-status-reload/route-reload.md)
- [Troubleshooting](./proxy-status-reload/troubleshooting.md)

## Ssh Connection

- [Authentication](./ssh-connection/authentication.md)
- [Connection API](./ssh-connection/connection-api.md)
- [Connection Lifecycle](./ssh-connection/connection-lifecycle.md)
- [Overview](./ssh-connection/overview.md)

## Stack Lifecycle

- [Failure Modes](./stack-lifecycle/failure-modes.md)
- [Integrations](./stack-lifecycle/integrations.md)
- [Overview](./stack-lifecycle/overview.md)
- [Restart](./stack-lifecycle/restart.md)
- [Stop](./stack-lifecycle/stop.md)
- [Teardown](./stack-lifecycle/teardown.md)

## State Management

- [Operations Guide](./state-management/operations-guide.md)
- [Overview](./state-management/overview.md)
- [Schema Reference](./state-management/schema-reference.md)
- [State Lifecycle](./state-management/state-lifecycle.md)

## Validation

- [Compose Checks](./validation/compose-checks.md)
- [Fleet Checks](./validation/fleet-checks.md)
- [Overview](./validation/overview.md)
- [Troubleshooting](./validation/troubleshooting.md)
- [Validate Command](./validation/validate-command.md)
- [Validation Codes](./validation/validation-codes.md)

## Overview

- [Ci Cd Integration](./ci-cd-integration.md)
- [Deployment Pipeline](./deployment-pipeline.md)

