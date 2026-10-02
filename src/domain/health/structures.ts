export interface UpstreamStatus {
  name: string;
  up: boolean;
  latencyMs: number | null;
  error: string | null;
  failures: number;
  since: number;
}
