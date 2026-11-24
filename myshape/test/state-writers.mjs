// Guard 3.4: the board's state files have one writer. Reads every .ts file
// under myshape/src (tests excluded) with the scanner of the TypeScript the
// board builds with, so a comment or a string is never code, and prints one
// line per problem:
//   - topics.json, the archive, todos.json and confirmations.json are written
//     (writeFileAtomic or writeIfChanged) only in store.ts's writeTopics,
//     writeTodos, writeConfirmations and writeIfChanged, and those three
//     writers are called only from commitChange;
//   - a record reaches the journal only through store.ts's flushOutbox (the
//     sink's append) and the one sink, commitTarget in board-server.ts;
//   - store.ts exports no function but readBoard, loadBoard and commitChange;
//   - decisions.json, what the board saw at its last read of each home, is
//     written only in decisions.ts (DecisionStore), and the decision records
//     that read leaves are saved only through board-server.ts saveRecords,
//     which commits them with commitChange;
//   - no file but topics.ts, todos.ts, confirmations.ts and store.ts assigns
//     into, deletes from or pushes onto the board's state (doc, archive, items,
//     marks, closed, outbox, queues, merged, history, confirmations, entries),
//     which a cast past the read-only types would otherwise allow.
//
// Usage: node state-writers.mjs <typescript-package-dir> <src-dir>
import fs from "node:fs";
import path from "node:path";

const [typescript, srcDir] = process.argv.slice(2);
const { SyntaxKind: K } = await import(path.join(typescript, "dist/ast/index.js"));
const { createScanner } = await import(path.join(typescript, "dist/ast/scanner.js"));

const STATE_FIELDS = new Set(["doc", "archive", "items", "marks", "closed", "outbox", "queues", "merged", "history",
  "confirmations", "entries"]);
const STATE_OWNERS = new Set(["topics.ts", "todos.ts", "confirmations.ts", "store.ts"]);
const STATE_PATHS = new Set(["topics", "archive", "todos", "confirmations"]);
const STORE_EXPORTS = new Set(["readBoard", "loadBoard", "commitChange"]);
const WRITERS = new Set(["writeTopics", "writeTodos", "writeConfirmations", "writeIfChanged"]);
const ASSIGN = new Set([K.EqualsToken, K.PlusEqualsToken, K.MinusEqualsToken, K.AsteriskEqualsToken,
  K.SlashEqualsToken, K.BarBarEqualsToken, K.AmpersandAmpersandEqualsToken, K.QuestionQuestionEqualsToken,
  K.PlusPlusToken, K.MinusMinusToken]);
// After these a "/" starts a regular expression, not a division (as word-scan.mjs).
const BEFORE_REGEX = new Set([K.OpenParenToken, K.CommaToken, K.EqualsToken, K.ColonToken, K.OpenBracketToken,
  K.ExclamationToken, K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionToken, K.OpenBraceToken, K.CloseBraceToken,
  K.SemicolonToken, K.ReturnKeyword, K.TypeOfKeyword, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken,
  K.QuestionQuestionToken, K.EqualsGreaterThanToken, K.PlusToken, K.MinusToken]);
// A cast to one of these drops the read-only type of the board's state.
const MUTABLE_STATE = new Set(["TopicState", "TopicsDoc", "ArchiveDoc", "Topic", "TodoStore", "TodoItem", "StoredBoard",
  "ConfirmationStore", "Confirmation"]);
const MUTATORS = new Set(["push", "pop", "splice", "shift", "unshift", "sort", "reverse", "fill"]);

/** Every code token of `text` with the top-level function it is in. */
function tokens(text) {
  const scanner = createScanner(true, 0, text);
  const lineStarts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) lineStarts.push(at + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const found = [];
  const braces = [];
  let depth = 0;
  let pending = null;
  let current = null;
  let exporting = false;
  let previous = K.SemicolonToken;
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && BEFORE_REGEX.has(previous))
      kind = scanner.reScanSlashToken();
    if (kind === K.CloseBraceToken && braces.at(-1) === "template") {
      braces.pop();
      kind = scanner.reScanTemplateToken(false);
    }
    if (kind === K.TemplateHead || kind === K.TemplateMiddle) braces.push("template");
    const value = kind === K.Identifier ? scanner.getTokenValue() : scanner.getTokenText();
    if (depth === 0 && kind === K.ExportKeyword) exporting = true;
    if (depth === 0 && kind === K.FunctionKeyword) pending = { name: null, exported: exporting };
    else if (pending !== null && pending.name === null && kind === K.Identifier) pending.name = value;
    if (kind === K.OpenBraceToken) {
      braces.push("brace");
      if (depth === 0 && pending !== null) {
        current = pending.name;
        if (pending.exported) found.push({ kind: "export", value: pending.name, fn: null, line: 0 });
        pending = null;
      }
      depth += 1;
    }
    if (kind === K.CloseBraceToken && braces.at(-1) === "brace") {
      braces.pop();
      depth -= 1;
      if (depth === 0) {
        current = null;
        exporting = false;
      }
    }
    if (depth === 0 && kind === K.SemicolonToken) exporting = false;
    previous = kind;
    found.push({ kind, value, fn: current, line: lineOf(scanner.getTokenStart()) });
  }
  return found;
}

