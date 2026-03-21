import yaml from "yaml";
import { GenerateFleetYmlOptions } from "./types";

export function generateFleetYml(options: GenerateFleetYmlOptions): string {
  const { compose, stackName, composeFilename } = options;

  // Classify services
  const routedServices: { name: string; port: number; ambiguous: boolean }[] = [];
  const skippedServices: string[] = [];

  if (compose) {
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.ports.length > 0) {
        const target = service.ports[0].target;
        routedServices.push({
          name,
          port: target,
          ambiguous: target === 0,
        });
      } else {
        skippedServices.push(name);
      }
    }
  }

  // Build route objects
  const routeObjects = routedServices.map((svc) => ({
    domain: `${svc.name}.${stackName}.example.com`,
    port: svc.port,
    service: svc.name,
    acme_email: "you@example.com",
  }));

  // Build YAML document
  const doc = new yaml.Document();
  const content = doc.createNode({
    version: "1",
    server: {
      host: "YOUR_SERVER_IP",
    },
    stack: {
      name: stackName,
      compose_file: composeFilename,
    },
    routes: routeObjects,
  });
  doc.contents = content;

  // Annotate server.host
  const serverNode = content.get("server", true) as unknown as yaml.YAMLMap;
  const hostPair = serverNode.items.find(
    (p: any) => p.key.value === "host"
  );
  if (hostPair) {
    (hostPair as any).value.comment = " TODO: Replace with your server IP or hostname";
  }

  // Annotate routes section for missing compose or skipped services
  const routesPair = (content as yaml.YAMLMap).items.find(
    (p: any) => p.key.value === "routes"
  );

  if (compose === null) {
    if (routesPair) {
      (routesPair as any).key.commentBefore = " No compose file found. Add your routes manually.";
    }
  } else if (skippedServices.length > 0) {
    if (routesPair) {
      (routesPair as any).key.commentBefore = ` Skipped services (no port mappings): ${skippedServices.join(", ")}`;
    }
  } else if (routedServices.length === 0) {
    if (routesPair) {
      (routesPair as any).key.commentBefore = " No services with port mappings found. Add your routes manually.";
    }
  }

  // Annotate per-route fields
  const routesSeq = content.get("routes", true) as unknown as yaml.YAMLSeq;
  routedServices.forEach((svc, i) => {
    const routeMap = routesSeq.items[i] as yaml.YAMLMap;

    const domainPair = routeMap.items.find(
      (p: any) => p.key.value === "domain"
    );
    if (domainPair) {
      (domainPair as any).value.comment = " TODO: Replace with actual public domain";
    }

    if (svc.ambiguous) {
      const portPair = routeMap.items.find(
        (p: any) => p.key.value === "port"
      );
      if (portPair) {
        (portPair as any).value.comment = " TODO: Replace with the correct container port";
      }
    }

    const acmePair = routeMap.items.find(
      (p: any) => p.key.value === "acme_email"
    );
    if (acmePair) {
      (acmePair as any).value.comment = " TODO: Replace with your ACME email for TLS certificates";
    }
  });

  return doc.toString();
}
