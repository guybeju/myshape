// Prints the dispatch order of one board home as JSON lines: one
// {"kind":"dispatch",…} line per entry, in order, then one {"kind":"skip",…}
// line per topic or occurrence that gets no new work. It only reads the
// board's files; it starts nothing and writes nothing.

import { isAbsolute } from "node:path";

import { BoardFileError, readBoard } from "./board-files.js";
import { dispatchOrder } from "./dispatch-order.js";

export const USAGE = "usage: print-order <absolute path of a board home>";

export interface Io {
  nowMs: number;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Prints the order for the home named by `args`.
 *
 * Returns:
 *   0 when printed, 1 when a board file is malformed (nothing goes to stdout),
 *   2 on a usage error.
 */
export function printOrder(args: readonly string[], io: Io): number {
  const [home] = args;
  if (args.length !== 1 || home === undefined || !isAbsolute(home)) {
    io.stderr(USAGE);
    return 2;
  }
  let board;
  try {
    board = readBoard(home);
  } catch (error) {
    if (!(error instanceof BoardFileError)) throw error;
    io.stderr(`print-order: ${error.message}`);
    return 1;
  }
  const { order, skipped } = dispatchOrder(board, io.nowMs);
  for (const entry of order) io.stdout(JSON.stringify({ kind: "dispatch", ...entry }));
  for (const entry of skipped) io.stdout(JSON.stringify({ kind: "skip", ...entry }));
  return 0;
}
