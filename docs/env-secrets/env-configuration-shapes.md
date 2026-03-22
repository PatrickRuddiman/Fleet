# Environment Configuration Shapes

## What This Covers

The `env` field in `fleet.yml` accepts three mutually exclusive shapes,
implemented as a Zod union type at `src/config/schema.ts:57`. Each shape
triggers a different code path in `resolveSecrets()` at
`src/deploy/helpers.ts:198-287`. This page documents each shape, how it is
parsed, what upload mechanism it uses, and the validation rules that apply.

## Why Three Shapes Exist

Different deployment contexts have different requirements:

- **Inline entries**: Operators who want to define non-sensitive configuration
  directly in `fleet.yml` without maintaining a separate file.
- **File reference**: CI/CD pipelines that generate `.env` files as build
  artifacts, or teams that manage `.env` files separately from Fleet config.
- **Infisical object**: Teams using centralized secrets management who want
  secrets fetched directly on the server without passing through the operator's
  machine.

## Configuration Shape Decision Tree

```mermaid
flowchart TD
    START{"env field present<br/>in fleet.yml?"} -- No --> NONE["No .env file created"]
    START -- Yes --> PARSE{"What shape?"}
    
    PARSE -- "Array" --> ARRAY["Array of { key, value }"]
    PARSE -- 'Has "file" key' --> FILE["{ file: string }"]
    PARSE -- 'Has "entries" or "infisical"' --> OBJECT["{ entries?, infisical? }"]
    
    ARRAY --> HEREDOC["Upload via heredoc"]
    FILE --> B64["Upload via base64"]
    OBJECT --> HAS_ENTRIES{"Has entries?"}
    HAS_ENTRIES -- Yes --> WRITE_ENTRIES["Write entries via heredoc"]
    HAS_ENTRIES -- No --> CHECK_INF
    WRITE_ENTRIES --> CHECK_INF{"Has infisical?"}
    CHECK_INF -- Yes --> EXPORT["infisical export > .env<br/>(OVERWRITES entries)"]
    CHECK_INF -- No --> DONE["Done"]
    EXPORT --> CHMOD["chmod 0600"]
    
    HEREDOC --> DONE
    B64 --> DONE
    CHMOD --> DONE
```

## Shape 1: Inline Key-Value Array

The simplest form. Define environment variables directly in `fleet.yml` as an
array of objects with `key` and `value` fields.

### Configuration

```yaml
env:
  - key: DATABASE_URL
    value: postgres://user:pass@db:5432/mydb
  - key: REDIS_URL
    value: redis://redis:6379
  - key: LOG_LEVEL
    value: info
```

### Schema

Defined by `z.array(envEntrySchema)` at `src/config/schema.ts:57`, where
`envEntrySchema` is:

```
{ key: z.string(), value: z.string() }
```

Source: `src/config/schema.ts:10-13`

### How it works

1. Each entry is formatted as `KEY=VALUE`
2. Lines are joined with newlines, plus a trailing newline
3. The content is uploaded using the **heredoc** method (`uploadFile` at
   `src/deploy/helpers.ts:140-162`, documented in
   [Atomic File Uploads](../deploy/file-upload.md))
4. Permissions are set to `0600`

Source: `src/deploy/helpers.ts:238-252`

### When to use

- Non-sensitive configuration values
- Simple setups where maintaining a separate `.env` file is unnecessary
- Development and staging environments

### Limitations

- Values are stored in plain text in `fleet.yml`, which is typically committed
  to version control. Do not use for passwords, API keys, or other secrets.
- Shell metacharacters in values may interact with the heredoc upload. The
  heredoc delimiter `FLEET_EOF` is unlikely to appear in normal env values, but
  if a value contains the literal string `FLEET_EOF` on its own line, the
  upload will break.

## Shape 2: File Reference

Point to a local `.env` file that is uploaded to the remote server.

### Configuration

```yaml
env:
  file: .env.production
```

The path is resolved relative to the directory containing `fleet.yml`.

### Schema

Defined by `envFileSchema` at `src/config/schema.ts:15-17`:

```
{ file: z.string() }
```

### How it works

1. The file path is resolved relative to the `fleet.yml` directory
2. **Path traversal protection**: The resolved path is checked to ensure it
   stays within the project directory (`src/deploy/helpers.ts:216-219`).
   Paths like `../../etc/passwd` are rejected.
3. The file content is read from the local filesystem
4. Content is **base64-encoded**, transmitted over SSH, decoded on the remote
   server, and written to `{stackDir}/.env` (see
   [Atomic File Uploads](../deploy/file-upload.md) for details on the base64
   upload method)
5. Permissions are set to `0600`

Source: `src/deploy/helpers.ts:208-236`

### Why base64 instead of heredoc

The file upload strategy (Shape 2) uses `uploadFileBase64` while the inline
entries strategy (Shape 1) uses `uploadFile` with heredoc. The reason is
documented at `src/deploy/helpers.ts:164-168`:

> Uses base64 encoding over SSH exec. This avoids heredoc delimiter and shell
> metacharacter issues with arbitrary file content.

A `.env` file can contain any content -- quotes, dollar signs, backslashes,
newlines within values, and even binary-like content. Base64 encoding
neutralizes all special characters, ensuring reliable transmission over the SSH
exec channel.

### When to use

- CI/CD pipelines that inject secrets as environment variables and write them
  to a `.env` file before deployment
- Teams that manage `.env` files in a separate secrets store (e.g., 1Password,
  Vault) and download them before deploying
- Migration from manual `scp`-based `.env` file deployment

### Path traversal example

