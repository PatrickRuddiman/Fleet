import { ParsedComposeFile, HostPortBinding } from "./types";

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
