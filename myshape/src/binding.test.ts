import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkProgram,
  checkRole,
  exemptCandidates,
  parseBinding,
  readBinding,
  roleReason,
  sha256Of,
} from "./binding.js";
import type { CheckInput } from "./binding.js";

const UID = process.getuid?.() ?? -1;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-binding-"));
  fs.mkdirSync(path.join(dir, "bin"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function program(name: string, mode = 0o755, body = "#!/bin/sh\n"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}

function input(extra: Partial<CheckInput> = {}): CheckInput {
  return { root: dir, uid: UID, exempt: () => false, confirmed: () => false, ...extra };
}

describe("parseBinding", () => {
  const good = { v: 1, name: "plain", feed: "bin/feed", deliver: "/opt/agg/deliver" };

  it("takes a name and two paths, nothing else", () => {
    expect(parseBinding(JSON.stringify(good))).toEqual({
      name: "plain",
      feed: "bin/feed",
      deliver: "/opt/agg/deliver",
    });
  });

  it("refuses arguments, arrays, extra keys and malformed fields", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...good, feed: ["bin/feed", "feed"] }, "不能是陣列"],
      [{ ...good, deliver: "bin/x deliver" }, "不能帶參數"],
      [{ ...good, feed: "bin/x\tfeed" }, "不能帶參數"],
      [{ ...good, feed: "" }, "要是一個程式的路徑"],
      [{ ...good, root: "/elsewhere" }, "多了 root"],
      [{ ...good, args: ["x"] }, "多了 args"],
      [{ ...good, name: "-x" }, "name"],
      [{ ...good, name: "a b" }, "name"],
      [{ ...good, v: 2 }, '"v": 1'],
    ];
    for (const [raw, problem] of cases)
      expect(parseBinding(JSON.stringify(raw))).toContain(problem);
    expect(parseBinding("{")).toBe("不是合法的 JSON");
    expect(parseBinding("[]")).toContain("JSON 物件");
  });
});

describe("readBinding", () => {
  const file = (): string => path.join(dir, "binding.json");
  const text = '{"v":1,"name":"plain","feed":"bin/feed","deliver":"bin/feed"}\n';

  it("is absent without a file, and carries the bytes' SHA-256 otherwise", () => {
    expect(readBinding(file(), UID)).toEqual({ kind: "absent" });
    fs.writeFileSync(file(), text, { mode: 0o644 });
    expect(readBinding(file(), UID)).toEqual({
      kind: "ok",
      binding: { name: "plain", feed: "bin/feed", deliver: "bin/feed" },
      sha256: sha256Of(text),
    });
  });

  it("refuses a symlink, another owner and a file others may write", () => {
    fs.writeFileSync(path.join(dir, "real.json"), text);
    fs.symlinkSync(path.join(dir, "real.json"), file());
    expect(readBinding(file(), UID)).toMatchObject({ kind: "invalid", reason: "是符號連結" });
    fs.rmSync(file());
    fs.writeFileSync(file(), text);
    fs.chmodSync(file(), 0o646);
    expect(readBinding(file(), UID)).toMatchObject({
      kind: "invalid",
      reason: "別的帳號也能寫（權限 0646）",
    });
    fs.chmodSync(file(), 0o664);
    expect(readBinding(file(), UID).kind).toBe("ok");
    expect(readBinding(file(), UID + 1)).toMatchObject({ kind: "invalid" });
  });

  it("reads an empty file as a binding that runs nothing", () => {
    fs.writeFileSync(file(), "");
    expect(roleReason(checkRole(readBinding(file(), UID), "deliver", input()))).toBe(
      "config/myshape-aggregator.json 不能用：是空的，看板不執行任何程式",
    );
  });

  it("names what is wrong with the content", () => {
    fs.writeFileSync(file(), '{"v":1,"name":"plain","feed":["bin/feed"],"deliver":"bin/feed"}');
    expect(checkRole(readBinding(file(), UID), "feed", input())).toEqual({
      kind: "binding",
      reason:
        "config/myshape-aggregator.json 不能用：feed 要是一個程式的路徑，不能是陣列；「feed」這個字由看板自己加上",
    });
    expect(roleReason(checkRole({ kind: "absent" }, "deliver", input()))).toBe(
      "沒有 config/myshape-aggregator.json",
    );
  });
});

