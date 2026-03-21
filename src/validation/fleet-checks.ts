import { RouteConfig } from "../config/schema";
import { Finding, Codes } from "./types";

function isValidFqdn(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return false;
  }
  const labelPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      return false;
    }
    if (!labelPattern.test(label)) {
      return false;
    }
  }
  return true;
}

export function checkFqdnFormat(routes: RouteConfig[]): Finding[] {
  const findings: Finding[] = [];
  for (const route of routes) {
    if (!isValidFqdn(route.domain)) {
      findings.push({
        severity: "error",
        code: Codes.INVALID_FQDN,
        message: `Route domain "${route.domain}" is not a valid fully qualified domain name.`,
        resolution: `Use a valid FQDN (e.g., "app.example.com"). Labels must be 1-63 characters of [a-zA-Z0-9-], must not start or end with a hyphen, and the total length must not exceed 253 characters.`,
      });
    }
  }
  return findings;
}

export function checkPortRange(routes: RouteConfig[]): Finding[] {
  const findings: Finding[] = [];
  for (const route of routes) {
    if (route.port < 1 || route.port > 65535) {
      findings.push({
        severity: "error",
        code: Codes.INVALID_PORT_RANGE,
        message: `Route for domain "${route.domain}" specifies port ${route.port} which is outside the valid range.`,
        resolution: `Use a port number between 1 and 65535.`,
      });
    }
  }
  return findings;
}

export function checkDuplicateHosts(routes: RouteConfig[]): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, number>();
  for (const route of routes) {
    const count = (seen.get(route.domain) ?? 0) + 1;
    seen.set(route.domain, count);
  }
  for (const [domain, count] of seen) {
    if (count > 1) {
      findings.push({
        severity: "error",
        code: Codes.DUPLICATE_HOST,
        message: `Domain "${domain}" is used by ${count} routes.`,
        resolution: `Ensure each route uses a unique domain.`,
      });
    }
  }
  return findings;
}
