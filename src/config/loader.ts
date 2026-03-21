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

  // Expand environment variable reference in infisical token
  if (config.env?.infisical?.token.startsWith("$")) {
    const varName = config.env.infisical.token.slice(1);
    const resolved = process.env[varName];
    if (resolved === undefined) {
      throw new Error(
        `Environment variable "${varName}" referenced by env.infisical.token in ${filePath} is not set`
      );
    }
    return {
      ...config,
      env: {
        ...config.env,
        infisical: {
          ...config.env.infisical,
          token: resolved,
        },
      },
    };
  }

  return config;
}
