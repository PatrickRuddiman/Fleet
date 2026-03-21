import { FleetConfig } from "../config/schema";
import { ParsedComposeFile } from "../compose/types";
import {
  serviceExists,
  findServicesWithoutImageOrBuild,
  findHostPortBindings,
  findReservedPortConflicts,
} from "../compose/queries";
import { Finding, Codes } from "./types";

export function checkReservedPortConflicts(
  compose: ParsedComposeFile,
): Finding[] {
  const findings: Finding[] = [];
  const conflicts = findReservedPortConflicts(compose);

  for (const binding of conflicts) {
    if (binding.hostPort === 80) {
      findings.push({
        code: Codes.PORT_80_CONFLICT,
        severity: "error",
        message: `Service "${binding.service}" binds host port 80 which is reserved for the reverse proxy`,
        resolution: `Remove the host port 80 binding from service "${binding.service}" in compose.yml; the reverse proxy handles port 80`,
      });
    } else if (binding.hostPort === 443) {
      findings.push({
        code: Codes.PORT_443_CONFLICT,
        severity: "error",
        message: `Service "${binding.service}" binds host port 443 which is reserved for the reverse proxy`,
        resolution: `Remove the host port 443 binding from service "${binding.service}" in compose.yml; the reverse proxy handles port 443`,
      });
    }
  }

  return findings;
}

export function checkServiceNotFound(
  config: FleetConfig,
  compose: ParsedComposeFile,
): Finding[] {
  const findings: Finding[] = [];

  for (const route of config.routes) {
    if (route.service !== undefined && !serviceExists(compose, route.service)) {
      findings.push({
        code: Codes.SERVICE_NOT_FOUND,
        severity: "error",
        message: `Route "${route.domain}" references service "${route.service}" which does not exist in compose.yml`,
        resolution: `Add service "${route.service}" to compose.yml or update the route for "${route.domain}"`,
      });
    }
  }

  return findings;
}

export function checkPortExposed(compose: ParsedComposeFile): Finding[] {
  const findings: Finding[] = [];
  const bindings = findHostPortBindings(compose);

  for (const binding of bindings) {
    if (binding.hostPort !== 80 && binding.hostPort !== 443) {
      findings.push({
        code: Codes.PORT_EXPOSED,
        severity: "warning",
        message: `Service "${binding.service}" binds host port ${binding.hostPort} which may conflict with other stacks`,
        resolution: `Consider removing the host port binding for port ${binding.hostPort} from service "${binding.service}" unless external access is required`,
      });
    }
  }

  return findings;
}

export function checkNoImageOrBuild(compose: ParsedComposeFile): Finding[] {
  const findings: Finding[] = [];
  const serviceNames = findServicesWithoutImageOrBuild(compose);

  for (const name of serviceNames) {
    findings.push({
      code: Codes.NO_IMAGE_OR_BUILD,
      severity: "warning",
      message: `Service "${name}" has no "image" or "build" directive`,
      resolution: `Add an "image" or "build" directive to service "${name}" in compose.yml`,
    });
  }

  return findings;
}
