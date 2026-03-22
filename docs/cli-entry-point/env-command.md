# Env Command

The `fleet env` command pushes or refreshes secrets (`.env` files) on the remote
server for the current stack. It synchronizes environment variables from local
configuration or a remote secrets manager to the deployed stack without requiring
a full redeployment.

## Usage

```
fleet env
```

This command takes no arguments or options.

## What `fleet env` does

The command delegates to `pushEnv()` from `src/env/env.ts` (in the
[env-secrets](../env-secrets/) group). The operation:

1. Loads `fleet.yml` from the current directory
2. Opens an SSH connection to the remote server
3. Resolves the environment configuration from `fleet.yml`
4. Writes the `.env` file to the stack directory on the remote server

## Environment configuration sources

The `env` field in `fleet.yml` supports three formats (defined in
`src/config/schema.ts:26-29` and `src/config/schema.ts:57`):

### Inline entries

Define key-value pairs directly in `fleet.yml`:

```yaml
env:
  entries:
    - key: DATABASE_URL
      value: postgres://user:pass@db:5432/mydb
    - key: REDIS_URL
      value: redis://redis:6379
```

### File reference

Point to a local `.env` file:

```yaml
env:
  file: .env.production
```

### Infisical (secrets manager)

Fetch secrets from [Infisical](https://infisical.com/docs):

```yaml
env:
  infisical:
    token: st.xxxx.yyyy
    project_id: 64a1b2c3d4e5f6a7b8c9d0e1
    environment: production
    path: /
```

### Conflict: entries + infisical

If both `entries` and `infisical` are configured in the same `env` block, the
[`fleet validate`](../validation/validate-command.md) command reports an
[`ENV_CONFLICT`](../validation/validation-codes.md#env_conflict) error. This is because
Infisical overwrites the `.env` file produced by inline entries, making the
entries effectively useless.

## Infisical integration

Fleet can pull secrets from [Infisical](https://infisical.com), a secrets
management platform.

### How the Infisical CLI is provisioned

When `fleet env` (or `fleet deploy` with an Infisical config) runs, Fleet
checks whether the Infisical CLI is installed on the remote server. If not, it
bootstraps it via `src/deploy/infisical.ts`:

1. **Check**: Runs `which infisical` on the remote server
2. **Install**: If missing, fetches the Infisical Debian/Ubuntu repository setup
   script from `dl.cloudsmith.io` and installs via `apt-get`
3. **Verify**: Confirms installation by running `infisical --version`

The Infisical CLI is installed without version pinning (`apt-get install -y
infisical`), meaning the latest version is always installed. In production
environments, consider pinning to a specific version for reproducibility.

### Authentication

The Infisical service token (`token` field in `fleet.yml`) is a legacy
authentication method. Infisical also supports Universal Auth and Machine
Identity tokens. The token is passed to the Infisical CLI at runtime -- Fleet
does not store it on the remote server beyond the current session.

### Token rotation

To rotate an Infisical service token:

1. Generate a new token in the Infisical dashboard for your project
2. Update the `token` field in `fleet.yml`
3. Run `fleet env` to push the updated secrets

### Network requirements

The Infisical CLI bootstrap requires outbound HTTPS access from the remote
server to:

- `dl.cloudsmith.io` (for APT repository setup during installation)
- `artifacts-cli.infisical.com` (for package downloads)
- `app.infisical.com` (or your self-hosted Infisical instance, for secret
  fetching at runtime)

### Failure behavior

- **Infisical unreachable during installation**: The bootstrap throws an error
  with the exit code and stderr output. The `fleet env` command fails and exits
  with code 1. There is no retry logic or fallback installation method.
- **Infisical unreachable during secret fetch**: The Infisical CLI reports the
  error. Fleet propagates this as a deployment/env push failure.

## Troubleshooting

### "Env push failed with an unknown error"

Check SSH connectivity and ensure the `server` section in `fleet.yml` is
correct. Verify the remote server has network access to Infisical (if
configured).

### Secrets not taking effect after `fleet env`

Running `fleet env` only writes the `.env` file. Services need to be restarted
to pick up the new values. Use [`fleet restart`](../stack-lifecycle/restart.md) `<stack> <service>` or
[`fleet deploy`](./deploy-command.md) to apply changes. Note that `docker compose restart` re-reads the
`.env` file without recreating containers.

## Related documentation

- [CLI Overview](overview.md) -- command registration and entry points
- [CLI Architecture](architecture.md) -- how commands are structured
- [Deploy Command](deploy-command.md) -- deploy also handles env synchronization
- [Environment and Secrets Overview](../env-secrets/overview.md) -- the
  `pushEnv()` function and three env configuration shapes
- [Infisical Integration](../env-secrets/infisical-integration.md) -- CLI
  bootstrap and authentication details
- [Environment Configuration Shapes](../env-secrets/env-configuration-shapes.md) --
  detailed format reference for each env mode
- [Service Classification](../deploy/service-classification-and-hashing.md) --
  how env hash changes trigger restarts
- [Secrets Resolution](../deploy/secrets-resolution.md) -- how secrets are
  resolved during deployment
- [Configuration Schema](../configuration/schema-reference.md) -- `env` field
  specification in `fleet.yml`
- [Validation Codes](../validation/validation-codes.md) -- `ENV_CONFLICT` error
  when both entries and infisical are configured
- [SSH Connection Layer](../ssh-connection/overview.md) -- how remote commands
  are executed
