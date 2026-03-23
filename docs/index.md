# Fleet Documentation

Fleet is a TypeScript CLI tool that deploys Docker Compose applications to
remote servers over SSH, provisions a Caddy reverse proxy with automatic HTTPS,
and tracks what is deployed so it can make the smallest possible change on each
run. It targets developers and small teams who want code-defined deployments
without the operational overhead of Kubernetes or a full container orchestration
platform.

Deploying a Docker Compose stack to a remote server still involves a manual,
error-prone sequence: SSH in, upload files, pull images, start containers,
configure a reverse proxy, obtain TLS certificates, and remember what you did
last time. Fleet collapses that entire workflow into a single `fleet deploy`
command driven by a declarative `fleet.yml` configuration file. A 17-step
deployment pipeline classifies each service as needing a full redeploy, a
restart, or no action at all by comparing content-addressable hashes against
server-side state, then executes only the necessary Docker and Caddy operations
over SSH. The result is fast, incremental deployments with minimal container
churn.

Fleet provides eleven CLI commands covering the full lifecycle: project
scaffolding (`fleet init`), configuration validation (`fleet validate`),
deployment (`fleet deploy`), secret management (`fleet env`), proxy inspection
(`fleet proxy status`, `fleet proxy reload`), operational monitoring
(`fleet ps`, `fleet logs`), and stack lifecycle control (`fleet restart`,
`fleet stop`, `fleet teardown`).

## Key concepts

- **`fleet.yml`** -- A Zod-validated YAML configuration file that defines your
  stack: server connection details, services to deploy, domain routing, and
  environment/secrets strategy. Every Fleet command starts by loading this file.

- **17-step deployment pipeline** -- The core orchestration engine that connects
  to a remote server, reads persisted state, classifies services, uploads files,
  manages Docker Compose containers, bootstraps the Caddy proxy, registers
  routes, performs health checks, and writes state back to the server. Supports
  `--force`, `--dry-run`, `--skip-pull`, and `--no-health-check` flags.

- **Content-addressable service classification** -- Fleet computes SHA-256
  hashes of service definitions, Docker image digests, and environment files,
  then compares them against the last-deployed state. A six-priority decision
  tree buckets each service into deploy, restart, or skip, preventing
  unnecessary container restarts.

- **Caddy reverse proxy** -- Fleet bootstraps a Caddy container on the remote
  server and manages routes dynamically through the Caddy Admin REST API.
  Automatic TLS is handled via ACME/Let's Encrypt. All stacks share a common
  `fleet-proxy` Docker bridge network so they are reachable by the proxy.

- **Server-side state (`~/.fleet/state.json`)** -- A flat JSON file on the
  remote host that records deployed stacks, service hashes, and registered
  routes. It is the single source of truth for what is currently running. Writes
  use an atomic tmp-file-then-rename pattern over SSH for crash safety.

- **SSH execution abstraction (`ExecFn`)** -- A uniform interface that every
  module uses to run commands on the remote server. It is the most pervasive
  cross-cutting dependency in the codebase, enabling the same code to work for
  both remote servers and local deployments.

- **Environment and secrets strategies** -- Three mutually exclusive approaches
  for providing environment variables: inline key-value entries in `fleet.yml`,
  a local `.env` file reference, or secrets fetched from Infisical via its SDK.
  Environment files are uploaded with `0600` permissions.

- **Stack lifecycle operations** -- A severity gradient of destructive commands:
  `restart` (lightest, no state change), `stop` (halts containers, removes
  routes), and `teardown` (destroys containers, networks, and optionally
  volumes).

- **Fleet root** -- The base directory on the remote server (`/opt/fleet` or
  `~/fleet`) where Compose files, environment files, and stack artifacts are
  stored. Resolved once during bootstrap and persisted in state.

## Reading guide

The documentation is organized around Fleet's major subsystems. The suggested
reading path below moves from foundational concepts to operational details.

**Start with the [architecture overview](architecture.md).** It provides a
system diagram showing how the local CLI, remote server, Docker engine, Caddy
proxy, and external services (Let's Encrypt, Infisical) interact. Read this
first for the big picture.

**Understand configuration.** The `fleet.yml` schema is the contract that every
command depends on. The configuration docs explain server settings, service
definitions, domain routing, environment variable strategies, and how the Zod
schema validates input.

**Learn the SSH layer.** The SSH connection docs explain the
`ExecFn`/`Connection` abstraction that underpins every remote operation. Deploy,
bootstrap, state management, proxy configuration, and lifecycle commands all
flow through it.

**Study the deployment pipeline.** Begin with service classification to see how
Fleet's six-branch decision tree determines whether each service is deployed,
restarted, or skipped. Then read the deploy sequence docs for the full 17-step
orchestration flow, including file upload, Docker operations, Caddy route
registration, and health checks.

**Explore the Caddy proxy.** The Caddy proxy docs cover how Fleet bootstraps
the reverse proxy container, manages routes via the Admin API, provisions TLS
certificates through ACME, and handles the `fleet-proxy` Docker network. The
proxy status and reload docs explain route reconciliation.

**Review server bootstrap and state management.** The bootstrap docs describe
the idempotent initialization sequence that prepares a server for Fleet. The
state management docs detail how `~/.fleet/state.json` is structured, validated
with Zod schemas, and updated atomically.

**Check environment and secrets handling.** The env-secrets docs cover the three
configuration shapes (inline, file reference, Infisical), how secrets are
resolved and uploaded, and how environment hash changes trigger service restarts
rather than full redeploys.

**Validation and lifecycle.** The validation docs catalog the pre-flight checks
Fleet runs against your configuration and Compose files. The stack lifecycle
docs cover restart, stop, and teardown semantics along with their failure modes.

**Operational commands and project initialization.** The CLI command docs
describe `ps`, `logs`, and other operational commands. The project init docs
explain how `fleet init` scaffolds a `fleet.yml` from an existing Docker Compose
file. The CI/CD integration guide covers running Fleet in automated pipelines.

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
- [Integrations](./cli-entry-point/integrations.md)
- [Overview](./cli-entry-point/overview.md)
- [Proxy Commands](./cli-entry-point/proxy-commands.md)
- [Troubleshooting](./cli-entry-point/troubleshooting.md)
- [Version Command](./cli-entry-point/version-command.md)

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
- [Change Detection Overview](./deploy/change-detection-overview.md)
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
- [Security Model](./env-secrets/security-model.md)
- [State Data Model](./env-secrets/state-data-model.md)
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

- [Changelog](./changelog.md)
- [Ci Cd Integration](./ci-cd-integration.md)
- [Deployment Pipeline](./deployment-pipeline.md)

