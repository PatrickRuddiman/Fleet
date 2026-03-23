# CI/CD Integration Guide

Fleet is a non-interactive CLI tool designed for automation. Every command accepts configuration through files and flags, making it straightforward to integrate into any CI/CD pipeline. This guide covers image tagging strategies, secrets management, validation gates, SSH authentication, and provides a complete GitHub Actions workflow example.

## Image Tagging Strategy

Tag your Docker images with the **git commit SHA**. Commit SHAs are immutable, directly traceable to source code, and enable simple rollbacks by redeploying a previous SHA.

In your `docker-compose.yml`, reference the tag through a variable:

```yaml
services:
  myapp:
    image: ghcr.io/yourorg/myapp:${IMAGE_TAG}
    ports:
      - "3000:3000"
```

Your CI pipeline builds and pushes the image tagged with the commit SHA, then writes `IMAGE_TAG` into the `.env` file that Docker Compose reads:

```bash
# In your CI pipeline
echo "IMAGE_TAG=$GITHUB_SHA" >> .env.production
```

Fleet's `env.file` mode uploads this file to the server, where Docker Compose picks up the variable during container startup.

**Avoid `latest` or date-based tags.** These are mutable — the same tag can point to different images over time, which breaks rollback traceability. If you need to roll back, you cannot reliably recover a previous `latest` image. With commit SHAs, rolling back is as simple as redeploying the SHA from the last known-good commit.

## Secrets Management

Fleet supports three modes for managing environment variables and secrets,
defined in the `env` field of [`fleet.yml`](./configuration/overview.md). See
[Environment Configuration Shapes](./env-secrets/env-configuration-shapes.md)
for detailed format specifications.

### Mode 1: Inline Key-Value Entries

An array of `{ key, value }` pairs defined directly in `fleet.yml`:

```yaml
env:
  - key: NODE_ENV
    value: production
  - key: IMAGE_TAG
    value: abc123def
```

Fleet concatenates these into a `.env` file and uploads it to the server. This mode is simple but not ideal for secrets, since values are stored in plain text in `fleet.yml`.

### Mode 2: File Reference (`env.file`)

Reference a local `.env` file that Fleet uploads to the server:

```yaml
env:
  file: .env.production
```

Fleet reads the file, base64-encodes its contents for transfer (avoiding shell metacharacter issues), writes it to the stack directory on the remote server, and sets permissions to `0600`.

**This is the recommended mode for CI/CD.** Your pipeline writes secrets from its secret store into a local `.env` file at build time, and Fleet handles the secure upload.

### Mode 3: Infisical Integration (`env.infisical`)

For teams using [Infisical](./env-secrets/infisical-integration.md) for secrets
management:

```yaml
env:
  entries:
    - key: IMAGE_TAG
      value: abc123def
  infisical:
    token: $INFISICAL_TOKEN
    project_id: your-project-id
    environment: production
    path: /
```

The `token` field supports `$ENV_VAR` expansion — Fleet's config loader reads the environment variable at runtime and substitutes it. This means the actual Infisical token never appears in `fleet.yml`. The `path` field defaults to `"/"` if omitted.

This mode runs `infisical export` on the remote server, so the Infisical CLI must be installed there.

### Rotating Secrets Without Redeployment

The `fleet env` command pushes the `.env` file to the server for an already-deployed stack without running a full redeployment. It writes the file with `0600` permissions. Use this to rotate secrets or update environment variables on a running stack:

```bash
npx fleet env
```

This command takes no arguments or flags. It requires that `fleet deploy` has been run at least once for the stack (it looks up the stack in the server state).

## Pipeline Gate: `fleet validate`

`fleet validate` checks your `fleet.yml` and compose file for errors **locally**
— it requires **no SSH connection** and makes no remote calls. It should be the
**first step** after checkout in any CI pipeline, catching configuration errors
before any resources are consumed. For full details, see the
[validate command reference](./validation/validate-command.md).

### Usage

```bash
npx fleet validate [file]
```

The optional `[file]` positional argument specifies the path to the Fleet configuration file. It defaults to `./fleet.yml`.

### Exit Codes

| Code | Meaning |
|------|---------|
| `0`  | Validation passed — no errors found |
| `1`  | Validation failed — errors found |

### What It Checks

1. **FQDN format** — Route domains must be valid fully qualified domain names
2. **Port range** — Ports must be integers between 1 and 65535
3. **Duplicate hosts** — No two routes may share the same domain
4. **Reserved port conflicts** — No host port 80 or 443 bindings in compose (these are used by the Caddy reverse proxy)
5. **Service existence** — Route services must exist in the compose file
6. **Host port exposure** — Warns about non-80/443 host port bindings
7. **Missing image or build** — Warns about services without an `image` or `build` directive

Validation failures cause the pipeline to exit early, preventing broken configurations from reaching deployment.

## SSH Key Handling in CI

Fleet connects to the target server over SSH. In CI environments where there is
no interactive SSH setup, you have two options. See
[SSH Authentication](./ssh-connection/authentication.md) for in-depth coverage of
authentication methods.

### Option 1: `identity_file` (Recommended for CI)

Store your SSH private key as a CI secret (e.g., `SSH_PRIVATE_KEY` in GitHub Actions). At pipeline runtime, write it to a temporary file with restricted permissions, then reference the path in `fleet.yml`:

```bash
echo "$SSH_PRIVATE_KEY" > /tmp/deploy_key
chmod 600 /tmp/deploy_key
```

Reference the key in `fleet.yml`:

```yaml
server:
  host: your-server.example.com
  user: deploy
  port: 22
  identity_file: /tmp/deploy_key
```

Fleet supports tilde expansion (`~` resolves to the home directory), but in CI a full path like `/tmp/deploy_key` is clearer and avoids ambiguity.

