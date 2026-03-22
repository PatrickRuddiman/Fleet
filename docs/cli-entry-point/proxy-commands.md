# Proxy Commands

The `fleet proxy` command group manages the Caddy reverse proxy that routes
traffic to deployed stacks. It contains two subcommands: `status` and `reload`.

## Usage

```
fleet proxy status
fleet proxy reload
```

Neither subcommand takes arguments or options.

## How subcommand groups work

The `proxy` command at `src/commands/proxy.ts:5-8` uses Commander.js's command
grouping feature. Instead of attaching an action handler directly, it creates a
parent command (`proxy`) with a description and then adds child commands
(`status` and `reload`) to it. This creates the nested command structure
`fleet proxy status` and `fleet proxy reload`.

Commander.js handles this by creating a `Command` object for `proxy` and
attaching `status` and `reload` as subcommands. If a user runs `fleet proxy`
without a subcommand, Commander.js displays help for the proxy group showing
available subcommands.

## `fleet proxy status`

Shows the current state of the Caddy reverse proxy, including live routes,
expected routes from state, and any discrepancies.

### What it does

The status command (implemented in `src/proxy-status/proxy-status.ts`, see
[Proxy Status & Reload](../proxy-status-reload/overview.md)):

1. Loads `fleet.yml` and opens an SSH connection
2. Checks if the `fleet-proxy` Caddy container is running via `docker inspect`
3. If the container is not running, prints the container status and returns
4. Queries the Caddy admin API for the current configuration and live routes
5. Reads the Fleet state file (`~/.fleet/state.json`) on the remote server
6. Reconciles live routes against expected routes, identifying:
    - **Active routes**: Present in both Caddy and state
    - **Ghost routes**: Present in Caddy but absent from state
    - **Missing routes**: Present in state but absent from Caddy

### What is a ghost route?

A ghost route is a hostname configured in the live Caddy proxy that does not
correspond to any entry in Fleet's state file. For causes, implications, and
resolution steps, see [Proxy Status](../proxy-status-reload/proxy-status.md).

### How the Caddy admin API is accessed

Fleet accesses the Caddy admin API through an SSH + `docker exec` + `curl`
chain, targeting `localhost:2019` inside the `fleet-proxy` container. Route IDs
follow the `{stackName}__{serviceName}` convention. For the full execution
sequence, API endpoint reference, and `@id` traversal details, see
[Proxy Status & Reload](../proxy-status-reload/overview.md).

### Accessing the Caddy admin API directly

For debugging, you can query Caddy directly from the remote server:

```bash
# SSH into the server, then:
docker exec fleet-proxy curl -s http://localhost:2019/config/ | jq

# List all routes:
docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq

# Check a specific route:
docker exec fleet-proxy curl -s http://localhost:2019/id/mystack__web | jq
```

## `fleet proxy reload`

Forces all routes recorded in Fleet's state to be deleted and re-created in the
Caddy proxy. This is a reconciliation mechanism that ensures Caddy's live
configuration matches Fleet's desired state.

### What it does

The reload command (implemented in `src/reload/reload.ts`, see
[Proxy Status & Reload](../proxy-status-reload/overview.md)):

1. Loads `fleet.yml` and opens an SSH connection
2. Verifies the `fleet-proxy` container is running (throws an error if not,
   suggesting `fleet deploy`)
3. Reads the Fleet state file
4. For each route in each stack:
    - **Deletes** the existing Caddy route via `DELETE /id/{caddy_id}`
    - **Re-creates** the route via `POST /config/apps/http/servers/fleet/routes`
5. Reports success/failure counts

### Fault tolerance and rollback

The reload loop is **fault-tolerant but does not roll back**:

- Each route is processed independently
- If a route deletion or creation fails, the error is collected and processing
  continues with the next route
- At the end, all failures are reported
- If any route failed, the process exits with code 1

This means a partial reload is possible -- some routes may be updated while
others remain in their previous state (or temporarily missing if deletion
succeeded but creation failed).

