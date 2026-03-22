# Utility Functions

The init subsystem includes two utility functions in
[`src/init/utils.ts`](../../../src/init/utils.ts) that handle stack name
derivation and compose file detection. This page covers `slugify()` in detail.
For compose file detection, see
[Compose File Detection](compose-file-detection.md).

## slugify()

Converts a raw directory name into a valid Fleet stack name.

### Algorithm

The function applies four transformations in sequence:

1.  **Lowercase** -- Converts the entire input to lowercase via
    `String.prototype.toLowerCase()`

2.  **Replace invalid characters** -- Replaces any sequence of characters outside
    the set `[a-z0-9-]` with a single hyphen. The regex `/[^a-z0-9-]+/g` matches
    one or more consecutive invalid characters and collapses them.

3.  **Strip leading hyphens** -- Removes any hyphens at the start of the string
    via `/^-+/`.

4.  **Strip trailing hyphens** -- Removes any hyphens at the end of the string
    via `/-+$/`.

5.  **Validate** -- The result is tested against `STACK_NAME_REGEX`
    (`/^[a-z\d][a-z\d-]*$/` from `src/config/schema.ts:46`). If the result is
    empty or fails the regex, `null` is returned.

### Return Value

- **`string`** -- A valid stack name if the transformation succeeded.
- **`null`** -- If the input could not be converted to a valid name. This triggers
  the interactive prompt fallback in the CLI command.

### Examples

| Input | Output | Reason |
|-------|--------|--------|
| `MyProject` | `myproject` | Lowercased, all valid chars |
| `my_cool_project` | `my-cool-project` | Underscores replaced with hyphen |
| `---test---` | `test` | Leading/trailing hyphens stripped |
| `My App v2.0` | `my-app-v2-0` | Spaces and dots collapsed to hyphens |
| `@#$%` | `null` | All characters invalid, result is empty |
| (empty string) | `null` | Empty after processing |

### STACK_NAME_REGEX

The regex `STACK_NAME_REGEX` is defined at `src/config/schema.ts:46` and enforces:

- Must start with a lowercase letter or digit (`[a-z\d]`)
- Followed by zero or more lowercase letters, digits, or hyphens (`[a-z\d-]*`)
- No uppercase, underscores, dots, or other special characters
- Cannot start with a hyphen (the leading character class excludes `-`)
- Can end with a hyphen (the trailing class includes `-`), though `slugify()`
  strips trailing hyphens before validation

This regex is used in two places:
1.  `slugify()` for validating the derived name
2.  `stackSchema` in the Zod schema for validating `stack.name` during config
    loading

### Why slugify Can Return Null

The function returns `null` rather than throwing an error because a failed
derivation is not an error condition -- it simply means the directory name is
unsuitable and the user should provide a name manually. The calling code in
`src/commands/init.ts:71-73` handles this by falling through to the interactive
prompt.

## Interactive Stack Name Prompt

When `slugify()` returns `null`, the CLI command activates an interactive prompt
using Node.js `readline.createInterface()`. The prompt:

1.  Displays: `Enter a valid stack name (lowercase alphanumeric and hyphens):`
2.  Validates the input against `STACK_NAME_REGEX`
3.  If invalid, prints an error message showing the regex and re-prompts
4.  Loops until a valid name is entered
5.  Returns the trimmed, validated string

The prompt reads from `process.stdin` and writes to `process.stdout`. It is
implemented as a recursive `ask()` function wrapped in a Promise, allowing the
async command handler to `await` the result.

### Non-Interactive Environments

The prompt uses Node.js `readline` directly with no TTY detection. In a
non-interactive environment (piped stdin, CI pipeline), the prompt will:

- Read from stdin until EOF
- If no valid input arrives, the process hangs waiting for input
- There is no timeout mechanism

For CI/CD usage, ensure the directory name can be slugified successfully, or
provide a pre-configured `fleet.yml` rather than running `fleet init`.

## Related Documentation

- [Project Initialization Overview](overview.md) -- how utilities fit into the
  init workflow
- [Compose File Detection](compose-file-detection.md) -- the other utility
  function in this module
- [YAML Generation Internals](fleet-yml-generation.md) -- how the stack name
  feeds into YAML output
- [Project Init Integrations](integrations.md) -- external dependencies used
  by the init subsystem
- [Schema Reference](../configuration/schema-reference.md) -- `STACK_NAME_REGEX`
  definition and `stack.name` validation
- [CLI Init Command Reference](../cli-entry-point/init-command.md) -- command-level
  behavior including the prompt
- [Fleet Configuration Checks](../validation/fleet-checks.md) -- how
  `STACK_NAME_REGEX` is used in validation
- [Validation Codes](../validation/validation-codes.md) -- `INVALID_STACK_NAME`
  error code details
