// The one name besides 127.0.0.1 the browser may reach the board by: the PC's
// full ts.net name, which `tailscale serve` on the PC proxies to the board's
// port. It comes from the captain's config/myshape-remote.json, read once when
// the service starts. No file means only the PC's own names; a file the board
// cannot read never widens anything.
import fs from "node:fs";
import { isRecord } from "./files.js";
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const TS_NET_HOST = new RegExp(`^${LABEL}\\.${LABEL}\\.ts\\.net$`);
// tailscaled sends an ASCII login as is and encodes any other (RFC 2047), so
// only an ASCII login can ever be compared byte for byte.
const LOGIN = /^[!-~]+$/;
const SHAPE = '{"host":"<電腦>.<tailnet>.ts.net","login":"<你的 Tailscale 登入>"}';
function readText(file) {
    try {
        return fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
function parse(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return { kind: "broken", reason: `不是 JSON，要寫成 ${SHAPE}` };
    }
    if (!isRecord(value))
        return { kind: "broken", reason: `不是一個 JSON 物件，要寫成 ${SHAPE}` };
    const keys = Object.keys(value).toSorted().join(",");
    const { host, login } = value;
    if (keys !== "host,login" || typeof host !== "string" || typeof login !== "string") {
        return { kind: "broken", reason: `只能有 host 與 login 兩個文字欄位：${SHAPE}` };
    }
    if (!TS_NET_HOST.test(host)) {
        return {
            kind: "broken",
            reason: "host 要是一個完整的小寫名稱 <電腦>.<tailnet>.ts.net，不帶 https://、埠號或萬用字元",
        };
    }
    if (!LOGIN.test(login)) {
        return {
            kind: "broken",
            reason: "login 要是不含空白的 ASCII 文字，和 Tailscale 顯示的登入一樣",
        };
    }
    return { kind: "on", access: { host, login } };
}
/** Reads the settings file; an absent, empty or blank file is off. */
export function readRemoteSetting(file) {
    let text;
    try {
        text = readText(file);
    }
    catch (error) {
        return { kind: "broken", reason: `讀不到（${error.message}）` };
    }
    return text === null || text.trim() === "" ? { kind: "off" } : parse(text);
}
/** The remote access the service allows, after saying in `log` what it read. */
export function remoteAccess(file, log) {
    const setting = readRemoteSetting(file);
    if (setting.kind === "off")
        return null;
    if (setting.kind === "broken") {
        log(`remote access off: ${file} ${setting.reason}`);
        return null;
    }
    log(`remote access on for ${setting.access.host}`);
    return setting.access;
}
