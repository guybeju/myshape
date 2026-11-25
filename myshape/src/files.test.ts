import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPidFile } from "./files.js";

let dir: string;
let pidFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-files-"));
  pidFile = path.join(dir, "pid");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readPidFile", () => {
  it("returns the stored pid", () => {
    fs.writeFileSync(pidFile, "4242\n");
    expect(readPidFile(pidFile)).toBe(4242);
  });

  it("returns null when the file is missing", () => {
    expect(readPidFile(pidFile)).toBeNull();
  });

  it("returns null when the contents are not a positive integer", () => {
    fs.writeFileSync(pidFile, "not a pid\n");
    expect(readPidFile(pidFile)).toBeNull();
  });

  it("returns null when the file is deleted between the existence check and the read", () => {
    fs.writeFileSync(pidFile, "4242\n");
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof read>) => {
      fs.rmSync(pidFile);
      return read(...args);
    });
    expect(readPidFile(pidFile)).toBeNull();
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("throws a read error other than a missing file", () => {
    fs.mkdirSync(pidFile);
    expect(() => readPidFile(pidFile)).toThrow(expect.objectContaining({ code: "EISDIR" }));
  });
});
