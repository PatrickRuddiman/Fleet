import { z } from "zod";

export const serverSchema = z.object({
  host: z.string(),
  port: z.number().int().default(22),
  user: z.string().default("root"),
  identity_file: z.string().optional(),
});

export const envSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const infisicalSchema = z.object({
  project_id: z.string(),
  environment: z.string(),
});

export const healthCheckSchema = z.object({
  path: z.string(),
  timeout_seconds: z.number().int().default(30),
  interval_seconds: z.number().int().default(5),
});

export const routeSchema = z.object({
  domain: z.string(),
  port: z.number().int(),
  service: z.string().optional(),
  tls: z.boolean().default(true),
  acme_email: z.string().email().optional(),
  health_check: healthCheckSchema.optional(),
});

export const STACK_NAME_REGEX = /^[a-z\d][a-z\d-]*$/;

export const stackSchema = z.object({
  name: z.string().regex(STACK_NAME_REGEX),
  compose_file: z.string().default("docker-compose.yml"),
});

export const fleetConfigSchema = z.object({
  version: z.literal("1"),
  server: serverSchema,
  stack: stackSchema,
  env: z.array(envSchema).optional(),
  infisical: infisicalSchema.optional(),
  routes: z.array(routeSchema).min(1),
});

export type FleetConfig = z.infer<typeof fleetConfigSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type StackConfig = z.infer<typeof stackSchema>;
export type RouteConfig = z.infer<typeof routeSchema>;
export type EnvConfig = z.infer<typeof envSchema>;
export type HealthCheckConfig = z.infer<typeof healthCheckSchema>;