### When to use reload

- After manually modifying the Caddy configuration and wanting to restore Fleet's
  expected state
- When `fleet proxy status` shows ghost or missing routes
- After recovering from a state file corruption

### Route persistence in Caddy

Caddy stores its configuration **in memory** by default. The `fleet-proxy`
container runs with `caddy run --resume`, which tells Caddy to resume from its
last persisted configuration on startup. Caddy persists configuration to disk
automatically after changes made through the admin API. However, if the container
is forcefully killed before persistence completes, routes may be lost.

## TLS and ACME certificates

Fleet's Caddy proxy handles automatic HTTPS via ACME (typically Let's Encrypt).
The relevant `fleet.yml` fields per route:

- `tls` (boolean, defaults to `true`) -- whether to enable TLS for the route
- `acme_email` (string, optional) -- the email address for ACME certificate
  registration

### How Caddy obtains TLS certificates

When `tls: true` is set on a route and an `acme_email` is configured, Caddy
automatically:

1. Registers an ACME account with the email address
2. Requests a certificate from Let's Encrypt (default CA)
3. Completes the ACME challenge (typically HTTP-01 on port 80)
4. Installs the certificate and begins serving HTTPS
5. Renews the certificate automatically before expiry

### Certificate storage

TLS certificates and ACME account data are stored in the `caddy_data` Docker
volume, as declared in the proxy compose file. This volume persists across
container restarts and redeployments.

### Certificate renewal failures

If certificate renewal fails (e.g., DNS misconfiguration, Let's Encrypt rate
limits, port 80 blocked), Caddy logs the error to its container logs. Check
with:

```bash
docker logs fleet-proxy
```

Caddy will continue retrying renewal automatically. The existing certificate
remains valid until it expires (typically 90 days for Let's Encrypt).

### Admin API port exposure

The Caddy admin API listens on `localhost:2019` **inside the container only**.
It is not exposed to the host network or the internet. Access is only possible
through `docker exec` from the host, which requires SSH access to the server.

## Troubleshooting

### "Proxy status failed with an unknown error"

Check SSH connectivity and ensure the `server` section in `fleet.yml` is
correct. Verify the server is reachable.

### Container not running

If the `fleet-proxy` container is not running, `fleet proxy status` reports the
container status and returns early. `fleet proxy reload` throws an error
suggesting you run `fleet deploy` to start the proxy. The proxy is bootstrapped
during the first deployment -- see
[Server Bootstrap](../bootstrap/server-bootstrap.md).

### "Reload failed" for specific routes

Check Caddy logs (`docker logs fleet-proxy`) for details. Common causes:
- The upstream container is not connected to the `fleet-proxy` Docker network
- The route configuration has an invalid domain or port
- Caddy's admin API is temporarily unavailable

## Related documentation

- [CLI Overview](overview.md) -- command registration and entry points
- [Proxy Status & Reload](../proxy-status-reload/overview.md) -- implementation
  details
- [Route Reload](../proxy-status-reload/route-reload.md) -- delete-then-add
  reload logic and fault tolerance
- [Proxy Status](../proxy-status-reload/proxy-status.md) -- route reconciliation
  and ghost route detection
- [Proxy Troubleshooting](../proxy-status-reload/troubleshooting.md) -- common
  proxy issues and debugging
- [Server Bootstrap](../bootstrap/server-bootstrap.md) -- how the proxy is
  initially set up
- [Bootstrap Sequence](../bootstrap/bootstrap-sequence.md) -- detailed 8-step
  bootstrap flow
- [Caddy Reverse Proxy Architecture](../caddy-proxy/overview.md) -- the proxy
  system managed by these commands
- [TLS and ACME](../caddy-proxy/tls-and-acme.md) -- certificate lifecycle
- [Deploy Command](deploy-command.md) -- deployment registers routes
  automatically
- [Stack Lifecycle](../stack-lifecycle/overview.md) -- stop and teardown also
  affect routes
