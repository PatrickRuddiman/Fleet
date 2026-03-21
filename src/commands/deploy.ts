import { Command } from "commander";
import { loadFleetConfig } from "../config";
import { createConnection } from "../ssh";
import { bootstrap } from "../bootstrap";

export function register(program: Command): void {
  program
    .command("deploy")
    .description("Deploy services")
    .action(async () => {
      let config;
      try {
        config = loadFleetConfig("./fleet.yml");
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Failed to load fleet.yml.");
        }
        process.exit(1);
      }

      const acmeEmail = config.routes.find(r => r.acme_email)?.acme_email;

      let connection;
      try {
        connection = await createConnection(config.server);
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Failed to connect to server.");
        }
        process.exit(1);
      }

      try {
        await bootstrap(connection.exec, { acme_email: acmeEmail });
      } catch (error) {
        if (error instanceof Error) {
          console.error(error.message);
        } else {
          console.error("Deploy failed with an unknown error.");
        }
        process.exit(1);
      } finally {
        await connection.close();
      }
    });
}
