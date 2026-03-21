export interface BootstrapOptions {
  acme_email?: string;
}

export interface AddRouteOptions {
  stackName: string;
  serviceName: string;
  domain: string;
  upstreamHost: string;
  upstreamPort: number;
  tls?: boolean;
  acme_email?: string;
}