describe("exemptCandidates", () => {
  it("are relative paths under bin/, written plainly, each once", () => {
    const binding = (feed: string, deliver: string) => ({ name: "n", feed, deliver });
    expect(exemptCandidates(binding("bin/fm-board.sh", "bin/fm-board.sh"))).toEqual([
      "bin/fm-board.sh",
    ]);
    expect(exemptCandidates(binding("bin/a/b.sh", "/abs/bin/x"))).toEqual(["bin/a/b.sh"]);
    for (const odd of ["bin/../x", "bin/./x", "./bin/x", "bin//x", "state/bin/x", "bin/", "bin/.x"])
      expect(exemptCandidates(binding(odd, odd))).toEqual([]);
  });
});

describe("checkProgram", () => {
  it("runs a confirmed program only while its bytes are the confirmed ones", () => {
    const file = program("bin/plain");
    const sha = sha256Of(fs.readFileSync(file));
    const confirmed = (at: string, hash: string): boolean => at === file && hash === sha;
    expect(checkProgram("bin/plain", input({ confirmed }))).toEqual({ ok: true, path: file });
    const mtime = fs.statSync(file).mtime;
    fs.writeFileSync(file, "#!/bin/sx\n");
    fs.utimesSync(file, mtime, mtime);
    expect(checkProgram("bin/plain", input({ confirmed }))).toEqual({
      ok: false,
      path: file,
      reason: `${file} 要先在頁面上確認才會執行`,
      confirm: { sha256: sha256Of("#!/bin/sx\n") },
    });
  });

  it("refuses what no confirmation can allow, naming the file", () => {
    program("bin/real");
    fs.symlinkSync(path.join(dir, "bin/real"), path.join(dir, "bin/link"));
    fs.mkdirSync(path.join(dir, "bin/dir"));
    program("bin/plain-text", 0o644);
    program("bin/world", 0o757);
    const reason = (written: string) => {
      const check = checkProgram(written, input({ exempt: () => true }));
      return check.ok ? null : [check.reason, check.confirm];
    };
    const at = (name: string) => path.join(dir, name);
    expect(reason("bin/missing")).toEqual([`找不到 ${at("bin/missing")}`, null]);
    expect(reason("bin/link")).toEqual([`${at("bin/link")} 是符號連結，看板不執行符號連結`, null]);
    expect(reason("bin/dir")).toEqual([`${at("bin/dir")} 不是一般檔案`, null]);
    expect(reason("bin/plain-text")).toEqual([
      `${at("bin/plain-text")} 不能執行（權限 0644）`,
      null,
    ]);
    expect(reason("bin/world")).toEqual([
      `${at("bin/world")} 別的帳號也能寫（權限 0757），看板不執行`,
      null,
    ]);
  });

  it("runs an exempt program that its group may write, and refuses one that is not exempt", () => {
    const file = program("bin/fm-board.sh", 0o775);
    expect(checkProgram("bin/fm-board.sh", input({ exempt: () => true }))).toEqual({
      ok: true,
      path: file,
    });
    const refused = checkProgram("bin/fm-board.sh", input({ confirmed: () => true }));
    expect(refused).toEqual({
      ok: false,
      path: file,
      reason: `${file} 的群組也能寫（權限 0775）；需要確認的程式不能讓群組寫，確認了也不執行。要用它，只改這一個檔：chmod g-w ${file}`,
      confirm: null,
    });
  });

  it("resolves a relative path against the code root and uses an absolute one as written", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tb-outside-"));
    const file = path.join(outside, "deliver");
    fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    expect(checkProgram(file, input({ confirmed: () => true }))).toEqual({ ok: true, path: file });
    expect(checkProgram("bin/x", input()).path).toBe(path.join(dir, "bin/x"));
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
