// Where the board keeps its files. One place, so the service and the client
// can never disagree about a path.
import path from "node:path";
import { BINDING_NAME } from "./binding.js";

export const DEFAULT_PORT = 47819;

export interface BoardConfig {
  /** The main home. */
  home: string;
  /** The code root whose bin/ scripts the board runs. */
  root: string;
  /** The code root's git commit, read by myshape.sh. */
  commit: string;
  port: number;
  /** The home's state directory. */
  state: string;
  /** The home's data directory. */
  data: string;
  /** The home's config directory, which holds the binding file. */
  config: string;
  /** The SHA-256 of the binding file myshape.sh read when it started the service, or "-". */
  binding: string;
  /**
   * The binding's paths that myshape.sh found tracked by git under the code
   * root's bin/ and equal to HEAD; they run without a confirmation while the
   * binding file is the one it read.
   */
  exempt: string[];
}

export interface BoardPaths {
  runtimeDir: string;
  socket: string;
  token: string;
  port: string;
  pid: string;
  log: string;
  startupError: string;
  audit: string;
  topics: string;
  archive: string;
  dataDir: string;
  boardDataDir: string;
  events: string;
  summaries: string;
  /** The topics waiting out the delay before their dispatchable notice. */
  notifyPending: string;
  /** The aggregator block of the last root report, for texts written while no report is at hand. */
  aggregator: string;
  /** The hands-on items the board keeps for the captain. */
  todos: string;
  /** Per home: which decisions the board saw at its last read, and the closed decisions' cursor. */
  decisions: string;
  /** The aggregator's binding (config/myshape-aggregator.json). */
  binding: string;
  /** The captain's confirmations of programs the board runs. */
  confirmations: string;
}

export function boardPaths(config: Pick<BoardConfig, "state" | "data" | "config">): BoardPaths {
  const runtimeDir = path.join(config.state, "myshape");
  const boardDataDir = path.join(config.data, "myshape");
  return {
    runtimeDir,
    socket: path.join(runtimeDir, "board.sock"),
    token: path.join(runtimeDir, "token"),
    port: path.join(runtimeDir, "port"),
    pid: path.join(runtimeDir, "pid"),
    log: path.join(runtimeDir, "service.log"),
    startupError: path.join(runtimeDir, "startup-error"),
    audit: path.join(runtimeDir, "audit.jsonl"),
    topics: path.join(config.data, "topics.json"),
    archive: path.join(config.data, "topics-archive.json"),
    dataDir: config.data,
    boardDataDir,
    events: path.join(boardDataDir, "events.jsonl"),
    summaries: path.join(boardDataDir, "summaries.jsonl"),
    notifyPending: path.join(boardDataDir, "notify-pending.json"),
    aggregator: path.join(boardDataDir, "aggregator.json"),
    todos: path.join(boardDataDir, "todos.json"),
    decisions: path.join(boardDataDir, "decisions.json"),
    binding: path.join(config.config, BINDING_NAME),
    confirmations: path.join(boardDataDir, "confirmations.json"),
  };
}

const CONFIG_FLAGS = [
  "home",
  "root",
  "commit",
  "port",
  "state",
  "data",
  "config",
  "binding",
  "exempt",
] as const;
const SHA_OR_NONE = /^(-|[0-9a-f]{64})$/;

/** Reads leading `--flag value` pairs up to `--`; returns them and the arguments after it. */
function splitFlags(argv: string[]): { values: Map<string, string>; rest: string[] } {
  const values = new Map<string, string>();
  let index = 0;
  while (index < argv.length && argv[index] !== "--") {
    const flag = argv[index] as string;
    const value = argv[index + 1];
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!(CONFIG_FLAGS as readonly string[]).includes(name) || value === undefined) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    values.set(name, value);
    index += 2;
  }
  return { values, rest: argv.slice(index + 1) };
}

/** The `--exempt` value: "-" for none, else binding paths joined by commas. */
function exemptList(value: string): string[] {
  return value === "-" ? [] : value.split(",").filter((entry) => entry !== "");
}

/**
 * Reads the `--home --root --commit --port --state --data --config --binding
 * --exempt` flags that myshape.sh passes to both programs, and returns the
 * remaining arguments. A start without the binding's flags is refused, so no
 * program can run without a confirmation by default.
 */
export function parseConfigArgs(argv: string[]): { config: BoardConfig; rest: string[] } {
  const { values, rest } = splitFlags(argv);
  const need = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === "") throw new Error(`missing --${name}`);
    return value;
  };
  const port = Number(need("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port is not a port number");
  const binding = need("binding");
  if (!SHA_OR_NONE.test(binding)) throw new Error("--binding is not a SHA-256 or -");
  return {
    config: {
      home: need("home"),
      root: need("root"),
      commit: need("commit"),
      port,
      state: need("state"),
      data: need("data"),
      config: need("config"),
      binding,
      exempt: exemptList(need("exempt")),
    },
    rest,
  };
}
