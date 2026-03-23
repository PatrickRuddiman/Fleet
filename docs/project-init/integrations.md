# Integrations Reference

The project initialization subsystem depends on several external libraries and
services. This page documents each integration, including what it provides, how
Fleet uses it, and operational considerations.

## Commander.js

**What**: Node.js command-line framework for parsing arguments and registering
subcommands.

**How Fleet uses it**: The `register()` function in
[`src/commands/init.ts`](../../../src/commands/init.ts) receives a `Command`
instance from Commander and registers the `init` subcommand with:

- `.command("init")` -- defines the subcommand name
- `.description(...)` -- sets help text
- `.option("--force", ...)` -- defines the `--force` flag
- `.action(async (opts) => { ... })` -- attaches the async handler

**Operational notes**:

- Commander handles `--help` output automatically for the `init` subcommand
- The `opts` object is typed as `{ force?: boolean }` and is populated by
  Commander's option parser
- The `init` command does not define positional arguments
- Error handling (exit codes) is managed manually within the action handler,
  not through Commander's error mechanisms

**Official documentation**: [Commander.js on npm](https://www.npmjs.com/package/commander)

## yaml (npm package)

**What**: YAML 1.2 parser and serializer for JavaScript with full AST support,
including comments.

**How Fleet uses it**: The `generateFleetYml()` function in
[`src/init/generator.ts`](../../../src/init/generator.ts) uses the Document API
to build YAML with programmatic comments:

- `new yaml.Document()` -- creates a YAML document instance
- `doc.createNode(obj)` -- converts a JavaScript object to a YAML AST
- Node traversal via `.get(key, true)` and `.items` on `YAMLMap`/`YAMLSeq`
- Comment injection via `.comment` (inline) and `.commentBefore` (above) properties
- `doc.toString()` -- serializes the annotated AST to a YAML string

The compose parser in [`src/compose/parser.ts`](../../../src/compose/parser.ts)
also uses `yaml.parse()` for simple deserialization of compose files. See
[Compose Parser Internals](../compose/parser.md) for details on port
normalization and YAML 1.2 implications.

**Operational notes**:

- Fleet uses `yaml` v2.x which defaults to YAML 1.2 core schema
- The `toString()` method uses 2-space indentation, 80-character line width,
  and block style by default
- YAML 1.2 differs from YAML 1.1 in boolean handling: `yes`, `no`, `on`, `off`
  are **not** treated as booleans in 1.2. This means compose file values like
  `restart: no` are parsed as the string `"no"`, not as `false`
- Comments survive the full round-trip through the Document API but are lost
  when using `yaml.parse()` + `yaml.stringify()` (plain mode)

**Official documentation**: [yaml on npm](https://www.npmjs.com/package/yaml)

## Node.js fs Module

**What**: Built-in Node.js file system module for synchronous and asynchronous
file operations.

**How Fleet uses it**:

| Function | Usage | Location |
|----------|-------|----------|
| `fs.existsSync()` | Check if compose file exists on disk | `src/init/utils.ts:36` |
| `fs.existsSync()` | Check if `fleet.yml` already exists | `src/commands/init.ts:43` |
| `fs.writeFileSync()` | Write generated `fleet.yml` to disk | `src/commands/init.ts:84` |
| `fs.readFileSync()` | Read compose file content (in parser) | `src/compose/parser.ts:115` |

**Operational notes**:

- All file operations in the init subsystem are **synchronous**. This is
  acceptable for a CLI tool where blocking I/O during initialization is expected.
- File paths are constructed using `path.join(cwd, filename)` to ensure
  cross-platform compatibility.
- The compose file is read as `"utf-8"` explicitly. No BOM handling is performed.
- `writeFileSync` overwrites the target file atomically (from the OS perspective)
  without creating a temporary file first.

## Node.js readline Module

**What**: Built-in Node.js module for reading line-oriented input from a readable
stream, typically stdin.

**How Fleet uses it**: The `promptStackName()` function in
[`src/commands/init.ts:10-31`](../../../src/commands/init.ts) creates a readline
interface to prompt the user for a stack name when `slugify()` fails:

- `readline.createInterface({ input: process.stdin, output: process.stdout })`
- `rl.question(prompt, callback)` to display the prompt and read input
- Recursive `ask()` function for re-prompting on invalid input
- `rl.close()` to clean up after a valid name is received

**Operational notes**:

- The readline interface is created fresh each time `promptStackName()` is called
  and closed after receiving valid input
- There is no timeout -- the prompt waits indefinitely for input
- No TTY detection is performed. In non-interactive environments, the process
  will hang waiting for stdin input
- The prompt does not support default values or tab completion
- Input is trimmed (`answer.trim()`) before validation

## Docker Compose

**What**: Container orchestration tool that defines multi-container applications
in YAML.

**How Fleet uses it**: Fleet reads Docker Compose files to auto-generate
[route configurations](../configuration/schema-reference.md#routes). The
interaction is read-only -- Fleet never invokes the `docker compose` CLI during
init.

- `detectComposeFile()` checks for `compose.yml` and `compose.yaml` on disk
- `loadComposeFile()` parses the compose file's YAML and extracts service
  definitions
- Port mappings from compose services are normalized and used to populate
  routes in the generated `fleet.yml`

**Operational notes**:

- Fleet supports compose files that follow the
  [Compose Specification](https://docs.docker.com/reference/compose-file/).
  It reads the `services` top-level key and each service's `ports`, `image`,
  `build`, and other standard fields.
- Fleet does **not** validate the compose file against the full Compose
  Specification schema. It extracts only the fields it needs.
- Named volumes, networks, and other top-level compose keys are ignored during
  init.
- The compose file is parsed as generic YAML, not through Docker's own parser.
  This means Docker-specific features like variable interpolation (`${VAR}`)
  are **not** expanded during init.
- Port formats supported: short-form strings (`"8080:3000"`,
  `"3000"`, `"127.0.0.1:8080:3000/tcp"`), plain numbers (`3000`), and
  long-form objects (`{ target: 3000, published: 8080 }`).

## ACME / Let's Encrypt

**What**: Automatic Certificate Management Environment (ACME) protocol for
automated TLS certificate issuance, used by Certificate Authorities like
Let's Encrypt and ZeroSSL.

**How Fleet uses it**: The generated `fleet.yml` includes `acme_email` fields on
each route with a placeholder value (`you@example.com`). This email is used
downstream by Fleet's Caddy proxy integration to register ACME accounts and
obtain TLS certificates automatically.

**Operational notes**:

- The `acme_email` field is validated as a valid email address by the Zod schema
  (`z.string().email()`) when the config is loaded, but during init it is written
  as a placeholder that will fail validation until replaced.
- Caddy (Fleet's reverse proxy) uses Let's Encrypt as the primary CA and ZeroSSL
  as a fallback. It automatically handles:
    - Account registration with the ACME provider
    - Domain validation via HTTP-01 or TLS-ALPN-01 challenges
    - Certificate renewal approximately 30 days before expiration
    - Certificate storage in the `caddy_data` Docker volume
- The `tls` field defaults to `true` in the schema, meaning ACME is active by
  default for all routes unless explicitly disabled.
- For the ACME HTTP-01 challenge to succeed, the domain must resolve to the
  server's public IP and port 80 must be accessible.
- Rate limits apply: Let's Encrypt allows 50 certificates per registered domain
  per week, and 5 duplicate certificates per week. See the
  [Let's Encrypt rate limits documentation](https://letsencrypt.org/docs/rate-limits/)
  for current values.
- For staging/development, Let's Encrypt provides a staging environment with
  relaxed rate limits. Caddy can be configured to use the staging CA, though
  Fleet does not expose this as a first-class configuration option.

For more details on Fleet's Caddy integration, see the
[Caddy proxy documentation](../caddy-proxy/).

## Related documentation

- [Project Initialization Overview](overview.md) -- how these integrations fit
  into the init workflow
- [YAML Generation Internals](fleet-yml-generation.md) -- yaml library usage
  in detail
- [Compose File Detection](compose-file-detection.md) -- Docker Compose
  integration details
- [Utility Functions](utility-functions.md) -- readline prompt details
- [Schema Reference](../configuration/schema-reference.md) -- Zod validation
  and ACME email requirements
- [Compose Parser Internals](../compose/parser.md) -- port normalization and
  YAML 1.2 parsing details
- [Caddy Proxy Overview](../caddy-proxy/overview.md) -- how generated routes
  integrate with Caddy
- [TLS and ACME](../caddy-proxy/tls-and-acme.md) -- ACME certificate lifecycle
  and Let's Encrypt integration
- [CLI Init Command](../cli-entry-point/init-command.md) -- the CLI entry
  point that invokes the init subsystem
- [Validation Overview](../validation/overview.md) -- how generated fleet.yml
  files are validated
- [Validation Troubleshooting](../validation/troubleshooting.md) -- common
  validation failures when editing generated fleet.yml files
- [Environment Variables](../configuration/environment-variables.md) -- how to
  configure env modes after init
