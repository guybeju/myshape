// Tells the aggregator when a topic becomes dispatchable: it left the "later"
// queue or was reopened, and then stayed put for the delay. Dragging it back
// cancels; moving it again restarts the wait. The waits are kept in the
// board's data, so a restart inside one neither drops nor repeats its notice.
import type { Frozen } from "./records.js";
import { isRecord, readJsonFile, writeFileAtomic } from "./files.js";
import { QUEUES } from "./topics.js";
import type { TopicState } from "./topics.js";

const BATCH_WINDOW_MS = 1000;
const FILE_MODE = 0o644;

export type DispatchReason = "left-later" | "reopened";

export interface PendingNotice {
  dueAt: number;
  reason: DispatchReason;
}

export interface Dispatchable {
  id: string;
  reason: DispatchReason;
}

/** Where the waits are kept between starts. */
export interface NotifyStore {
  load: () => Map<string, PendingNotice>;
  save: (pending: Map<string, PendingNotice>) => void;
}

/** "<queue>:<index>" of a topic that the aggregator may dispatch from, or null. */
function dispatchableSpot(state: Frozen<TopicState>, id: string): string | null {
  for (const queue of QUEUES) {
    const index = state.doc.queues[queue].indexOf(id);
    if (index !== -1) return queue === "later" ? null : `${queue}:${index}`;
  }
  return null;
}

/** The waits in `file` (data/myshape/notify-pending.json); a missing or unreadable file holds none. */
export function fileStore(file: string): NotifyStore {
  return {
    load: () => {
      const pending = new Map<string, PendingNotice>();
      let raw: unknown = null;
      try {
        raw = readJsonFile(file);
      } catch {
        raw = null;
      }
      const entries = isRecord(raw) && isRecord(raw["pending"]) ? raw["pending"] : {};
      for (const [id, entry] of Object.entries(entries)) {
        if (!isRecord(entry) || typeof entry["due_at"] !== "number") continue;
        const reason = entry["reason"] === "reopened" ? "reopened" : "left-later";
        pending.set(id, { dueAt: entry["due_at"], reason });
      }
      return pending;
    },
    save: (pending) => {
      const entries = Object.fromEntries(
        [...pending].map(([id, entry]) => [id, { due_at: entry.dueAt, reason: entry.reason }]),
      );
      writeFileAtomic(file, `${JSON.stringify({ v: 1, pending: entries })}\n`, FILE_MODE);
    },
  };
}

export class DispatchNotifier {
  private readonly pending: Map<string, PendingNotice>;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly store: NotifyStore,
    private readonly notify: (ready: Dispatchable[]) => void,
  ) {
    this.pending = store.load();
  }

  /**
   * Picks up the waits an earlier start left, keeping those still dispatchable;
   * a wait already over fires at once.
   */
  start(state: Frozen<TopicState>): void {
    const before = this.pending.size;
    for (const id of this.pending.keys()) {
      if (dispatchableSpot(state, id) === null) this.pending.delete(id);
    }
    if (this.pending.size !== before) this.store.save(this.pending);
    this.schedule();
  }

  /** Call after every topic change with the topics the change made dispatchable. */
  observe(
    before: Frozen<TopicState>,
    after: Frozen<TopicState>,
    becameDispatchable: string[],
  ): void {
    const due = Date.now() + this.delayMs;
    let changed = false;
    for (const [id, entry] of this.pending) {
      const spot = dispatchableSpot(after, id);
      if (spot === null) {
        this.pending.delete(id);
        changed = true;
      } else if (spot !== dispatchableSpot(before, id)) {
        this.pending.set(id, { ...entry, dueAt: due });
        changed = true;
      }
    }
    for (const id of becameDispatchable) {
      const reason = before.archive.topics[id] === undefined ? "left-later" : "reopened";
      this.pending.set(id, { dueAt: due, reason });
      changed = true;
    }
    if (changed) this.store.save(this.pending);
    this.schedule();
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.stop();
    if (this.pending.size === 0) return;
    const earliest = Math.min(...[...this.pending.values()].map((entry) => entry.dueAt));
    this.timer = setTimeout(() => this.fire(), Math.max(0, earliest - Date.now()));
  }

  /** Hands over every topic due now or within the batch window, then forgets them. */
  private fire(): void {
    const cutoff = Date.now() + BATCH_WINDOW_MS;
    const ready = [...this.pending]
      .filter(([, entry]) => entry.dueAt <= cutoff)
      .map(([id, entry]) => ({ id, reason: entry.reason }));
    // The notices are recorded before the waits are forgotten: a crash in
    // between repeats a notice rather than losing it.
    this.notify(ready);
    for (const { id } of ready) this.pending.delete(id);
    this.store.save(this.pending);
    this.schedule();
  }
}