### Option 2: SSH Agent

Start `ssh-agent`, add the key, and Fleet will automatically use the `SSH_AUTH_SOCK` environment variable when no `identity_file` is configured in `fleet.yml`:

```bash
eval $(ssh-agent -s)
echo "$SSH_PRIVATE_KEY" | ssh-add -
```

Then omit the `identity_file` field from `fleet.yml`:

```yaml
server:
  host: your-server.example.com
  user: deploy
  port: 22
```

Fleet detects the running agent through `SSH_AUTH_SOCK` and uses it for authentication.

## GitHub Actions Workflow Example

Below is a complete workflow that builds a Docker image, pushes it to a container registry, writes the environment file, validates the Fleet configuration, and deploys.

### `fleet.yml`

This configuration file lives in your repository root:

```yaml
version: "1"
server:
  host: your-server.example.com
  user: deploy
  port: 22
  identity_file: /tmp/deploy_key
stack:
  name: myapp-production
  compose_file: docker-compose.yml
env:
  file: .env.production
routes:
  - domain: myapp.example.com
    port: 3000
    service: myapp
    tls: true
    acme_email: ops@example.com
    health_check:
      path: /health
      timeout_seconds: 30
      interval_seconds: 5
```

### `docker-compose.yml`

```yaml
services:
  myapp:
    image: ghcr.io/yourorg/myapp:${IMAGE_TAG}
    ports:
      - "3000:3000"
    env_file:
      - .env
    restart: unless-stopped
```

### `.github/workflows/deploy.yml`

```yaml
name: Build and Deploy

on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/yourorg/myapp:${{ github.sha }}

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Fleet
        run: npm install

      - name: Write environment file
        run: |
          cat <<EOF > .env.production
          IMAGE_TAG=${{ github.sha }}
          DATABASE_URL=${{ secrets.DATABASE_URL }}
          REDIS_URL=${{ secrets.REDIS_URL }}
          API_SECRET=${{ secrets.API_SECRET }}
          NODE_ENV=production
          EOF

      - name: Validate Fleet configuration
        run: npx fleet validate

      - name: Write SSH key
        run: |
          echo "${{ secrets.SSH_PRIVATE_KEY }}" > /tmp/deploy_key
          chmod 600 /tmp/deploy_key

      - name: Deploy
        run: npx fleet deploy
```

### How It Works

1. **Checkout** — Clones the repository, giving access to `fleet.yml`, `docker-compose.yml`, and the application source.
2. **Build & Push** — Builds the Docker image and pushes it to `ghcr.io` tagged with the git commit SHA (`${{ github.sha }}`).
3. **Install Fleet** — Installs Fleet and its dependencies via npm.
4. **Write environment file** — Assembles `.env.production` from GitHub Actions secrets, including `IMAGE_TAG` set to the commit SHA. This file never enters version control.
5. **Validate** — Runs `fleet validate` to catch configuration errors before any SSH connection is made. If validation fails, the pipeline stops here.
6. **Write SSH key** — Writes the deploy key from GitHub Actions secrets to a temporary file with `600` permissions.
7. **Deploy** — Runs `fleet deploy`, which connects to the server, uploads the compose file and environment, pulls the image, starts containers, configures Caddy routes, and runs [health checks](./deploy/health-checks.md).

## Out of Scope (Fleet v1 Limitations)

Fleet v1 is focused on single-server Docker Compose deployments behind Caddy. The following capabilities are **not** included:

- **No image building** — Fleet deploys pre-built images. Build your images in your CI pipeline before running `fleet deploy`.
- **No deployment history or rollback tracking** — Fleet does not maintain a history of previous deployments. Roll back by redeploying a previous git commit SHA.
- **No multi-server support** — Each `fleet.yml` targets a single server. For multiple servers, use separate `fleet.yml` files and pipeline jobs.
- **No blue/green or canary deployment strategies** — Fleet performs in-place deployments by updating the running containers.
- **No TLS pass-through** — TLS is terminated at the Caddy reverse proxy. Fleet does not support forwarding encrypted traffic directly to application containers.
- **No web dashboard or UI** — Fleet is a CLI-only tool.
- **No `fleet.yml` inheritance or composition** — Each `fleet.yml` is a standalone, self-contained configuration file.
- **No native CI platform integrations** — Fleet is a standard CLI tool that works in any environment where Node.js is available. It has no built-in plugins for GitHub Actions, GitLab CI, or other platforms.

## Related documentation

- [Deploy Command](./cli-entry-point/deploy-command.md) -- the `fleet deploy`
  command used in CI pipelines
- [Validate Command](./validation/validate-command.md) -- pre-flight validation
  for CI gates
- [Configuration Loading and Validation](./configuration/loading-and-validation.md)
  -- how `fleet.yml` is parsed and validated
- [Configuration Schema Reference](./configuration/schema-reference.md) -- full
  `fleet.yml` field reference
- [Environment and Secrets Overview](./env-secrets/overview.md) -- secrets
  management strategies
- [Infisical Integration](./env-secrets/infisical-integration.md) -- Infisical
  token provisioning and CI/CD usage
- [SSH Authentication](./ssh-connection/authentication.md) -- SSH key and agent
  authentication
- [SSH Connection Lifecycle](./ssh-connection/connection-lifecycle.md) -- how
  connections are managed during CLI commands
- [Deployment Pipeline](./deployment-pipeline.md) -- the full deploy workflow
- [Configuration Overview](./configuration/overview.md) -- how `fleet.yml` is
  structured and loaded
- [Fleet Root Discovery](./fleet-root/overview.md) -- how Fleet locates the
  project root containing `fleet.yml`
- [Health Checks](./deploy/health-checks.md) -- post-deployment health check
  verification
