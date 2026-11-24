// The captain's confirmations that the board may run a program it cannot
// vouch for (contracts section 7): each one binds the program's path to the
// SHA-256 of its bytes and of the binding file's bytes when it was confirmed,
// so a change to either asks again. Written only by the page's confirm action,
// through store.ts commitChange, into data/myshape/confirmations.json.
import type { Frozen, Records } from "./records.js";

export interface Confirmation {
  path: string;
  sha256: string;
  binding_sha256: string;
  at: string;
}

export interface ConfirmationStore {
  v: 1;
  /** At most one per program path: the latest confirmation of it. */
  entries: Confirmation[];
}

export function emptyConfirmations(): ConfirmationStore {
  return { v: 1, entries: [] };
}

const SHA = /^[0-9a-f]{64}$/;

export function isConfirmed(
  store: Frozen<ConfirmationStore>,
  program: string,
  sha256: string,
  bindingSha256: string,
): boolean {
  return store.entries.some(
    (entry) =>
      entry.path === program && entry.sha256 === sha256 && entry.binding_sha256 === bindingSha256,
  );
}

export type ConfirmResult =
  | { ok: false; code: "refused" | "usage"; line: string }
  | { ok: true; changed: false; store: Frozen<ConfirmationStore>; line: string }
  | {
      ok: true;
      changed: true;
      store: Frozen<ConfirmationStore>;
      records: Records;
      line: string;
    };

export interface ConfirmInput {
  path: string;
  sha256: string;
  binding_sha256: string;
  /** The roles the program has in the binding, for the record's text. */
  roles: string[];
}

/** Records the captain's confirmation of one program's bytes under one binding. */
export function confirmProgram(
  store: Frozen<ConfirmationStore>,
  input: ConfirmInput,
  now: string,
): ConfirmResult {
  if (!input.path.startsWith("/") || !SHA.test(input.sha256) || !SHA.test(input.binding_sha256))
    return { ok: false, code: "usage", line: "確認需要程式的完整路徑與兩個 SHA-256。" };
  if (isConfirmed(store, input.path, input.sha256, input.binding_sha256))
    return { ok: true, changed: false, store, line: `ok 已經確認過 ${input.path}` };
  const entry: Confirmation = {
    path: input.path,
    sha256: input.sha256,
    binding_sha256: input.binding_sha256,
    at: now,
  };
  const next: ConfirmationStore = {
    v: 1,
    entries: [...store.entries.filter((kept) => kept.path !== input.path), entry],
  };
  const roles = input.roles.join("、");
  return {
    ok: true,
    changed: true,
    store: next,
    records: [
      {
        kind: "program.confirmed",
        topic: null,
        text: `確認看板可以執行 ${input.path}（${roles}；SHA-256 ${input.sha256}）`,
      },
    ],
    line: `ok 已確認 ${input.path}`,
  };
}
