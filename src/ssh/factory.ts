import { ServerConfig } from "../config";
import { Connection } from "./types";
import { createSshConnection } from "./ssh";
import { createLocalConnection } from "./local";

export async function createConnection(config: ServerConfig): Promise<Connection> {
  if (config.host === "localhost" || config.host === "127.0.0.1") {
    return createLocalConnection();
  }
  return createSshConnection(config);
}
