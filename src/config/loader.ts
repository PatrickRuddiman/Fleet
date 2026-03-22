import fs from "fs";
import yaml from "yaml";
import { prettifyError } from "zod";
import { fleetConfigSchema, FleetConfig } from "./schema";

export function loadFleetConfig(filePath: string): FleetConfig {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Could not read config file: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(content);
  } catch {
    throw new Error(`Invalid YAML in config file: ${filePath}`);
  }

  const result = fleetConfigSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = prettifyError(result.error);
    throw new Error(`Invalid Fleet configuration in ${filePath}:\n${formatted}`);
  }

  const config = result.data;

  // Expand $VAR references in all Infisical fields
  if (
    config.env &&
    !Array.isArray(config.env) &&
    "infisical" in config.env &&
    config.env.infisical
  ) {
    const infisical = config.env.infisical;
    const resolveVar = (value: string, fieldName: string): string => {
      if (!value.startsWith("$")) return value;
      const varName = value.slice(1);
      const resolved = process.env[varName];
      if (resolved === undefined) {
        throw new Error(
          `Environment variable "${varName}" referenced by env.infisical.${fieldName} in ${filePath} is not set`
        );
      }
      return resolved;
    };

    return {
      ...config,
      env: {
        ...config.env,
        infisical: {
          token: resolveVar(infisical.token, "token"),
          project_id: resolveVar(infisical.project_id, "project_id"),
          environment: resolveVar(infisical.environment, "environment"),
          path: resolveVar(infisical.path, "path"),
        },
      },
    };
  }

  return config;
}
