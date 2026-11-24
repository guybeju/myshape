export function emptyConfirmations() {
    return { v: 1, entries: [] };
}
const SHA = /^[0-9a-f]{64}$/;
export function isConfirmed(store, program, sha256, bindingSha256) {
    return store.entries.some((entry) => entry.path === program && entry.sha256 === sha256 && entry.binding_sha256 === bindingSha256);
}
/** Records the captain's confirmation of one program's bytes under one binding. */
export function confirmProgram(store, input, now) {
    if (!input.path.startsWith("/") || !SHA.test(input.sha256) || !SHA.test(input.binding_sha256))
        return { ok: false, code: "usage", line: "確認需要程式的完整路徑與兩個 SHA-256。" };
    if (isConfirmed(store, input.path, input.sha256, input.binding_sha256))
        return { ok: true, changed: false, store, line: `ok 已經確認過 ${input.path}` };
    const entry = {
        path: input.path,
        sha256: input.sha256,
        binding_sha256: input.binding_sha256,
        at: now,
    };
    const next = {
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
