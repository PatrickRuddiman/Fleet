# Troubleshooting the Caddy Reverse Proxy

This page provides debugging commands, common failure scenarios, and recovery
procedures for Fleet's Caddy proxy subsystem.

## Quick Diagnostic Commands

All commands assume SSH access to the host running Fleet.

### Check Container Status

```bash
docker inspect --format '{{.State.Status}}' fleet-proxy
```

Expected output: `running`. If the container is not running:

```bash
# View container logs
docker logs fleet-proxy --tail 50

# Restart the container
docker compose -f /path/to/fleet-root/proxy/compose.yml up -d
```

### Query the Admin API

```bash
# Health check -- returns the full config JSON
docker exec fleet-proxy curl -s -f http://localhost:2019/config/

# List all routes
docker exec fleet-proxy curl -s -f http://localhost:2019/config/apps/http/servers/fleet/routes | jq .

# Get a specific route by ID (format: stackname__domain-slug)
docker exec fleet-proxy curl -s -f http://localhost:2019/id/mystack__app-example-com | jq .
```

### Check TLS Certificates

```bash
# List certificate directories
docker exec fleet-proxy ls -la /data/caddy/certificates/

# Check a specific certificate
docker exec fleet-proxy ls -la /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/app.example.com/

# View certificate details
docker exec fleet-proxy cat /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/app.example.com/app.example.com.crt | openssl x509 -noout -dates -subject
```

### Check Network Connectivity

```bash
# Verify fleet-proxy network exists
docker network inspect fleet-proxy

# List containers on the network
docker network inspect fleet-proxy --format '{{range .Containers}}{{.Name}} {{end}}'

# Test upstream connectivity from inside Caddy
docker exec fleet-proxy curl -s http://mystack-web-1:3000/
```

## Common Failure Scenarios

### 1. Admin API Not Responding

**Symptoms:** `fleet deploy` or `fleet proxy reload` fails with
"Failed to bootstrap Caddy" or connection refused errors. See also
[Deploy Troubleshooting](../deploy/troubleshooting.md) for deploy-specific
error diagnosis.

**Cause:** Caddy container is not running or has not finished starting.

**Diagnosis:**

```bash
docker ps -a --filter name=fleet-proxy
docker logs fleet-proxy --tail 20
```

**Resolution:**

```bash
# If container is stopped or exited
docker compose -f $(cat /opt/fleet/state.json | jq -r '.fleet_root')/proxy/compose.yml up -d

# Wait for API to be ready (Fleet's bootstrap uses 10 retries x 3s)
for i in $(seq 1 10); do
    docker exec fleet-proxy curl -s -f http://localhost:2019/config/ && break
    sleep 3
done
```

### 2. Route Registration Fails

**Symptoms:** `fleet deploy` fails with "Failed to register route for
example.com".

**Possible causes:**

- **Invalid JSON** -- Unlikely with Fleet's command builders, but can occur
  with special characters in hostnames or service names.
- **Caddy internal error** -- Check Caddy logs for details.
- **Container not running** -- The `curl -f` inside `docker exec` will fail.

**Diagnosis:**

```bash
# Check Caddy logs for the error
docker logs fleet-proxy --tail 20

# Manually test the route registration
docker exec -i fleet-proxy sh -c 'curl -v -X POST \
  -H "Content-Type: application/json" \
  -d @- http://localhost:2019/config/apps/http/servers/fleet/routes' << 'EOF'
{
  "@id": "test__route",
  "match": [{"host": ["test.example.com"]}],
  "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "localhost:8080"}]}]
}
EOF
```

### 3. Ghost Routes (Route in Caddy but Not in State)

**Symptoms:** [`fleet proxy status`](../proxy-status-reload/proxy-status.md)
shows "Ghost routes" warnings.

**Cause:** A route was added to Caddy but the corresponding state update
failed, or `state.json` was manually edited.

**Resolution:**

```bash
# Remove the ghost route by its Caddy ID (format: stackname__domain-slug)
docker exec fleet-proxy curl -s -f -X DELETE http://localhost:2019/id/myapp__old-example-com

# Or reload all routes from state
fleet proxy reload
```

### 4. Missing Routes (Route in State but Not in Caddy)

**Symptoms:** [`fleet proxy status`](../proxy-status-reload/proxy-status.md)
shows "Missing routes" warnings. Traffic to
the affected domain returns 502 or connection refused.

**Cause:** Caddy was restarted without the `--resume` flag, the config volume
was lost, or a `POST /load` reload failed partway through.

**Resolution:**

```bash
# Reload all routes from state.json
fleet proxy reload
```

This rebuilds all routes from `state.json`, fetches the current Caddy config,
merges the routes in, and posts the full configuration atomically via
`POST /load`. See [Route Reload](../proxy-status-reload/route-reload.md) for
the full reload mechanism.

### 5. TLS Certificate Not Provisioning

**Symptoms:** Browser shows certificate warnings. `curl -v` shows a
self-signed or missing certificate.

**Prerequisite checks:**

```bash
# Verify DNS resolution
dig +short app.example.com

# Verify port 80 is reachable from the internet (run from an external host)
curl -v http://app.example.com/.well-known/acme-challenge/test

# Check Caddy logs for ACME errors
docker logs fleet-proxy 2>&1 | grep -i "acme\|tls\|certificate"
```

**Common causes:**

