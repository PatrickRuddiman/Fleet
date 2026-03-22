export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  resolution: string;
}

export const Codes = {
  INVALID_FQDN: "INVALID_FQDN",
  INVALID_PORT_RANGE: "INVALID_PORT_RANGE",
  DUPLICATE_HOST: "DUPLICATE_HOST",
  PORT_80_CONFLICT: "PORT_80_CONFLICT",
  PORT_443_CONFLICT: "PORT_443_CONFLICT",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  PORT_EXPOSED: "PORT_EXPOSED",
  NO_IMAGE_OR_BUILD: "NO_IMAGE_OR_BUILD",
  ONE_SHOT_NO_MAX_ATTEMPTS: "ONE_SHOT_NO_MAX_ATTEMPTS",
  INVALID_STACK_NAME: "INVALID_STACK_NAME",
} as const;
