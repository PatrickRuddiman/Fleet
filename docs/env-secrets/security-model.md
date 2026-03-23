# Security Model

## What This Covers

This page documents the security properties of Fleet's environment and secrets
system: how `.env` files are protected at rest and in transit, how path
traversal attacks are prevented, how the Infisical access token is isolated
from remote servers, how Docker containers access environment variables, and
how the `fleet-proxy` network affects container-to-container communication.

## Why Security Matters

The `.env` files managed by Fleet contain sensitive credentials -- database
passwords, API keys, third-party service tokens, and encryption secrets. A
compromise of any of these values can lead to unauthorized data access,
service impersonation, or lateral movement across infrastructure. Fleet's
security model is designed to limit the exposure surface at every stage:
storage, transport, and runtime.

## File Permission Model

All `.env` files are written with `0600` permissions (owner read/write only),
regardless of which [environment configuration shape](./env-configuration-shapes.md)
is used. This prevents other users on the server from reading secret values.

### How permissions are applied

Fleet uses two upload methods, both following the
[atomic file upload](../deploy/file-upload.md) `.tmp` + `mv` pattern.
Permissions are set as the final step of each upload command:

| Method | Source | Command sequence |
|--------|--------|-----------------|
| Heredoc (`uploadFile`) | `src/deploy/helpers.ts:142-175` | `mkdir -p` -> heredoc to `.tmp` -> `mv .tmp target` -> `chmod 0600 target` |
| Base64 (`uploadFileBase64`) | `src/deploy/helpers.ts:182-205` | `mkdir -p && base64 decode to .tmp && mv .tmp target && chmod 0600 target` |

### Timing window during atomic write

In both methods, `chmod` runs **after** `mv`. This means there is a brief
window -- typically milliseconds -- where the target file exists with whatever
permissions the default umask provides (commonly `0644`). During this window,
other users on the server could theoretically read the file.

The `.tmp` file is also created with default umask permissions before being
renamed.

### Umask recommendation for high-security environments

To eliminate the timing window entirely, set a restrictive umask for the
deploy user:

```bash
# In the deploy user's ~/.bashrc or ~/.profile
umask 0077
```

With `umask 0077`, newly created files default to `0600` (files) or `0700`
(directories), so both the `.tmp` file and the final target are protected from
the moment of creation. The subsequent `chmod 0600` becomes a no-op
reinforcement.

## Path Traversal Protection

When using the `env.file` configuration shape, Fleet resolves the file path
relative to the directory containing `fleet.yml` and validates that it does not
escape the project directory.

### How it works

The check at `src/deploy/helpers.ts:228-232` performs two operations:

1.  **Resolve**: `path.resolve(configDir, config.env.file)` produces an
    absolute path by resolving the user-provided value against the config
    directory.
2.  **Validate**: The resolved path must either equal `configDir` or start with
    `configDir + path.sep`. If neither condition holds, the path has escaped the
    project directory and Fleet throws:

    ```
    env.file path "{path}" resolves outside the project directory
    -- path traversal is not allowed
    ```

### Examples

| `env.file` value | Resolved path | Result |
|-----------------|---------------|--------|
| `.env.production` | `/home/user/project/.env.production` | Allowed -- within project directory |
| `config/.env.staging` | `/home/user/project/config/.env.staging` | Allowed -- subdirectory of project |
| `../../etc/passwd` | `/etc/passwd` | **Rejected** -- escapes project directory |
| `/etc/shadow` | `/etc/shadow` | **Rejected** -- absolute path outside project |
| `../sibling/.env` | `/home/user/sibling/.env` | **Rejected** -- escapes project directory |

### The configDir assumption

The path traversal check depends on `configDir` being an absolute path. If
`configDir` were relative, `path.resolve` would resolve against the current
working directory, which could be manipulated to bypass the check.

In practice, `configDir` is always absolute because it is derived from
`path.dirname(path.resolve(filePath))` in the config loader, where `filePath`
is resolved to an absolute path first. This guarantee holds as long as the
config loader is the sole entry point for configuration.

## Transport Security

All remote commands -- including file uploads containing secret content -- are
executed over SSH, which provides encryption in transit. Fleet never transmits
secret values over unencrypted channels.

### How secret content travels

| Upload method | What is sent over SSH | Encoding |
|--------------|----------------------|----------|
| Heredoc | `KEY=VALUE` lines embedded in a shell heredoc | Plaintext within SSH-encrypted channel |
| Base64 | `KEY=VALUE` content base64-encoded in a shell command | Base64 within SSH-encrypted channel |

In both cases, the SSH channel provides the encryption layer. The base64
encoding is not a security measure -- it exists to avoid shell metacharacter
issues with arbitrary file content.

### Local execution path

The SSH connection factory at `src/ssh/factory.ts:7-8` routes connections to
`localhost` or `127.0.0.1` through a local execution path (Node.js
`child_process`) instead of SSH. In this case, secret content does not traverse
a network -- it stays within the local machine's process boundary. See
[SSH Connection Layer](../ssh-connection/overview.md) for details.

