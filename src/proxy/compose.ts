import { ExecFn } from "../ssh";
import { PROXY_DIR } from "../fleet-root";

const COMPOSE_FILENAME = "compose.yml";

export function generateProxyCompose(): string {
  return `services:
  fleet-caddy:
    image: caddy:2-alpine
    container_name: fleet-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    networks:
      - fleet-proxy
    volumes:
      - caddy_data:/data
      - caddy_config:/config
    command: caddy run --resume

networks:
  fleet-proxy:
    external: true

volumes:
  caddy_data:
  caddy_config:
`;
}

export async function writeProxyCompose(
  fleetRoot: string,
  exec: ExecFn
): Promise<void> {
  const content = generateProxyCompose();
  const dir = `${fleetRoot}/${PROXY_DIR}`;
  const filePath = `${dir}/${COMPOSE_FILENAME}`;
  const tmpPath = `${filePath}.tmp`;

  const command = `mkdir -p ${dir} && cat << 'FLEET_EOF' > ${tmpPath}\n${content}FLEET_EOF\n&& mv ${tmpPath} ${filePath}`;

  const result = await exec(command);

  if (result.code !== 0) {
    const detail = result.stderr ? ` — ${result.stderr}` : "";
    throw new Error(
      `Failed to write proxy compose file: command exited with code ${result.code}${detail}`
    );
  }
}
