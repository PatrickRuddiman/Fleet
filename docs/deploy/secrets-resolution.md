# Secrets Resolution

## What This Covers

Fleet supports three mutually exclusive strategies for providing environment
variables to deployed services. The `resolveSecrets()` function at
`src/deploy/helpers.ts:198-287` handles all three, producing a `.env` file with
`0600` permissions in the stack directory on the remote server.

## Why Three Strategies Exist

Different deployment contexts have different security and operational
requirements:

- **Inline entries**: Simple key-value pairs defined directly in `fleet.yml`.
  Convenient for non-sensitive configuration but unsuitable for secrets since
  they are stored in plain text in the config file.
- **Local file upload**: A `.env` file on the operator's machine is uploaded to
  the server. Works well for CI/CD pipelines that inject secrets into the
  environment and write them to a file before deploying.
- **Infisical export**: Secrets are fetched directly on the remote server from
  the Infisical secrets management platform. The operator never has the secret
  values on their local machine.

## Strategy Selection

The `env` field in `fleet.yml` determines which strategy is used. The field
accepts three shapes, enforced by the
[configuration schema](../configuration/schema-reference.md):

```mermaid
flowchart TD
    Start{env field in fleet.yml?} -->|Not present| NoEnv[No .env file created]
    Start -->|"{ file: path }"| FileUpload[Upload local .env file via base64]
    Start -->|"Array of { key, value }"| InlineEntries[Build .env from key-value pairs]
    Start -->|"{ entries?, infisical? }"| ObjectForm
    ObjectForm --> HasEntries{Has entries?}
    HasEntries -->|Yes| WriteEntries[Write entries to .env]
    HasEntries -->|No| CheckInfisical
    WriteEntries --> CheckInfisical{Has infisical?}
    CheckInfisical -->|Yes| ExportInfisical[Remote infisical export → .env]
    CheckInfisical -->|No| Done[Done]
    ExportInfisical --> SetPerms[chmod 0600]
    SetPerms --> Done

    FileUpload --> Done
    InlineEntries --> Done
```

### Strategy summary

| Strategy | `fleet.yml` syntax | Mechanism | Source |
|----------|--------------------|-----------|--------|
| **File upload** | `env: { file: .env.production }` | Base64-encode local file, decode on server | `helpers.ts:208-236` |
| **Inline entries** | `env: [{ key, value }, ...]` | Concatenate key=value lines, upload via heredoc | `helpers.ts:238-252` |
| **Infisical export** | `env: { infisical: { ... } }` | Run `infisical export` on server, output to `.env` | `helpers.ts:266-286` |

All strategies produce a `{stackDir}/.env` file with `0600` permissions.
File-upload mode includes path-traversal protection. For the upload mechanisms
used by each strategy, see [Atomic File Uploads](file-upload.md). For full
configuration examples, per-strategy behavior, and edge cases, see
[Env Configuration Shapes](../env-secrets/env-configuration-shapes.md).

## Infisical Integration

Fleet integrates with [Infisical](https://infisical.com/docs) for centralized
secrets management. During deployment, Fleet bootstraps the Infisical CLI on
the remote server (Debian/Ubuntu only via `apt-get`), then runs
`infisical export` with the token passed as an environment variable (not a CLI
flag) to avoid process-list exposure. The token field supports `$VAR` expansion
at config load time for CI/CD integration.

For full details on CLI bootstrap, authentication, token rotation, and network
requirements, see
[Infisical Integration](../env-secrets/infisical-integration.md).

## The --env-file Flag

When Docker Compose starts containers, the `--env-file` flag tells it to load
environment variables from the specified file. The `configHasSecrets()` function
at `src/deploy/helpers.ts:409-423` determines whether this flag is needed:

- Returns `true` if any env source is configured (file, entries, or Infisical)
- Returns `false` if `env` is absent or empty

When the flag is included, Docker Compose passes the `.env` file contents as
environment variables to all services in the stack. Services can reference these
variables in their compose definitions using `${VAR_NAME}` syntax.

## File Permissions

All `.env` files are written with `0600` permissions (owner read/write only).
This applies to all three strategies:

- **File upload and inline entries**: Permissions are set via the `permissions`
  parameter of the upload functions
- **Infisical export**: Permissions are set by a separate `chmod 0600` command
  after the export completes

## Related documentation

- [17-Step Deploy Sequence](deploy-sequence.md)
- [Atomic File Uploads](file-upload.md) -- heredoc and base64 upload mechanisms
- [Integrations Reference](integrations.md)
- [Deployment Pipeline Overview](../deployment-pipeline.md)
- [Env Configuration Shapes](../env-secrets/env-configuration-shapes.md) --
  detailed per-shape documentation and examples
- [Infisical Integration](../env-secrets/infisical-integration.md) -- deep dive
  on Infisical CLI bootstrap and authentication
- [Environment and Secrets Overview](../env-secrets/overview.md) -- the complete
  `fleet env` workflow
- [Configuration Environment Variables](../configuration/environment-variables.md)
  -- `$VAR` expansion mechanism
- [Validation Codes Reference](../validation/validation-codes.md) -- includes
  `ENV_CONFLICT` validation code
- [Fleet Root Directory Layout](../fleet-root/directory-layout.md) -- where
  `.env` files and secrets are stored on the remote host
