// Which aggregator the board reaches, and whether each of its two programs may
// run right now (contracts section 7). The binding file names the aggregator
// and the paths of its feed and its deliverer, nothing else; the board adds
// the words "feed" and "deliver" itself. Before every run the program is
// checked again: a program myshape.sh found tracked and unmodified under the
// code root's bin/ when it started the service runs without a confirmation;
// every other one runs only while the page's confirmation of its bytes and of
// the binding's bytes still holds.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./files.js";

/** The binding file's name in the home's config directory. */
export const BINDING_NAME = "myshape-aggregator.json";
const BINDING_SHOWN = `config/${BINDING_NAME}`;
const BINDING_MAX_BYTES = 4096;
const PATH_MAX = 4096;
const BINDING_KEYS = ["v", "name", "feed", "deliver"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A path relative to the code root under bin/, written plainly: every part
// starts with a letter, a digit or "_", so "." and ".." never pass.
const EXEMPT_CANDIDATE = /^bin\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export type Role = "feed" | "deliver";
export const ROLES: readonly Role[] = ["feed", "deliver"];

export interface Binding {
  name: string;
  feed: string;
  deliver: string;
}

export type BindingRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string; sha256: string | null }
  | { kind: "ok"; binding: Binding; sha256: string };

export function sha256Of(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Why one program field is not a plain path, or null when it is one. */
function pathProblem(role: Role, value: unknown): string | null {
  if (Array.isArray(value))
    return `${role} 要是一個程式的路徑，不能是陣列；「${role}」這個字由看板自己加上`;
  if (typeof value !== "string" || value === "") return `${role} 要是一個程式的路徑`;
  if (value.length > PATH_MAX) return `${role} 的路徑太長`;
  // Whitespace would make a path look like a program with its arguments.
  if (/[\s\p{Cc}]/u.test(value)) return `${role} 只能是程式的路徑，不能帶參數或空白`;
  return null;
}

/** The binding the text describes, or why it is not one. */
export function parseBinding(text: string): Binding | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "不是合法的 JSON";
  }
  if (!isRecord(raw) || raw["v"] !== 1) return '要是一個帶 "v": 1 的 JSON 物件';
  const extra = Object.keys(raw).filter((key) => !BINDING_KEYS.includes(key));
  if (extra.length > 0) return `只能有 v、name、feed、deliver，多了 ${extra.join("、")}`;
  const name = raw["name"];
  if (typeof name !== "string" || !NAME.test(name))
    return "name 要是 1 到 64 個英數字、.、_ 或 -，以英數字開頭";
  for (const role of ROLES) {
    const problem = pathProblem(role, raw[role]);
    if (problem !== null) return problem;
  }
  return { name, feed: raw["feed"] as string, deliver: raw["deliver"] as string };
}

/** The binding's bytes; null when there is no file. */
function bindingBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Why the binding file itself may not be trusted, or null. */
function bindingFileProblem(file: string, uid: number): string | null {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return "是符號連結";
  if (!stat.isFile()) return "不是一般檔案";
  if (stat.uid !== uid) return `擁有者不是執行看板的帳號（uid ${uid}）`;
  if ((stat.mode & 0o002) !== 0) return `別的帳號也能寫（權限 ${modeText(stat.mode)}）`;
  if (stat.size > BINDING_MAX_BYTES) return `超過 ${BINDING_MAX_BYTES} 位元組`;
  return null;
}

/** Reads and checks the binding file as it is now. */
export function readBinding(file: string, uid: number): BindingRead {
  let bytes: Buffer | null;
  let problem: string | null;
  try {
    bytes = bindingBytes(file);
    problem = bytes === null ? null : bindingFileProblem(file, uid);
  } catch (error) {
    return { kind: "invalid", reason: `讀不到（${(error as Error).message}）`, sha256: null };
  }
  if (bytes === null) return { kind: "absent" };
  const sha256 = sha256Of(bytes);
  if (problem !== null) return { kind: "invalid", reason: problem, sha256 };
  // An empty file is how a home turns the board's programs off for good.
  if (bytes.toString("utf8").trim() === "")
    return { kind: "invalid", reason: "是空的，看板不執行任何程式", sha256 };
  const parsed = parseBinding(bytes.toString("utf8"));
  return typeof parsed === "string"
    ? { kind: "invalid", reason: parsed, sha256 }
    : { kind: "ok", binding: parsed, sha256 };
}

