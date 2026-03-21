import { BootstrapOptions, AddRouteOptions } from "./types";
import {
  CADDY_CONTAINER_NAME,
  CADDY_ADMIN_URL,
  CADDY_API_ROUTES_PATH,
  CADDY_API_CONFIG_PATH,
  CADDY_API_LOAD_PATH,
  CADDY_API_ID_PATH,
} from "./constants";

export function buildCaddyId(stackName: string, serviceName: string): string {
  return `${stackName}__${serviceName}`;
}

export function buildBootstrapCommand(options?: BootstrapOptions): string {
  const config: Record<string, unknown> = {
    apps: {
      http: {
        servers: {
          fleet: {
            listen: [":443", ":80"],
            routes: [],
          },
        },
      },
    },
  };

  if (options?.acme_email) {
    (config.apps as Record<string, unknown>).tls = {
      automation: {
        policies: [
          {
            issuers: [
              {
                module: "acme",
                email: options.acme_email,
              },
            ],
          },
        ],
      },
    };
  }

  const json = JSON.stringify(config, null, 2);
  return `docker exec -i ${CADDY_CONTAINER_NAME} sh -c 'curl -s -f -X POST -H "Content-Type: application/json" -d @- ${CADDY_ADMIN_URL}${CADDY_API_LOAD_PATH}' << 'FLEET_JSON'\n${json}\nFLEET_JSON`;
}

export function buildAddRouteCommand(options: AddRouteOptions): string {
  const caddyId = buildCaddyId(options.stackName, options.serviceName);

  const route = {
    "@id": caddyId,
    match: [
      {
        host: [options.domain],
      },
    ],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [
          {
            dial: `${options.upstreamHost}:${options.upstreamPort}`,
          },
        ],
      },
    ],
  };

  const json = JSON.stringify(route, null, 2);
  return `docker exec -i ${CADDY_CONTAINER_NAME} sh -c 'curl -s -f -X POST -H "Content-Type: application/json" -d @- ${CADDY_ADMIN_URL}${CADDY_API_ROUTES_PATH}' << 'FLEET_JSON'\n${json}\nFLEET_JSON`;
}

export function buildRemoveRouteCommand(caddyId: string): string {
  return `docker exec ${CADDY_CONTAINER_NAME} curl -s -f -X DELETE ${CADDY_ADMIN_URL}${CADDY_API_ID_PATH}/${caddyId}`;
}

export function buildListRoutesCommand(): string {
  return `docker exec ${CADDY_CONTAINER_NAME} curl -s -f ${CADDY_ADMIN_URL}${CADDY_API_ROUTES_PATH}`;
}

export function buildGetConfigCommand(): string {
  return `docker exec ${CADDY_CONTAINER_NAME} curl -s -f ${CADDY_ADMIN_URL}${CADDY_API_CONFIG_PATH}`;
}
