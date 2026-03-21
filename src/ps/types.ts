export interface ServiceStatus {
  service: string;
  status: string;
}

export interface StackRow {
  stack: string;
  service: string;
  status: string;
  routes: string;
  deployedAt: string;
}
