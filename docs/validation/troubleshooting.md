# Validation Troubleshooting

This page covers common validation failures, their root causes, and step-by-step
resolutions. For a complete reference of all validation codes, see the
[Validation Codes Reference](./validation-codes.md).

## Pre-validation failures

These errors occur before the validation checks run, during file loading.

### "fleet.yml" not found

**Symptom**: `fleet validate` exits with an error about reading the file.

**Cause**: The file does not exist at the expected path.

**Resolution**:
1. Verify you are in the correct directory: `fleet validate` looks for
   `./fleet.yml` relative to the current working directory.
2. If the file is elsewhere, specify the path: `fleet validate path/to/fleet.yml`.
3. If no `fleet.yml` exists yet, run `fleet init` to generate one.

### Zod schema validation error

**Symptom**: A detailed error listing field-level validation failures (e.g.,
"Expected string, received number" or "Required").

**Cause**: The `fleet.yml` file has valid YAML syntax but its structure does not
match the Fleet configuration schema.

**Resolution**: Compare your `fleet.yml` against the schema. Required fields:
- `version: "1"` (must be the string `"1"`, not the number `1`)
- `server.host` (string)
- `stack.name` (string matching `/^[a-z\d][a-z\d-]*$/`)
- `routes` (array with at least one entry, each having `domain` and `port`)