```yaml
# Allowed — resolves within the project directory
env:
  file: .env.production

# Allowed — subdirectory
env:
  file: config/.env.staging

# REJECTED — escapes the project directory
env:
  file: ../../etc/passwd
```

The check at `src/deploy/helpers.ts:216-219` verifies:

```typescript
if (!envFilePath.startsWith(configDir + path.sep) && envFilePath !== configDir) {
    throw new Error(`env.file path "..." resolves outside the project directory`);
}
```

## Shape 3: Object with Entries and/or Infisical

The most flexible form, allowing optional inline entries combined with optional
Infisical secret fetching.

### Configuration (entries only)

```yaml
env:
  entries:
    - key: LOG_LEVEL
      value: info
    - key: NODE_ENV
      value: production
```

### Configuration (Infisical only)

```yaml
env:
  infisical:
    token: $INFISICAL_TOKEN
    project_id: proj_abc123
    environment: production
    path: /
```

### Configuration (both — produces validation error)

```yaml
# WARNING: This triggers ENV_CONFLICT validation error
env:
  entries:
    - key: LOG_LEVEL
      value: info
  infisical:
    token: $INFISICAL_TOKEN
    project_id: proj_abc123
    environment: production
    path: /
```

### Schema

Defined by `envSchema` at `src/config/schema.ts:26-29`:

```
{
    entries: z.array(envEntrySchema).optional(),
    infisical: infisicalSchema.optional()
}
```

### How it works

1. If `entries` is present and non-empty, they are formatted as `KEY=VALUE`
   lines and uploaded via heredoc to `{stackDir}/.env`
2. If `infisical` is present, the Infisical CLI runs on the remote server:
   ```bash
   INFISICAL_TOKEN={token} infisical export \
       --projectId={project_id} --env={environment} \
       --path={path} --format=dotenv > {stackDir}/.env
   ```
3. The `>` redirect **overwrites** the `.env` file — if both entries and
   Infisical are configured, the entries are lost

Source: `src/deploy/helpers.ts:254-286`

### The entries + infisical conflict

The validation module at `src/validation/fleet-checks.ts:4-25` detects when
both `entries` (non-empty) and `infisical` are configured and reports:

> **Error (ENV_CONFLICT)**: "env.entries" and "env.infisical" are both
> configured, but "env.infisical" will overwrite the ".env" file produced
> by "env.entries".

**Resolution**: Use either `env.entries` or `env.infisical`, not both. If you
need variables from both sources, consolidate them into a single Infisical
project or manage a combined `.env` file using the file reference shape.

### When to use

- **Entries only**: Same use case as Shape 1, but within the object syntax
  (useful if you plan to add Infisical later)
- **Infisical only**: Centralized secrets management where all variables come
  from Infisical
- **Neither**: Not useful — use `configHasSecrets()` to check if any env
  source is present

## How Docker Compose Consumes the `.env` File

The `.env` file written by any of the three strategies is consumed by Docker
Compose via the `--env-file` flag. The `configHasSecrets()` function at
`src/deploy/helpers.ts:409-423` determines whether this flag is needed:

```typescript
if (!config.env) return false;
if ("file" in config.env) return true;
if (Array.isArray(config.env)) return config.env.length > 0;
return (config.env.entries?.length > 0) || (config.env.infisical !== undefined);
```

When the flag is included, the deploy pipeline passes it to
`docker compose up`:

```bash
docker compose -p {stackName} --env-file {stackDir}/.env up -d
```

Docker Compose makes the variables available to all services in the stack.
Services can reference them in their compose file using `${VAR_NAME}` syntax
in `environment`, `command`, or other fields that support variable
interpolation.

See the [Docker Compose env_file documentation](https://docs.docker.com/compose/environment-variables/set-environment-variables/#use-the-env_file-attribute)
for more details on how Docker Compose handles environment files.

## Type Narrowing in Code

Because the `env` field is a union of three shapes, every consumer must use
type narrowing to determine which shape is active. The pattern used throughout
the codebase is:

```typescript
// Shape 2: File reference
if ("file" in config.env) { ... }

// Shape 1: Array of entries
if (Array.isArray(config.env)) { ... }

// Shape 3: Object with entries and/or infisical
// (reached by elimination after the above checks)
if (config.env.entries) { ... }
if (config.env.infisical) { ... }
```

This pattern appears in:

- `src/deploy/helpers.ts:204-286` (resolveSecrets)
- `src/env/env.ts:45` (Infisical bootstrap check)
- `src/deploy/helpers.ts:409-423` (configHasSecrets)
- `src/config/loader.ts:30-33` (`$VAR` expansion)
- `src/validation/fleet-checks.ts:4-25` (conflict detection)

## Related Documentation

- [Environment and Secrets Overview](./overview.md) -- the complete `fleet env`
  workflow
- [Infisical Integration](./infisical-integration.md) -- deep dive on the
  Infisical secret source
- [Troubleshooting](./troubleshooting.md) -- failure modes and recovery
- [Configuration Schema Reference](../configuration/schema-reference.md) --
  full field-by-field specification
- [Configuration Environment Variables](../configuration/environment-variables.md) --
  `$VAR` expansion mechanism
- [Validation Codes Reference](../validation/validation-codes.md) -- complete
  list of validation findings including `ENV_CONFLICT`
- [Secrets Resolution](../deploy/secrets-resolution.md) -- deploy-time strategy
  selection and `.env` file creation
- [Atomic File Uploads](../deploy/file-upload.md) -- heredoc and base64 upload
  mechanisms used by the env strategies
- [Validation Troubleshooting](../validation/troubleshooting.md) -- resolving
  `ENV_CONFLICT` and other validation errors