### What is not encrypted

Secret content is briefly present in plaintext in the following locations on
the remote server:

-   The shell process executing the upload command (in-memory)
-   The `.tmp` file on disk during atomic write (before `mv`)
-   The final `.env` file on disk (protected by `0600` permissions)

## Infisical Token Isolation

When using the [Infisical integration](./infisical-integration.md), the access
token **never reaches the remote server**. This is a key security advantage of
Fleet's SDK-based approach.

### Token lifecycle

| Stage | Location | Exposure |
|-------|----------|----------|
| Configuration | `process.env` on the Fleet CLI machine | In-memory only, duration of the `fleet` process |
| SDK authentication | `client.auth().accessToken(token)` in-memory | In-memory only, within the SDK client instance |
| API request | HTTPS request to Infisical API | Encrypted in transit (TLS) |
| After fetch | Discarded -- not persisted, not cached | No residual exposure |

### What is transmitted where

```
Fleet CLI machine                          Remote server
+-------------------------+                +----------------------+
| process.env.TOKEN ------+--HTTPS--> Infisical API               |
| SDK fetches secrets     |                |                      |
| Formats KEY=VALUE lines |                |                      |
| ------------------------+--SSH-->        | .env file (values    |
|                         |                | only, no token)      |
+-------------------------+                +----------------------+
```

The Infisical token is:

-   **NOT** in SSH command strings sent to the remote server
-   **NOT** visible in remote process lists (`ps aux`)
-   **NOT** written to remote shell history
-   **NOT** stored in the remote `.env` file or state file

Only the resulting `KEY=VALUE` content is uploaded to the remote server. The
token, project ID, environment name, and secret path remain local to the Fleet
CLI process.

### Why SDK over CLI

A hypothetical approach where the Infisical CLI runs on the remote server would
require transmitting the token to the server (as an environment variable or
command argument), installing the CLI binary on the server, and granting the
server outbound HTTPS access to the Infisical API. The SDK approach avoids all
three requirements, reducing the attack surface on the remote server.

## Docker Container Environment Access

### How containers receive environment variables

1.  Fleet writes the `.env` file to `{stackDir}/.env` on the remote server.
2.  Docker Compose reads the `.env` file at container start time.
3.  Docker Compose injects the variables into each container's environment.
4.  Containers access the variables through their standard environment
    (e.g., `process.env` in Node.js, `os.environ` in Python).

### Implications

-   Containers do **not** read the `.env` file directly at runtime. They
    receive environment variables through Docker's standard injection mechanism.
-   The `.env` file remains on disk after containers start. Containers do not
    need ongoing access to the file.
-   Updating the `.env` file (via `fleet env`) does not affect running
    containers. Services must be restarted to pick up new values -- use
    [`fleet restart`](../stack-lifecycle/restart.md) or
    [`fleet deploy`](../deploy/deploy-sequence.md).
-   Environment variables are visible inside the container via `/proc/1/environ`
    and `docker inspect`. Restrict access to the Docker socket and the remote
    server to limit exposure.

## fleet-proxy Network

### What it is

Fleet creates a Docker bridge network named `fleet-proxy` at
`src/deploy/helpers.ts:106`. The creation is idempotent -- the command
suppresses the "already exists" error on subsequent runs.

### Why it exists

The [Caddy reverse proxy](../caddy-proxy/overview.md) runs as a standalone
Docker container. To forward HTTP traffic to service containers, Caddy must
share a Docker network with those containers. The `fleet-proxy` bridge network
provides this connectivity:

1.  The Caddy container is attached to `fleet-proxy` during
    [bootstrap](../bootstrap/bootstrap-sequence.md).
2.  Each deployed service container is attached via
    `docker network connect fleet-proxy {container}`.
3.  Caddy can now resolve service container hostnames and forward traffic.

### Security implications

Containers attached to the same Docker bridge network can communicate with each
other over any port. This means:

-   All service containers on `fleet-proxy` can reach each other directly,
    bypassing Caddy.
-   A compromised container could probe or connect to other services on the
    network.
-   This is standard Docker bridge network behavior and is consistent with
    running all services on a single host.

If service-to-service isolation is required, consider deploying services on
separate servers or using Docker network policies (available with Docker
Enterprise or third-party network plugins).

## State File Security

### What the state file contains

The state file at `~/.fleet/state.json` on the remote server stores operational
metadata:

-   SHA-256 content hashes (for change detection)
-   File paths (stack directories, compose file locations)
-   Timestamps (last deploy time)
-   Container metadata (service names, image references)
-   Route information (domains, ports)

The state file contains **no secret values** -- no passwords, no API keys, no
tokens. See [State and Change Detection](./state-data-model.md) for the
full schema.

### Permission model

The state file is written using the atomic `.tmp` + `mv` pattern but does
**not** have an explicit `chmod` applied. It inherits the default umask
permissions of the deploy user (commonly `0644`).

