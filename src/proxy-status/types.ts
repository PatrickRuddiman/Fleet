export interface LiveRoute {
  hostname: string;
  upstream: string;
}

export interface ContainerStatus {
  running: boolean;
  status: string;
}

export interface ReconciliationResult {
  ghostRoutes: string[];
  missingRoutes: string[];
}
