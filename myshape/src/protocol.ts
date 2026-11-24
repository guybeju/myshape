// The line-delimited JSON spoken over the Unix socket: one request line in, one
// response line out, then the connection closes.

export interface BoardRequest {
  v: 1;
  op: string;
  args: Record<string, unknown>;
}

export interface BoardResponse {
  ok: boolean;
  /** The line myshape.sh prints (stdout on success, stderr on failure). */
  line: string;
  /** Why a request failed: "refused" exits 1, "usage" exits 2. */
  code?: "refused" | "usage";
  data?: Record<string, unknown>;
}

export interface HealthData {
  pid: number;
  port: number;
  code_commit: string;
  /** The SHA-256 of the binding file the service was started with, or "-". */
  binding_sha256: string;
  /** The code root a relative program path resolves against. */
  root: string;
  boot_id: string;
  started_at: string;
}

export const MAX_REQUEST_BYTES = 1024 * 1024;
