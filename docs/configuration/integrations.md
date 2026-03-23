# Configuration Module Integrations

The configuration module depends on four external integrations: Zod for schema
validation, the `yaml` library for YAML parsing, Infisical for secrets
management, and the Node.js `fs` module and `process.env` for file I/O and
environment variable access. This document covers each integration's role,
operational characteristics, and answers to questions raised during codebase
exploration.

## Zod (validation library)

- **Version:** `^4.3.6` (Zod v4)
- **Source files:** `src/config/schema.ts:1`, `src/config/loader.ts:3-4`
- **Official docs:** [zod.dev](https://zod.dev)

### How Fleet uses Zod

Zod defines the entire `fleet.yml` schema as composable schema objects
(`z.object`, `z.string`, `z.number`, `z.literal`, `z.union`, `z.array`). At
runtime, `fleetConfigSchema.safeParse(parsed)` validates the parsed YAML
against the schema and produces either a typed `FleetConfig` result or a
structured error.

Fleet uses two specific Zod APIs:

1. **`safeParse()`** -- validates without throwing, returning a discriminated
   union of `{ success: true, data }` or `{ success: false, error }`.
2. **`prettifyError()`** -- Zod v4's built-in error formatter that produces
   human-readable strings with `✖` prefixes and `→ at` path indicators.

### How `prettifyError` handles union errors

When the three-way `env` union (`src/config/schema.ts:57`) fails validation,
Zod produces separate issue sets for each union branch that didn't match.
`prettifyError` renders all of these, producing output like:

```
✖ Expected array, received string
  → at env
✖ Expected object, received string
  → at env
```

This can be verbose, but it gives the user visibility into all three possible
shapes. The path information (`→ at env`) helps the user locate the problem
field. For nested union failures (e.g., invalid Infisical config within the
object branch), the path extends further:

```
✖ Required
  → at env.infisical.token
```

### Zod v4 vs v3 considerations

Fleet uses Zod v4 (`^4.3.6`). Key differences from Zod v3 that affect this
module:

- `prettifyError` is new in v4 (replaces the v3 pattern of `z.ZodError.format()`)
- The `safeParse` API is unchanged
- Schema definition syntax (`z.object`, `z.string`, etc.) is unchanged
- Error issue structure now uses `$ZodError` (but the `issues` array with
  `path` and `message` fields remains compatible)

### Performance characteristics

`safeParse` performs synchronous, in-memory validation. For Fleet
configurations (typically under 1KB of YAML producing a small JavaScript
object), validation takes microseconds. There are no performance concerns
for this use case. Zod v4 also has a smaller bundle size (~2KB gzipped core)
compared to v3, though this matters more for browser usage than CLI tools.

## yaml (YAML parser)

- **Version:** `^2.8.2`
- **Source files:** `src/config/loader.ts:2`, `src/config/loader.ts:16`
- **Official docs:** [eemeli.org/yaml](https://eemeli.org/yaml/)

### How Fleet uses the yaml library

Fleet calls `yaml.parse(content)` to convert the raw YAML string into a
JavaScript value. This is the simplest API level of the library -- Fleet does
not use the Document API or the lower-level Lexer/Parser/Composer APIs.

The `init/generator.ts` module uses the more advanced Document API to generate
YAML with comments, but that is outside the config loading path.

### YAML specification version

The `yaml@2.x` library defaults to **YAML 1.2**. This has practical
implications:

| Value | YAML 1.1 interpretation | YAML 1.2 interpretation |
|-------|------------------------|------------------------|
| `yes` / `no` | boolean `true` / `false` | string `"yes"` / `"no"` |
| `on` / `off` | boolean `true` / `false` | string `"on"` / `"off"` |
| `y` / `n` | boolean `true` / `false` | string `"y"` / `"n"` |
| `true` / `false` | boolean | boolean |
| `0o777` | octal number | octal number |
| `0x1A` | hex number | hex number |

The most common pitfall is writing `tls: yes` in `fleet.yml`. Under YAML 1.2,
this is parsed as the string `"yes"`, which fails Zod validation because `tls`
expects a boolean. Always use `true` or `false`.

### YAML features and safety

The `yaml` library supports these YAML features that could affect Fleet
configurations:

- **Anchors and aliases:** Supported. `&anchor` and `*anchor` references are
  resolved during parsing. This can be useful for reducing duplication in
  multi-route configurations but is not commonly used.
- **Merge keys (`<<`):** Not enabled by default in YAML 1.2 mode. Fleet does
  not pass `{ merge: true }` to the parser, so `<<` is treated as a literal
  key.
- **Multi-document streams:** `yaml.parse()` only parses the first document.
  A `fleet.yml` with multiple `---` separated documents will silently use only
  the first one.
- **Custom tags:** Not used by Fleet. Unknown tags produce warnings but do not
  cause errors by default.
- **Billion laughs attack:** The `yaml` library has default protection against
  exponential entity expansion via the `maxAliasCount` option (defaults to
  100), preventing denial-of-service through deeply nested aliases.

### Error handling

The `yaml` library can accept any string without throwing (per its
documentation). Parsing errors are collected internally and the library returns
as much data as it can. However, Fleet wraps the call in a try/catch
(`src/config/loader.ts:14-18`) and re-throws with a cleaner message. In
practice, severely malformed YAML (e.g., bare TAB characters used for
indentation in YAML 1.2 mode) may cause the `parse` call to throw.

## Infisical (secrets management)

- **Type:** Cloud service / secrets management platform
- **Source files:** `src/config/schema.ts:19-24`, `src/config/loader.ts:29-61`,
  `src/deploy/infisical.ts`, `src/deploy/helpers.ts:254-286`
- **Official docs:** [infisical.com/docs](https://infisical.com/docs)

### How Fleet integrates with Infisical

Fleet's Infisical integration spans two phases:

1. **Config load time** (local): `$VAR` references in the four Infisical
   fields are expanded from `process.env` on the machine running Fleet
   (see [Environment Variables](./environment-variables.md) for details on
   `$VAR` expansion).
2. **Deploy time** (remote): The Infisical CLI is bootstrapped on the remote
   server, then `infisical export` is run to fetch secrets and write them to
   the stack's `.env` file (see
   [Secrets Resolution](../deploy/secrets-resolution.md) for the full
   deploy-time flow).

### Token management

The `token` field in the Infisical config accepts either a literal service
token (e.g., `st.abc123.xyz789`) or a `$VAR` reference to an environment
variable (e.g., `$INFISICAL_TOKEN`).

**Rotating or revoking tokens:** Infisical service tokens can be managed
through the Infisical dashboard or API. To rotate a token:

1. Create a new service token in the Infisical dashboard with the same scope
2. Update the environment variable or `fleet.yml` with the new token
3. Revoke the old token in the Infisical dashboard

Token scope is determined at creation time in the Infisical dashboard -- you
choose which project, environment, and secret path the token can access.
Token TTL (time-to-live) is also configurable at creation time.

### Deployment failure behavior

If the `infisical export` command fails at deploy time
(`src/deploy/helpers.ts:273-276`), the deployment **aborts** with an error.
The `.env` file may be left in a partial state (empty or containing only the
entries from `env.entries` if both were configured). The deployment does not
roll back any previously completed steps.

### Audit and access logging

Infisical provides audit logs in its dashboard that record which service
tokens accessed which secrets and when. These logs are part of Infisical's
platform and are not controlled by Fleet. Check your Infisical dashboard
under the project's audit log section.

### Network requirements

The remote server needs outbound HTTPS access to:

- **`dl.cloudsmith.io`** -- for downloading the Infisical CLI installer
  (`src/deploy/infisical.ts:17`)
- **Infisical API endpoint** -- typically `app.infisical.com` for cloud, or
  your self-hosted instance URL

If the remote server is behind a firewall, ensure these endpoints are
allowlisted. There is no retry logic or fallback installation method for the
CLI installer -- if `dl.cloudsmith.io` is unreachable, the deployment fails.

### CLI version pinning

The Infisical CLI installation command (`apt-get install -y infisical`) does
not pin a specific version (`src/deploy/infisical.ts:17`). This means the
latest version is installed, and subsequent deployments may silently upgrade
the CLI. For production environments, consider pinning the version:
`apt-get install -y infisical=X.Y.Z`. However, this would require a code
change to Fleet.

## Node.js `fs` module

- **Source files:** `src/config/loader.ts:1`, `src/config/loader.ts:9`

### File read behavior

Fleet reads the configuration file synchronously with `readFileSync`
(`src/config/loader.ts:9`). The file must be readable by the process user.

### File permissions

Since `fleet.yml` may contain literal Infisical tokens or other sensitive
values (in the array env mode), consider restricting its file permissions:

```bash
chmod 600 fleet.yml
```

This is not enforced by Fleet, but is a security best practice. The `$VAR`
expansion feature exists specifically to avoid putting secrets directly in
`fleet.yml`.

## Node.js `process.env`

- **Source files:** `src/config/loader.ts:40`

### Environment variable resolution

The `$VAR` expansion mechanism uses `process.env[varName]` for lookups
(`src/config/loader.ts:40`). In CI/CD environments, variables should be
injected through the pipeline's native secret management:

| CI/CD Platform | How to inject |
|---------------|---------------|
| GitHub Actions | `env:` block in workflow YAML, populated from `${{ secrets.NAME }}` |
| GitLab CI | CI/CD Variables in project settings |
| Jenkins | Credentials plugin, injected as environment variables |
| CircleCI | Environment Variables in project settings |
| Shell | `export INFISICAL_TOKEN=xxx` before running `fleet deploy` |

### Security of error messages

When a referenced environment variable is not set, the error message includes
the variable **name** but never its **value** (`src/config/loader.ts:42-44`):

```
Environment variable "INFISICAL_TOKEN" referenced by
env.infisical.token in fleet.yml is not set
```

This prevents accidental secret leakage in CI logs. Resolved values are never
logged by the configuration module. However, downstream modules (deployment
pipeline, Infisical export) may include sensitive values in remote shell
commands -- the Infisical token is passed via environment variable in the
remote shell (`INFISICAL_TOKEN={token} infisical export ...`), which avoids
exposure in `ps aux` output but is visible in the shell's environment space.

## Related documentation

- [Configuration Overview](./overview.md) -- module architecture and data flow
- [Loading and Validation](./loading-and-validation.md) -- the full loading
  pipeline including error handling
- [Environment Variables](./environment-variables.md) -- the three env modes
  and `$VAR` expansion
- [Schema Reference](./schema-reference.md) -- field-by-field specification
- [Env Configuration Shapes](../env-secrets/env-configuration-shapes.md) --
  the three `env` field shapes and their deploy-time behavior
- [Infisical Integration](../env-secrets/infisical-integration.md) -- deep dive
  on Infisical CLI bootstrap and remote secret fetching
- [Secrets Resolution](../deploy/secrets-resolution.md) -- how secrets are
  resolved during deployment
- [Security Model](../env-secrets/security-model.md) -- security properties
  of the env/secrets system including transport and file permissions
- [Validation Troubleshooting](../validation/troubleshooting.md) -- common
  validation failures including Zod schema errors
- [Deploy Integrations](../deploy/integrations.md) -- how Infisical and other
  external systems are used during deployment
