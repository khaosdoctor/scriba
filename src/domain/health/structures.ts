export interface UpstreamStatus {
  name: string;
  up: boolean;
  latencyMs: number;
  error: string | null;
}
