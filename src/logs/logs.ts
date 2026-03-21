import path from "path";
import { loadFleetConfig } from "../config";
import { createConnection, Connection } from "../ssh";
import { readState, getStack } from "../state";

export async function logs(
  stackName: string,
  service?: string,
  tail?: number
): Promise<void> {
  let connection: Connection | null = null;

  try {
    // Step 1: Load config
    const configPath = path.resolve("fleet.yml");
    const config = loadFleetConfig(configPath);

    // Step 2: Create SSH connection
    connection = await createConnection(config.server);

    // Step 3: Read state
    const state = await readState(connection.exec);

    // Step 4: Validate stack exists
    const stack = getStack(state, stackName);
    if (!stack) {
      throw new Error(`Stack "${stackName}" not found on the remote server.`);
    }

    // Step 5: Build docker compose logs command
    let command = `docker compose -p ${stackName} logs -f`;
    if (tail !== undefined) {
      command += ` --tail ${tail}`;
    }
    if (service) {
      command += ` ${service}`;
    }

    // Step 6: Handle SIGINT for clean shutdown
    const onSigint = () => {
      if (connection) {
        connection.close().catch(() => {});
      }
    };
    process.on("SIGINT", onSigint);

    try {
      // Step 7: Stream execution
      await connection.streamExec(command, {
        onStdout: (chunk: string) => {
          process.stdout.write(chunk);
        },
        onStderr: (chunk: string) => {
          process.stderr.write(chunk);
        },
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  } finally {
    if (connection) {
      await connection.close();
    }
  }
}
