# Atomic File Uploads

## What This Covers

Fleet uploads files to the remote server over SSH using two methods, both
employing the atomic `.tmp` + `mv` pattern. This page explains how each method
works, when each is used, and their failure modes.

## Why Atomic Writes Matter

Uploading a file directly to its target path risks leaving a partially written
file if the SSH connection drops or the command fails. The atomic pattern writes
to a temporary file first, then uses `mv` to rename it to the final path. On
Linux filesystems, `mv` within the same filesystem is atomic -- the file either
appears at the new path completely or not at all.

## Two Upload Methods

### Heredoc Upload (`uploadFile`)

**Source**: `src/deploy/helpers.ts:140-162`

Uses a shell heredoc with a delimiter (`FLEET_EOF`) to stream content directly
into a file:

```bash
mkdir -p {dir} && cat << 'FLEET_EOF' > {path}.tmp
{content}
FLEET_EOF
&& mv {path}.tmp {path}
```

The single-quoted delimiter (`'FLEET_EOF'`) disables shell variable expansion
within the heredoc, preventing `$` characters in the content from being
interpreted as variable references.

**Used for**: Compose files, `fleet.yml`, inline key-value `.env` files --
content where shell metacharacters are unlikely or benign.

### Base64 Upload (`uploadFileBase64`)

**Source**: `src/deploy/helpers.ts:169-192`

Encodes the content as base64 locally, transmits the encoded string, and decodes
it on the remote server:

```bash
mkdir -p {dir} && echo '{base64}' | base64 -d > {path}.tmp && mv {path}.tmp {path}
```

**Used for**: Local `.env` file uploads (Strategy 1 in
[Secrets Resolution](secrets-resolution.md)) -- content that may contain
arbitrary characters including heredoc delimiters, shell metacharacters, or
binary data.

### Permissions

Both methods support an optional `permissions` parameter. When provided, a
`chmod {permissions} {path}` command is appended. See
[Secrets Resolution](secrets-resolution.md) for how these upload methods are
used for `.env` files:

```bash
... && mv {path}.tmp {path} && chmod 0600 {path}
```

The `.env` file is always uploaded with `0600` permissions (owner read/write
only).

## Failure Modes

### SSH Connection Drop

If the connection drops during the heredoc or base64 write, the `.tmp` file may
exist as a partial write. The final `mv` never executes, so the target file is
not corrupted. Leftover `.tmp` files are overwritten on the next deploy.

### Disk Full

If the remote filesystem is full, the write to `.tmp` fails and the command
returns a non-zero exit code. The `uploadFile` and `uploadFileBase64` functions
check the exit code and throw an error with the stderr detail.

### Permission Denied

If the SSH user lacks write permission to the target directory, `mkdir -p` fails.
The error message includes the stderr from the remote command.

### Content With Heredoc Delimiter

If the file content happens to contain the exact string `FLEET_EOF` on a line by
itself, the heredoc upload method would terminate prematurely. This is why the
base64 method exists -- it avoids this class of issue entirely. Fleet uses the
base64 method for user-provided `.env` files where content is unpredictable.

## The Upload Options Interface

Defined at `src/deploy/types.ts:28-32`:

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The file content to write |
| `remotePath` | `string` | Absolute path on the remote server |
| `permissions` | `string?` | Optional chmod value (e.g., `"0600"`) |

## Related Pages

- [Secrets Resolution](secrets-resolution.md) -- how file uploads are used for
  `.env` files across the three env strategies
- [17-Step Deploy Sequence](deploy-sequence.md)
- [Deployment Pipeline Overview](../deployment-pipeline.md)
- [Env Configuration Shapes](../env-secrets/env-configuration-shapes.md) --
  the three env shapes that trigger different upload methods
- [SSH Connection API](../ssh-connection/connection-api.md) -- the `ExecFn`
  interface used to execute remote upload commands
