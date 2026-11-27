// What a lookup (which, summary, find <task>) and a page write's re-read of a
// tag wait for: one task's tag file, from a read that starts after the request
// (C30). The feed's topics call answers that alone; a home whose feed has no
// such call, or whose call failed, is read in full. All the reads of one
// request share one deadline, which ends before myshape.sh stops waiting.
import { MAIN_HOME } from "./journal.js";
import { REQUEST_TIMEOUT_MS } from "./protocol.js";
import { parseTags, placeTagText, placeTask } from "./view.js";
/** Time left after a lookup's reads for the answer to reach myshape.sh. */
export const LOOKUP_MARGIN_MS = 2_000;
/** How long one request's reads may take in all. */
export const LOOKUP_WAIT_MS = REQUEST_TIMEOUT_MS - LOOKUP_MARGIN_MS;
/** The deadline of a request that arrived at `nowMs`. */
export function lookupDeadline(nowMs = Date.now()) {
    return nowMs + LOOKUP_WAIT_MS;
}
/**
 * What `start` resolves to, or `fallback` once `deadline` (epoch ms) passes.
 * Nothing is started when the deadline has already passed.
 */
export function beforeDeadline(deadline, fallback, start) {
    const left = deadline - Date.now();
    if (left <= 0)
        return Promise.resolve(fallback);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), left);
        void start().then((value) => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}
/**
 * A home's tag files that hold `task`'s, from a read that starts now: the
 * topics call's answer, or the whole home's report when the call gave none.
 * Null when neither read succeeded, or when `deadline` (epoch ms) passed
 * before the whole read could start.
 */
export async function freshTags(poller, home, task, deadline = Number.POSITIVE_INFINITY) {
    const asked = await poller.readTopics(home, [task], deadline);
    if (asked !== null)
        return asked;
    if (Date.now() >= deadline || !(await poller.readFresh(home)))
        return null;
    return poller.snapshots().find((entry) => entry.id === home)?.report?.topics ?? null;
}
/** Reads the root home when the board has never read it, so it knows the further homes. */
export async function knowHomes(poller, deadline) {
    if (!poller.hasMainReport())
        await beforeDeadline(deadline, false, () => poller.readNow(MAIN_HOME));
}
/**
 * The line the agent puts in front of a chat reminder about `task`. The tag
 * is read afresh, because nothing keeps the board current while no page is
 * open and a tag may have changed since. When no read succeeds by the
 * deadline, a tag seen earlier still answers; without one the line is
 * "議題待查", never "未分類": not knowing is not the same as knowing the task
 * has no topic. The words say the topic is still to be checked, not that a
 * lookup broke: the board may simply never have seen a tag for the task.
 */
export async function reminderPrefix(host, home, task, deadline) {
    const tags = await beforeDeadline(deadline, null, () => freshTags(host.poller, home, task, deadline));
    const topics = host.topics();
    const placement = tags === null
        ? placeTask(topics, host.poller.snapshots(), home, task)
        : placeTagText(topics, Object.hasOwn(tags, task) ? tags[task] : "");
    if (tags === null && placement.reason === "no-tag")
        return `議題待查（${task}）：`;
    if (placement.topic === null)
        return "未分類：";
    const name = topics.doc.topics[placement.topic]?.name ?? topics.archive.topics[placement.topic]?.name;
    return `${name ?? placement.topic}：`;
}
/**
 * The tag files of every task named exactly `task`, across the homes the
 * board reads: the main home's read afresh, like `which`, the others' from
 * their last read.
 */
export async function findTasks(poller, task, deadline) {
    const main = await beforeDeadline(deadline, null, () => freshTags(poller, MAIN_HOME, task, deadline));
    const found = [];
    for (const home of poller.snapshots()) {
        const tagFiles = home.id === MAIN_HOME && main !== null ? main : (home.report?.topics ?? {});
        const text = Object.hasOwn(tagFiles, task) ? tagFiles[task] : undefined;
        if (text !== undefined)
            found.push({ home: home.id, task, tags: parseTags(text) });
    }
    return found;
}