/**
 * The binding's paths that could run without a confirmation: relative ones
 * under bin/, written plainly. Whether git tracks them unmodified is for
 * myshape.sh to say, when it starts the service.
 */
export function exemptCandidates(binding: Binding): string[] {
  return [...new Set([binding.feed, binding.deliver])].filter((value) =>
    EXEMPT_CANDIDATE.test(value),
  );
}

/** "0775"-style text of a file mode's permission bits. */
export function modeText(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** What the board learned about one program at one check. */
export type ProgramCheck =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string; confirm: { sha256: string } | null };

/** What a check needs to know besides the program. */
export interface CheckInput {
  root: string;
  uid: number;
  /** Whether myshape.sh found this binding path tracked and unmodified when it started the service. */
  exempt: (written: string) => boolean;
  /** Whether the page confirmed these bytes of this program under this binding. */
  confirmed: (program: string, sha256: string) => boolean;
}

/** The checks every program must pass, exempt or not; the reason, or null. */
function fileProblem(program: string, stat: fs.Stats, uid: number): string | null {
  if (stat.isSymbolicLink()) return `${program} 是符號連結，看板不執行符號連結`;
  if (!stat.isFile()) return `${program} 不是一般檔案`;
  if ((stat.mode & 0o111) === 0) return `${program} 不能執行（權限 ${modeText(stat.mode)}）`;
  if (stat.uid !== uid) return `${program} 的擁有者不是執行看板的帳號（uid ${uid}）`;
  if ((stat.mode & 0o002) !== 0)
    return `${program} 別的帳號也能寫（權限 ${modeText(stat.mode)}），看板不執行`;
  return null;
}

/** Checks one program of the binding as it is on disk now. */
export function checkProgram(written: string, input: CheckInput): ProgramCheck {
  const program = path.isAbsolute(written) ? written : path.join(input.root, written);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(program);
  } catch {
    return { ok: false, path: program, reason: `找不到 ${program}`, confirm: null };
  }
  const problem = fileProblem(program, stat, input.uid);
  if (problem !== null) return { ok: false, path: program, reason: problem, confirm: null };
  if (input.exempt(written)) return { ok: true, path: program };
  if ((stat.mode & 0o020) !== 0) {
    const reason =
      `${program} 的群組也能寫（權限 ${modeText(stat.mode)}）；需要確認的程式不能讓群組寫，` +
      `確認了也不執行。要用它，只改這一個檔：chmod g-w ${program}`;
    return { ok: false, path: program, reason, confirm: null };
  }
  let sha256: string;
  try {
    sha256 = sha256Of(fs.readFileSync(program));
  } catch (error) {
    return {
      ok: false,
      path: program,
      reason: `讀不到 ${program}（${(error as Error).message}）`,
      confirm: null,
    };
  }
  if (input.confirmed(program, sha256)) return { ok: true, path: program };
  return {
    ok: false,
    path: program,
    reason: `${program} 要先在頁面上確認才會執行`,
    confirm: { sha256 },
  };
}

/** Why a role cannot run under this read of the binding, or the program it runs. */
export type RoleCheck =
  | { kind: "binding"; reason: string }
  | { kind: "program"; check: ProgramCheck };

export function checkRole(read: BindingRead, role: Role, input: CheckInput): RoleCheck {
  if (read.kind === "absent") return { kind: "binding", reason: `沒有 ${BINDING_SHOWN}` };
  if (read.kind === "invalid")
    return { kind: "binding", reason: `${BINDING_SHOWN} 不能用：${read.reason}` };
  return { kind: "program", check: checkProgram(read.binding[role], input) };
}

/** The reason a role cannot run, or null when its program may run. */
export function roleReason(check: RoleCheck): string | null {
  if (check.kind === "binding") return check.reason;
  return check.check.ok ? null : check.check.reason;
}
