// Server-side second step for actions that cannot be taken back. The first
// request gets a short-lived, single-use code bound to exactly what was asked;
// the second request must present the code for the same thing. Codes live in
// memory only, so a restart voids them.
import crypto from "node:crypto";

export const CONFIRM_TTL_MS = 2 * 60 * 1000;

interface Pending {
  binding: string;
  expiresAt: number;
}

export class ConfirmStore {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ttlMs: number = CONFIRM_TTL_MS) {}

  /** Issues a code for `binding`: a string naming the action and everything it acts on. */
  issue(binding: string): { confirm: string; expires_at: number } {
    const now = Date.now();
    for (const [code, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(code);
    }
    const confirm = crypto.randomBytes(16).toString("hex");
    const expiresAt = now + this.ttlMs;
    this.pending.set(confirm, { binding, expiresAt });
    return { confirm, expires_at: expiresAt };
  }

  /** Consumes `code`; true only when it is unexpired and was issued for this same binding. */
  redeem(code: string, binding: string): boolean {
    const entry = this.pending.get(code);
    this.pending.delete(code);
    return entry !== undefined && entry.expiresAt > Date.now() && entry.binding === binding;
  }
}

/** Joins the parts of a binding so that no part can run into the next. */
export function bindingOf(...parts: string[]): string {
  return parts.map((part) => crypto.createHash("sha256").update(part).digest("hex")).join(":");
}