| Cause | Fix |
|---|---|
| DNS not pointing to server | Update DNS A/AAAA record |
| Port 80 blocked by firewall | Open inbound TCP/80 in firewall/security group |
| Rate limit exhausted | Wait for rate limit window to reset (1 week for most limits) |
| `caddy_data` volume lost | Caddy will re-issue automatically once prerequisites are met |

### 6. Container Cannot Connect to Upstream

**Symptoms:** Caddy returns 502 Bad Gateway for a deployed service.

**Diagnosis:**

```bash
# Check if the application container is running
docker ps --filter name=mystack-web-1

# Check if it's on the fleet-proxy network
docker inspect mystack-web-1 --format '{{range $net, $config := .NetworkSettings.Networks}}{{$net}} {{end}}'

# Test connectivity from Caddy
docker exec fleet-proxy curl -s -o /dev/null -w '%{http_code}' http://mystack-web-1:3000/
```

**Resolution:**

```bash
# Reattach to fleet-proxy network
docker network connect fleet-proxy mystack-web-1

# Or redeploy the stack (handles network attachment automatically)
fleet deploy
```

### 7. Bootstrap Idempotency Issue

**Symptoms:** `fleet deploy` runs bootstrap even though the proxy is already
running and configured.

**Cause:** `state.json` has `caddy_bootstrapped: false` despite a working
proxy.

**Impact:** `POST /load` replaces the entire Caddy config with an empty routes
array, wiping all existing routes.

**Prevention:** Fleet checks `caddy_bootstrapped` in
[state](../state-management/overview.md) before running
bootstrap. If state is corrupted, fix it before deploying:

```bash
# On the remote server, verify proxy is running
docker exec fleet-proxy curl -s http://localhost:2019/config/apps/http/servers/fleet/routes | jq length

# If routes exist, the proxy is bootstrapped -- fix state
# (Use fleet proxy reload after fixing state to reconcile)
```

## Recovery Procedures

### Full Proxy Reset

If the proxy is in an unrecoverable state, perform a full reset:

```bash
# 1. Stop and remove the proxy container
docker compose -f /path/to/proxy/compose.yml down

# 2. Remove volumes (WARNING: loses certificates and config)
docker volume rm caddy_data caddy_config

# 3. Redeploy -- this triggers fresh bootstrap
fleet deploy
```

After the deploy, all routes are re-registered from `fleet.yml` config. New
TLS certificates are provisioned automatically. See the
[Fleet Root Directory Layout](../fleet-root/directory-layout.md) for where
proxy files are stored on the server.

### Config Volume Loss Recovery

If only `caddy_config` is lost (autosaved config) but `caddy_data` (certs)
survives:

```bash
# Restart Caddy (--resume will find no saved config, starts empty)
docker compose -f /path/to/proxy/compose.yml restart

# Reload all routes from state.json
fleet proxy reload
```

Certificates are preserved, so HTTPS will work immediately after route
re-registration.

### Data Volume Loss Recovery

If `caddy_data` is lost (certificates and private keys):

1. Caddy automatically re-issues certificates for all configured hostnames.
2. Be aware of [Let's Encrypt rate limits](./tls-and-acme.md#lets-encrypt-rate-limits)
   -- 50 certificates per registered domain per week.
3. During re-issuance, traffic is served but browsers may show warnings until
   new certificates are obtained.

No Fleet action is required -- Caddy handles re-issuance autonomously.

## Log Analysis

```bash
# Full Caddy logs
docker logs fleet-proxy

# Follow logs in real time
docker logs -f fleet-proxy

# Filter for errors
docker logs fleet-proxy 2>&1 | grep -i error

# Filter for TLS/ACME activity
docker logs fleet-proxy 2>&1 | grep -i "tls\|acme\|certificate\|renewal"
```

Caddy logs in structured JSON format by default. Key fields to look for:

- `level: error` -- Errors that may need attention.
- `logger: tls.obtain` -- Certificate provisioning events.
- `logger: tls.renew` -- Certificate renewal events.

## Related documentation

- [Architecture Overview](./overview.md) -- System design context
- [Caddy Admin API](./caddy-admin-api.md) -- API endpoint details
- [TLS and ACME](./tls-and-acme.md) -- Certificate lifecycle details
- [Proxy Compose](./proxy-compose.md) -- Caddy container compose configuration
- [Proxy Status and Reload](../proxy-status-reload/overview.md) -- Route
  reconciliation commands
- [Proxy Status Command](../proxy-status-reload/proxy-status.md) -- Ghost and
  missing route detection
- [Bootstrap Integrations](../bootstrap/bootstrap-integrations.md) -- Bootstrap
  sequence and Docker connectivity
- [Bootstrap Troubleshooting](../bootstrap/bootstrap-troubleshooting.md) --
  Diagnosing bootstrap failures
- [Proxy Status/Reload Troubleshooting](../proxy-status-reload/troubleshooting.md) --
  Troubleshooting proxy status and route reload issues
- [Deploy Caddy Route Management](../deploy/caddy-route-management.md) -- How
  routes are registered during deploy
- [State Management Overview](../state-management/overview.md) -- Understanding
  the state file that drives route reconciliation
- [State Operations Guide](../state-management/operations-guide.md) -- How to
  inspect, back up, and recover state
- [SSH Connection Overview](../ssh-connection/overview.md) -- SSH connection
  layer used for all remote Caddy commands
- [Fleet Root Directory Layout](../fleet-root/directory-layout.md) -- Where
  proxy files live on the server
