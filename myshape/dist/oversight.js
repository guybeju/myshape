// The guard rails around the aggregator's changes to one feature the board
// keeps in its own file: an hourly cap on those changes, the captain's revert
// of one of them from its system record, and the captain's mark that says the
// changes so far were seen. Everything is read from the system records, so the
// feature's file keeps nothing for it. A feature names its own record kinds
// (Watched); nothing here knows any feature. Pure.
//
// These are guard rails against a careless or misled aggregator, not a
// boundary: the socket does not authenticate, and a deliberate program under
// the same account can write the files itself.
export const HOUR_SECONDS = 3600;
function isChange(watched, record) {
    return record.by === "aggregator" && watched.changes.has(record.kind);
}
/** How many of the aggregator's changes were saved in the hour up to `nowSeconds`. */
export function changesInLastHour(records, watched, nowSeconds) {
    return records.filter((record) => isChange(watched, record) && record.ts > nowSeconds - HOUR_SECONDS).length;
}
/**
 * Why one more change by the aggregator is refused under an hourly cap of
 * `cap`, or null when it is allowed.
 */
export function capProblem(records, watched, nowSeconds, cap) {
    const made = changesInLastHour(records, watched, nowSeconds);
    if (made < cap)
        return null;
    return `超過每小時上限：一小時內已經改了 ${made} 次，上限是 ${cap} 次。這次沒有改；要多改，請使用者在頁面上調高上限。`;
}
/** The index of the latest seen mark in `records`, or -1. */
function lastSeenIndex(records, watched) {
    return records.findLastIndex((record) => record.kind === watched.seen);
}
/** The time of the latest seen mark, epoch seconds, or null when the captain never marked. */
export function lastSeenAt(records, watched) {
    const at = lastSeenIndex(records, watched);
    return at === -1 ? null : records[at].ts;
}
/** The aggregator's changes saved after the latest seen mark, oldest first. */
export function unseenChanges(records, watched) {
    return records
        .slice(lastSeenIndex(records, watched) + 1)
        .filter((record) => isChange(watched, record));
}
/** True when a record takes back the change saved as `rid`. */
export function isReverted(records, watched, rid) {
    return records.some((record) => record.kind === watched.reverted && record.ref === rid);
}
/**
 * The aggregator's change saved as `rid`, when the captain may still take it
 * back; otherwise why not. A change already taken back is `reverted`, so a
 * second revert can say so and change nothing.
 */
export function revertable(records, watched, rid) {
    const record = records.find((entry) => entry.rid === rid);
    if (record === undefined)
        return { problem: `找不到紀錄 ${rid}。` };
    if (!isChange(watched, record))
        return { problem: `紀錄 ${rid} 不是 aggregator 做的改動，不能撤回。` };
    if (isReverted(records, watched, rid))
        return { reverted: true };
    return { record };
}
/** The aggregator's changes since the latest seen mark, newest first, as the page lists them. */
export function recentChanges(records, watched) {
    const recent = [];
    for (const record of unseenChanges(records, watched)) {
        // Every saved record has a rid; only lines from before records had one lack it.
        if (record.rid === undefined)
            continue;
        recent.unshift({
            rid: record.rid,
            ts: record.ts,
            topic: record.topic ?? null,
            text: record.text ?? "",
            reverted: isReverted(records, watched, record.rid),
        });
    }
    return recent;
}
