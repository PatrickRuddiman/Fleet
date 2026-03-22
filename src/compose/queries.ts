import { ParsedComposeFile, ParsedService, HostPortBinding } from "./types";

export function getServiceNames(compose: ParsedComposeFile): string[] {
  return Object.keys(compose.services);
}

export function serviceExists(
  compose: ParsedComposeFile,
  name: string,
): boolean {
  return name in compose.services;
}

export function findServicesWithoutImageOrBuild(
  compose: ParsedComposeFile,
): string[] {
  return Object.entries(compose.services)
    .filter(([_, service]) => !service.hasImage && !service.hasBuild)
    .map(([name]) => name);
}

export function findHostPortBindings(
  compose: ParsedComposeFile,
): HostPortBinding[] {
  const bindings: HostPortBinding[] = [];
  for (const [service, svc] of Object.entries(compose.services)) {
    for (const port of svc.ports) {
      if (port.published !== null) {
        bindings.push({ service, hostPort: port.published });
      }
    }
  }
  return bindings;
}

export function findReservedPortConflicts(
  compose: ParsedComposeFile,
): HostPortBinding[] {
  return findHostPortBindings(compose).filter(
    (b) => b.hostPort === 80 || b.hostPort === 443,
  );
}

/**
 * Returns true for services that should always be redeployed on every `fleet deploy`,
 * regardless of whether their definition has changed.
 *
 * This covers:
 * - `restart: "no"` — run-once containers that exit after completing their task
 * - `restart: "on-failure"` — services that only restart on failure; without an
 *   explicit redeploy they would not pick up new images or config
 *
 * Note: this is distinct from the Docker concept of "one-shot" (run once and exit).
 * The function name reflects the deployment behaviour (always redeploy), not the
 * Docker restart semantics.
 */
export function alwaysRedeploy(service: ParsedService): boolean {
  if (service.restart === undefined || service.restart === null) {
    return false;
  }
  if (service.restart === "no") {
    return true;
  }
  if (service.restart.startsWith("on-failure")) {
    return true;
  }
  return false;
}

export function getAlwaysRedeploy(compose: ParsedComposeFile): string[] {
  return Object.entries(compose.services)
    .filter(([_, service]) => alwaysRedeploy(service))
    .map(([name]) => name);
}