/** The property chain that ends at index `end` (inclusive), as names, and where it starts. */
function chainBefore(list, end) {
  const names = [];
  let at = end;
  while (at >= 0 && list[at].kind === K.Identifier) {
    names.unshift(list[at].value);
    if (at >= 1 && list[at - 1].kind === K.DotToken) at -= 2;
    else break;
  }
  return { names, start: at };
}

function isStateChain(names) {
  return names.slice(1).some((name) => STATE_FIELDS.has(name));
}

const problems = [];
const files = fs.readdirSync(srcDir, { recursive: true })
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => path.join(srcDir, name));
for (const file of files) {
  const base = path.basename(file);
  const where = (token) => `${path.relative(srcDir, file)}:${token.line}`;
  const list = tokens(fs.readFileSync(file, "utf8"));
  for (const [index, token] of list.entries()) {
    const next = list[index + 1];
    const call =
      token.kind === K.Identifier && next?.kind === K.OpenParenToken && list[index - 1]?.kind !== K.FunctionKeyword;
    if (token.kind === "export" && base === "store.ts" && !STORE_EXPORTS.has(token.value))
      problems.push(`store.ts exports function ${token.value}; only ${[...STORE_EXPORTS].join(", ")} may be exported`);
    if (call && token.value === "writeFileAtomic") {
      const args = [];
      for (let at = index + 2; at < list.length && list[at].kind !== K.CommaToken; at += 1) args.push(list[at].value);
      const statePath = args.some((value) => STATE_PATHS.has(value));
      const allowed = base === "store.ts" && WRITERS.has(token.fn);
      if (statePath && !allowed) problems.push(`${where(token)}: a state file written outside store.ts's writers (${args.join("")})`);
      if (args.includes("decisions") && base !== "decisions.ts") problems.push(`${where(token)}: decisions.json written outside decisions.ts (${args.join("")})`);
    }
    if (call && WRITERS.has(token.value) && token.value !== "writeIfChanged" && !(base === "store.ts" && token.fn === "commitChange"))
      problems.push(`${where(token)}: ${token.value} called outside commitChange`);
    if (call && token.value === "writeIfChanged" && !(base === "store.ts" && WRITERS.has(token.fn)))
      problems.push(`${where(token)}: writeIfChanged called outside store.ts's writers`);
    if (token.kind === K.Identifier && token.value === "appendRecord" && list[index - 1]?.kind === K.DotToken) {
      const allowed = base === "board-server.ts" && token.fn === "commitTarget";
      if (!allowed) problems.push(`${where(token)}: appendRecord used outside board-server.ts commitTarget`);
    }
    if (call && token.value === "append" && list[index - 2]?.value === "sink") {
      const allowed = base === "store.ts" && token.fn === "flushOutbox";
      if (!allowed) problems.push(`${where(token)}: a record appended outside store.ts flushOutbox`);
    }
    if (call && token.value === "decisionStep") {
      const allowed = base === "board-server.ts" && token.fn === "recordDecisions";
      if (!allowed) problems.push(`${where(token)}: decision records made outside board-server.ts recordDecisions`);
    }
    if (base === "board-server.ts" && token.fn === "recordDecisions" && call
      && (token.value === "commitChange" || token.value === "appendRecord"))
      problems.push(`${where(token)}: recordDecisions saves its records other than through saveRecords`);
    if (STATE_OWNERS.has(base)) continue;
    if (ASSIGN.has(token.kind) && list[index - 1]?.kind === K.Identifier) {
      const { names } = chainBefore(list, index - 1);
      if (isStateChain(names)) problems.push(`${where(token)}: assigns into the board's state (${names.join(".")})`);
    }
    if (token.kind === K.DeleteKeyword || token.kind === K.PlusPlusToken || token.kind === K.MinusMinusToken) {
      const names = [];
      for (let at = index + 1; at < list.length && list[at].kind !== K.SemicolonToken && list[at].line === token.line; at += 1)
        if (list[at].kind === K.Identifier) names.push(list[at].value);
      if (names.some((name) => STATE_FIELDS.has(name)))
        problems.push(`${where(token)}: changes the board's state (${names.join(".")})`);
    }
    if (call && MUTATORS.has(token.value) && list[index - 1]?.kind === K.DotToken) {
      const { names } = chainBefore(list, index - 2);
      if (isStateChain([...names, token.value]))
        problems.push(`${where(token)}: changes the board's state (${names.join(".")}.${token.value})`);
    }
    if (token.kind === K.AsKeyword && next?.kind === K.Identifier && MUTABLE_STATE.has(next.value))
      problems.push(`${where(token)}: casts away the read-only board state (as ${next.value})`);
  }
}
for (const problem of problems) console.log(problem);