### Recommendations

Although the state file contains no secrets, it does expose operational details
(stack names, directory paths, service names, deployed image tags). For
defense-in-depth:

-   Set the deploy user's umask to `0077` so the state file defaults to `0600`.
-   Restrict SSH access to the server to authorized operators only.
-   Monitor the state file for unexpected modifications (a tampered state file
    could cause unnecessary redeployments but cannot expose secrets).

## Threat Model Summary

| Threat vector | Mitigation | Residual risk |
|--------------|------------|---------------|
| Unauthorized `.env` file read on server | `0600` file permissions (owner read/write only) | Brief timing window during atomic write; mitigate with restrictive umask |
| Path traversal via `env.file` | `path.resolve` + `startsWith` check against config directory | None, provided `configDir` is absolute (guaranteed by config loader) |
| Secret exposure in transit | All remote commands execute over SSH (encrypted channel) | None for remote; local execution stays in-process |
| Infisical token theft on remote server | Token never leaves local machine; SDK runs locally, HTTPS to API | Token exposure limited to local `process.env` and SDK memory |
| Permission timing window | `chmod 0600` applied immediately after `mv` | Millisecond window; eliminate with `umask 0077` |
| State file tampering | State file contains no secrets; tampering causes redeployment, not secret exposure | Operational metadata (paths, service names) is exposed |
| Concurrent write race condition | Atomic `.tmp` + `mv` prevents partial writes | No file-level locking; concurrent deploys could overwrite each other |
| Container-to-container traffic | `fleet-proxy` bridge network; standard Docker network isolation | Containers on the same bridge can communicate on any port |

## Hardening Recommendations

For production and high-security environments, consider the following measures:

1.  **Restrict the deploy user's umask** to `0077`. This ensures all files
    (`.env`, `.tmp`, state file) are created with restrictive permissions from
    the start, eliminating the timing window.

2.  **Use short-lived Infisical tokens.** Configure Machine Identity tokens
    with short expiration times, or use Universal Auth with pre-flight token
    exchange in CI/CD pipelines. Revoke tokens after deployment completes.

3.  **Restrict the Infisical Machine Identity scope.** Grant read-only access
    to only the specific project, environment, and path required by each stack.

4.  **Chmod the state file.** Add a post-deploy step or configure umask so
    `~/.fleet/state.json` is not world-readable. While it contains no secrets,
    it reveals operational metadata.

5.  **Restrict the SSH deploy user.** Use a dedicated user with minimal
    privileges -- only the permissions required to manage Docker containers and
    write to the Fleet state and stack directories. Avoid using `root`.

6.  **Serialize deploys to the same stack.** Fleet does not implement file-level
    locking. Concurrent deploys to the same stack on the same server could
    produce race conditions. Use CI/CD pipeline concurrency controls to ensure
    only one deploy runs per stack at a time.

7.  **Restrict Docker socket access.** The Docker socket (`/var/run/docker.sock`)
    grants full control over all containers. Limit access to the deploy user and
    system administrators.

8.  **Monitor `.env` file access.** Use Linux audit tools (`auditd`) to log
    reads and writes to `.env` files in stack directories for forensic
    visibility.

9.  **Review bridge network exposure.** If service-to-service isolation is
    required, evaluate whether all services should share the `fleet-proxy`
    network, or if additional network segmentation is needed.

## Related documentation

-   [Environment and Secrets Overview](./overview.md) -- the complete
    `fleet env` workflow and secrets resolution pipeline
-   [Environment Configuration Shapes](./env-configuration-shapes.md) -- the
    three `env` field formats and their upload mechanisms
-   [Infisical Integration](./infisical-integration.md) -- SDK authentication,
    token types, and token security analysis
-   [Troubleshooting](./troubleshooting.md) -- failure modes, error messages,
    and recovery procedures
-   [State and Change Detection](./state-data-model.md) -- how `env_hash`
    drives the classification decision tree
-   [Secrets Resolution (Deploy)](../deploy/secrets-resolution.md) -- how
    secrets resolution runs during `fleet deploy`
-   [SSH Connection Layer](../ssh-connection/overview.md) -- the encrypted
    transport layer for all remote commands
-   [Caddy Reverse Proxy](../caddy-proxy/overview.md) -- the proxy that uses
    the `fleet-proxy` network
-   [State Management Overview](../state-management/overview.md) -- state file
    schema, lifecycle, and atomic write pattern
-   [State Operations Guide](../state-management/operations-guide.md) -- backup
    and recovery procedures for the state file
-   [Bootstrap Sequence](../bootstrap/bootstrap-sequence.md) -- initial server
    setup including `fleet-proxy` network creation
-   [Configuration Integrations](../configuration/integrations.md) -- how
    Infisical tokens are handled at config load time
-   [Deploy Failure Recovery](../deploy/failure-recovery.md) -- recovery
    procedures when secret resolution fails mid-deployment