The schema is defined in `src/config/schema.ts:53-59`. See the
[Configuration Schema Reference](../configuration/schema-reference.md) for the
full field-by-field specification. Zod errors are formatted
with `prettifyError` from Zod v4 (`src/config/loader.ts:22-24`), which provides
field paths and expected types. See
[Configuration Integrations](../configuration/integrations.md#zod-validation-library)
for details on Zod v4 error formatting.

### Compose file not found

**Symptom**: Error about failing to load the compose file.

**Cause**: The compose file path (from `stack.compose_file` in `fleet.yml`)
does not resolve to an existing file.

**Resolution**:
1. Check `stack.compose_file` in your `fleet.yml`. The default is
   `docker-compose.yml`.
2. The path resolves relative to the **directory** of `fleet.yml`, not `cwd`.
3. Ensure the compose file exists at the resolved path.

**Note on detection mismatch**: `fleet init` detects `compose.yml` and
`compose.yaml` (in that order), but the schema default for `compose_file` is
`docker-compose.yml`. If you used `fleet init` with a `compose.yml` file, the
generated `fleet.yml` should already reference the correct filename. If you
created `fleet.yml` manually, ensure the `compose_file` field matches your
actual filename.

### Invalid YAML in compose file

**Symptom**: Error about failing to parse the compose file.

**Cause**: The compose file contains YAML syntax errors.

**Resolution**: Use a YAML linter to check the file. Common issues:
- Incorrect indentation (YAML is indentation-sensitive).
- Tabs instead of spaces.
- Unquoted special characters.

The YAML parser (`yaml@^2.8.2`) provides error details including line and column
numbers, but the compose loader wraps these in a generic error message
(`src/compose/parser.ts:121-125`), discarding positional information. See
[Compose Parser Internals](../compose/parser.md) for details on YAML parsing
behavior.

### Compose file has no `services` key

**Symptom**: Error during compose file loading.

**Cause**: The compose file is valid YAML but has no top-level `services` map.

**Resolution**: Ensure your compose file follows the Docker Compose
specification with a `services` section:

```yaml
services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
```

## Common validation errors

### INVALID_STACK_NAME

**Example output**:
```
✗ [INVALID_STACK_NAME] Stack name "My-App" is invalid.
  Resolution: Use a name matching /^[a-z\d][a-z\d-]*$/ ...
```

**Common causes**:
- Uppercase letters (`My-App` should be `my-app`)
- Leading hyphen (`-myapp` should be `myapp`)
- Underscores (`my_app` should be `my-app`)
- Spaces or special characters

### ENV_CONFLICT

**Example output**:
```
✗ [ENV_CONFLICT] "env.entries" and "env.infisical" are both configured ...
```

**Resolution options** (see
[Env Configuration Shapes](../env-secrets/env-configuration-shapes.md) for
detailed examples of each shape):
1. **Use only inline entries**:
    ```yaml
    env:
      entries:
        - key: DATABASE_URL
          value: postgres://...
    ```
2. **Use only Infisical**:
    ```yaml
    env:
      infisical:
        token: $INFISICAL_TOKEN
        project_id: proj_abc123
        environment: production
        path: /
    ```
3. **Use a local env file** (avoids the conflict entirely):
    ```yaml
    env:
      file: .env.production
    ```

### PORT_80_CONFLICT / PORT_443_CONFLICT

**Example output**:
```
✗ [PORT_80_CONFLICT] Service "nginx" binds host port 80 which is reserved for the reverse proxy
```

**Fix**: Remove the host port mapping from your compose file. Instead of:
```yaml
services:
  nginx:
    image: nginx
    ports:
      - "80:80"     # Remove this
```

Use a Fleet route to proxy traffic:
```yaml
# fleet.yml
routes:
  - domain: myapp.example.com
    service: nginx
    port: 80        # This is the container-internal port
```

The Caddy reverse proxy handles the host-level port 80/443 binding. See
[Caddy Route Management](../deploy/caddy-route-management.md) for how routes
are registered during deployment.

### SERVICE_NOT_FOUND

**Example output**:
```
✗ [SERVICE_NOT_FOUND] Route "api.example.com" references service "backend" which does not exist in compose.yml
```

**Diagnosis**: Check the `service` field in your Fleet route against the
`services` keys in your compose file. Common issues:
- Typo in the service name.
- The service was renamed in the compose file but not in `fleet.yml`.
- The service is defined in a different compose file (Fleet only reads the
  single file specified by `compose_file`).

## Common validation warnings

### PORT_EXPOSED

**When to act**: If the exposed port is not intentionally needed for direct
external access, remove the host port binding and route traffic through Caddy.

**When to ignore**: Database ports (e.g., 5432 for PostgreSQL), message queues,
or other services that require direct TCP access.

### NO_IMAGE_OR_BUILD

**When to act**: Every service should have either `image:` (to pull from a
registry) or `build:` (to build from a Dockerfile).

**When to ignore**: If the service is provided by a Docker Compose override
file or an external tool that injects the image reference.

### ONE_SHOT_NO_MAX_ATTEMPTS

**Fix**: Add a `deploy.restart_policy.max_attempts` to the service:

```yaml
services:
  migration:
    image: myapp/migrate
    restart: "on-failure"
    deploy:
      restart_policy:
        condition: on-failure
        max_attempts: 3
        window: 120s
```

## Validation passes but deployment fails

If `fleet validate` produces no errors but `fleet deploy` still fails, the
issue is likely:

1. **Network or SSH connectivity** --- Validation runs locally and does not
   test the SSH connection.
2. **Docker daemon issues on the server** --- Validation does not check the
   remote Docker installation.
3. **Cross-stack host collisions** --- Validation only checks within the
   current `fleet.yml`. The deployment pipeline checks for domain conflicts
   across all deployed stacks using the server state file.
4. **Image pull failures** --- Validation does not verify that images are
   accessible from the remote server.
5. **Infisical token issues** --- Environment variable expansion (`$VAR`
   references in Infisical config) happens at config load time, but the
   actual Infisical secret fetch happens during deployment on the remote
   server.

## Adding custom validation checks

The validation system does not support plugins or custom check registries.
To add a new check:

1. Add a new code to the `Codes` object in `src/validation/types.ts`.
2. Write a check function in `src/validation/fleet-checks.ts` (for config
   checks) or `src/validation/compose-checks.ts` (for compose checks).
3. Add the function call to `runAllChecks()` in `src/validation/index.ts`.
4. Export the function from `src/validation/index.ts`.

All check functions follow the same signature: accept `FleetConfig` and/or
`ParsedComposeFile`, return `Finding[]`.

## Related pages

- [Validation Overview](./overview.md)
- [Validation Codes Reference](./validation-codes.md)
- [Fleet Configuration Checks](./fleet-checks.md)
- [Compose Configuration Checks](./compose-checks.md)
- [Validate Command](./validate-command.md)
- [Fleet Configuration Schema](../configuration/schema-reference.md)
- [Configuration Integrations](../configuration/integrations.md) -- Zod, YAML
  parser, and Infisical integration details
- [Compose Parser Internals](../compose/parser.md) -- YAML parsing behavior and
  port normalization
- [Env Configuration Shapes](../env-secrets/env-configuration-shapes.md) --
  the three `env` field shapes and `ENV_CONFLICT` resolution
- [Deploy Caddy Route Management](../deploy/caddy-route-management.md) -- how
  port conflicts relate to Caddy proxy routing
- [Project Initialization Overview](../project-init/overview.md) -- how
  `fleet init` generates an initial fleet.yml
