import { h } from "./dom.js";
import { draftInput, recentCard, settingsTable, topicLink } from "./parts.js";
import { FORM_DAYS, STATE_LABEL, enableLabel, flipDay, formBody, formDays, formHints, lastMissed, lockLabel, liveNow, nextLine, outcomeLabel, rtHint, scheduleOn, settingWords, silentReason, } from "./schedules.js";
import { agentName } from "./state.js";
function rtPill(rt) {
    return rt === "none" ? null : h("span", { class: `pill rt ${rt}` }, rt);
}
function rtNote(rt) {
    const hint = rtHint(rt, agentName());
    return hint === null ? null : h("div", { class: "note" }, hint);
}
/** The captain's 這一場結束: asked once on the page, then done or skipped. */
function closeButtons(page, actions, key) {
    const ask = `close:${key}`;
    if (!page.open.has(ask))
        return h("div", { class: "btns" }, h("button", { onclick: () => actions.toggle(ask) }, "這一場結束…"));
    const close = (outcome) => {
        actions.toggle(ask);
        actions.send("schedules/close", { key, outcome });
    };
    return h("div", { class: "confirm" }, `結束之後這一場離開「現在」，不能再開；已經送過通知的，看板會告訴 ${agentName()} 不用準備了。`, h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => close("done") }, "標成做完"), h("button", { class: "danger", onclick: () => close("skipped") }, "標成跳過"), h("button", { onclick: () => actions.toggle(ask) }, "取消")));
}
function takenLine(entry) {
    if (entry.taken_local === null)
        return null;
    const note = entry.note === null ? "" : `：${entry.note}`;
    return h("div", {}, `${agentName()} ${entry.taken_local} 接了${note}`);
}
function nowCard(page, view, actions, entry) {
    return h("div", { class: `card occ ${entry.rt}`, "data-occurrence": entry.key }, h("div", { class: "meta" }, topicLink(view, entry.topic, actions), h("span", {}, entry.local), h("span", { class: `pill ${entry.state}` }, STATE_LABEL[entry.state]), rtPill(entry.rt)), rtNote(entry.rt), takenLine(entry), h("div", { class: "note" }, `最晚 ${entry.closes_local} 結束`), closeButtons(page, actions, entry.key));
}
/** 現在: the open occurrences above 高, only while one is open. The hashtag filter never hides it. */
export function nowStrip(page, view, actions) {
    const open = liveNow(view.schedules, Date.now());
    if (open.length === 0)
        return null;
    return h("div", { class: "now", "data-strip": "now" }, h("h3", {}, "現在"), open.map((entry) => nowCard(page, view, actions, entry)));
}
/** The marks a schedule's card carries: 新, why it is silent, a missed last one, its rt. */
function marks(view, card) {
    const silent = silentReason(card, view.schedules.settings.all_paused);
    return [
        card.new ? h("span", { class: "pill new" }, "新") : null,
        silent === null ? null : h("span", { class: "pill warn" }, silent),
        card.open === null ? null : h("span", { class: "pill" }, "這一場開著"),
        lastMissed(card) ? h("span", { class: "pill warn" }, "上一場錯過") : null,
        rtPill(card.rt),
    ];
}
/**
 * 排程: the scheduled topics `shown` lets through, under the queues. They stay
 * in 待辦; their time, not a drag, brings them into 現在.
 */
export function scheduleColumn(view, actions, shown) {
    const cards = view.schedules.series.filter((card) => shown(card.topic));
    return h("div", { class: "schedules", "data-column": "schedules" }, h("h3", {}, "排程（照時間進「現在」）"), cards.length === 0 ? h("div", { class: "note" }, "沒有排程。") : null, cards.map((card) => h("div", { class: "card", "data-schedule": card.id }, topicLink(view, card.topic, actions), h("div", { class: "note" }, nextLine(card)), h("div", { class: "meta" }, marks(view, card)))));
}
// ---------------------------------------------------------------- the line on the home page
const SETTING_LABEL = {
    lead_min: () => "提前幾分鐘送第一則（0 表示不送「快到了」）",
    duration_min: () => "時段長度：沒人接的在 T 加這麼久結束",
    max_open_min: () => `${agentName()} 接了之後最長開多久`,
    missed: () => "看板沒在跑而錯過的場次",
    late_after_min: () => "晚多久才標「晚了」",
    aggregator_may_create: () => `${agentName()} 可以建立排程`,
    aggregator_needs_enable: () => `${agentName()} 建的排程要你先按啟用`,
    first_bell_min_ahead: () => `${agentName()} 新建或改時間後，最快多久才響`,
    captain_locks_by_default: () => "你建的排程預設上鎖",
    max_active: () => `啟用中的排程最多幾筆（${agentName()} 建立時）`,
    aggregator_changes_per_hour: () => `${agentName()} 每小時最多改幾次排程`,
    aggregator_may_set_rt: () => `${agentName()} 可以設 rt`,
    default_rt: () => "新排程的 rt",
    default_tz: () => "新排程的時區",
};
function choiceControl(view, name, apply) {
    const choices = name === "missed"
        ? view.schedules.missed_modes.map((mode) => [mode, settingWords("missed", mode)])
        : view.schedules.rt_values.map((rt) => [rt, rt]);
    const current = view.schedules.settings[name];
    return h("select", { class: "auto", onchange: (event) => apply(event.target.value) }, choices.map(([value, words]) => h("option", { value, ...(value === current ? { selected: true } : {}) }, words)));
}
function typedControl(page, actions, name, hint, apply) {
    const key = `schedule-setting:${name}`;
    const save = () => {
        const typed = (page.drafts.get(key) ?? "").trim();
        if (typed === "")
            return;
        apply(name === "default_tz" ? typed : Number(typed));
        actions.draft(key, "");
    };
    return [draftInput(page, actions, key, hint, save), h("button", { onclick: save }, "改")];
}
function settingControl(page, view, actions, name) {
    const current = view.schedules.settings[name];
    const apply = (value) => actions.send("schedules/settings", { [name]: value });
    if (typeof current === "boolean")
        return h("button", { onclick: () => apply(!current) }, `改成${settingWords(name, !current)}`);
    if (name === "missed" || name === "default_rt")
        return choiceControl(view, name, apply);
    if (name === "default_tz")
        return [
            typedControl(page, actions, name, "例如 Asia/Taipei", apply),
            current === null ? null : h("button", { onclick: () => apply(null) }, "用這台機器的"),
        ];
    const range = view.schedules.ranges[name];
    return typedControl(page, actions, name, `${range[0]} 到 ${range[1]}`, apply);
}
function settingsPanel(page, view, actions) {
    const { settings, defaults } = view.schedules;
    const names = Object.keys(SETTING_LABEL);
    const rows = names.map((name) => ({
        label: SETTING_LABEL[name](),
        current: settingWords(name, settings[name]),
        fallback: settingWords(name, defaults[name]),
        control: settingControl(page, view, actions, name),
    }));
    return h("div", { class: "card" }, h("h3", {}, "排程設定"), h("p", { class: "note" }, `排程只決定議題什麼時候顯示在「現在」、什麼時候通知 ${agentName()}，不改佇列、順序或派工。這裡的設定管 ${agentName()} 能做什麼與預設值；你在頁面上建、改的不受上限和「最快多久才響」管。`), h("p", { class: "note" }, "同一筆排程不能同時開著兩場：提前分鐘數加上時段長度與「接了之後最長開多久」較長的那個，不能超過它兩場之間最短的間隔（每天的排程是 22 小時）。改了會違反的，看板會拒絕並說是哪一筆。"), settingsTable(rows));
}
function recentButton(page, view, actions) {
    const count = view.schedules.recent.length;
    if (count === 0)
        return null;
    const toggle = () => actions.setSchedulePanel(page.schedulePanel === "recent" ? null : "recent");
    return h("button", { class: "link", onclick: toggle }, `${agentName()} 最近改了 ${count} 筆排程`);
}
function pauseAll(view, actions) {
    const paused = view.schedules.settings.all_paused;
    return [
        paused ? h("span", { class: "pill warn" }, "所有排程暫停中：不開新時段、不送排程通知") : null,
        h("button", { onclick: () => actions.send("schedules/pause-all", { paused: !paused }) }, paused ? "全部恢復" : "全部暫停"),
    ];
}
function barPanel(page, view, actions) {
    if (page.schedulePanel === "settings")
        return settingsPanel(page, view, actions);
    if (page.schedulePanel !== "recent")
        return null;
    return recentCard(view, actions, {
        title: `${agentName()} 最近的排程改動`,
        changes: view.schedules.recent,
        revert: "schedules/revert",
        seen: "schedules/seen",
    });
}
/** The line under the filter bar: the agent's recent schedule changes, the settings, pausing everything. */
export function scheduleBar(page, view, actions) {
    const settings = () => actions.setSchedulePanel(page.schedulePanel === "settings" ? null : "settings");
    return h("section", { class: "filterbar", "data-bar": "schedules" }, h("div", { class: "btns" }, recentButton(page, view, actions), h("button", { class: "link", onclick: settings }, "排程設定"), pauseAll(view, actions)), barPanel(page, view, actions));
}
// ---------------------------------------------------------------- a topic's page
function dayBoxes(page, actions, id, card) {
    const ticked = formDays(page.drafts, id, card);
    const flip = (day) => actions.draft(`schedule-days:${id}`, flipDay(formDays(page.drafts, id, card), day).join(","));
    return h("span", {}, "星期（都不勾就是每天）：", FORM_DAYS.map(([day, word]) => h("label", {}, h("input", {
        type: "checkbox",
        ...(ticked.includes(day) ? { checked: true } : {}),
        onchange: () => flip(day),
    }), word)));
}
function clearForm(page, actions, id) {
    for (const field of ["days", "at", "tz", "lead", "duration", "rt"])
        page.drafts.delete(`schedule-${field}:${id}`);
    actions.toggle(`schedule-form:${id}`);
}
function rtChoice(values, current, choose, blank) {
    return h("select", { class: "auto", onchange: (event) => choose(event.target.value) }, blank === null ? null : h("option", { value: "" }, blank), values.map((rt) => h("option", { value: rt, ...(rt === current ? { selected: true } : {}) }, rt)));
}
/** The rt a new schedule starts with; an existing one has its own control. */
function newRt(view, actions, id) {
    return rtChoice(view.schedules.rt_values, null, (rt) => actions.draft(`schedule-rt:${id}`, rt), `rt（${view.schedules.settings.default_rt}）`);
}
function scheduleForm(page, view, actions, id) {
    const card = scheduleOn(view.schedules, id);
    const hints = formHints(card, view.schedules.settings);
    const input = (field) => draftInput(page, actions, `schedule-${field}:${id}`, hints[field]);
    const save = () => {
        actions.send(`schedules/${card === undefined ? "add" : "edit"}`, formBody(page.drafts, id, card));
        clearForm(page, actions, id);
    };
    return h("div", { class: "card" }, h("div", { class: "btns" }, dayBoxes(page, actions, id, card)), h("div", { class: "btns" }, input("at"), input("tz")), h("div", { class: "btns" }, input("lead"), input("duration"), card === undefined ? newRt(view, actions, id) : null), h("div", { class: "btns" }, h("button", { class: "primary", onclick: save }, hints.save), h("button", { onclick: () => clearForm(page, actions, id) }, "取消")));
}
function lockButton(actions, card, lock) {
    const locked = lock === "schedule" ? card.locked : card.rt_locked;
    const toggle = () => actions.send("schedules/lock", { topic: card.topic, lock, locked: !locked });
    return h("button", { onclick: toggle }, lockLabel(lock, locked, agentName()));
}
/** 啟用 is the seen mark (schedule-seen), so its words say it enables every waiting schedule. */
function enableButton(view, actions, card) {
    if (!card.awaiting_enable)
        return null;
    const waiting = view.schedules.series.filter((entry) => entry.awaiting_enable).length;
    return h("button", { class: "primary", onclick: () => actions.send("schedules/seen", {}) }, enableLabel(waiting, agentName()));
}
function deleteControl(page, actions, card) {
    const key = `schedule-delete:${card.topic}`;
    if (!page.pending.has(key))
        return h("button", {
            class: "danger",
            onclick: () => actions.ask(key, "schedules/delete", { topic: card.topic }),
        }, "刪掉排程…");
    return h("div", { class: "confirm" }, "刪掉之後，你在頁面上不能撤回；開著的那一場會結束。議題變回一般的議題，留在「待辦」，之後可以照常移動。", h("div", { class: "btns" }, h("button", { class: "danger", onclick: () => actions.confirm(key) }, "刪掉"), h("button", { onclick: () => actions.cancel(key) }, "取消")));
}
function controls(page, view, actions, card) {
    const topic = card.topic;
    const paused = card.state === "paused";
    return h("div", { class: "btns" }, enableButton(view, actions, card), h("button", { onclick: () => actions.send(paused ? "schedules/resume" : "schedules/pause", { topic }) }, paused ? "恢復" : "暫停"), h("button", { onclick: () => actions.send("schedules/skip", { topic }) }, "跳過下一場"), rtChoice(view.schedules.rt_values, card.rt, (rt) => actions.send("schedules/rt", { topic, rt }), null), lockButton(actions, card, "schedule"), lockButton(actions, card, "rt"), h("button", { onclick: () => actions.toggle(`schedule-form:${topic}`) }, "改時間…"), deleteControl(page, actions, card));
}
function whose(value) {
    return value === null ? "（用設定的值）" : "（這筆自己的）";
}
function minutesLine(card) {
    return `提前 ${card.lead} 分送「快到了」${whose(card.lead_min)}，時段 ${card.duration} 分${whose(card.duration_min)}`;
}
/** The last ten, one cell each: when, how it ended, and the line the aggregator wrote. */
function recordStrip(card) {
    if (card.strip.length === 0)
        return h("p", { class: "note" }, "還沒有結束過的場次。");
    return h("div", { class: "strip" }, card.strip.map((cell) => h("div", { class: `cell ${cell.outcome}`, title: cell.key }, h("div", { class: "t" }, cell.local), h("div", {}, outcomeLabel(cell)), cell.note === null ? null : h("div", { class: "note" }, cell.note))));
}
function scheduleDetails(page, view, actions, card) {
    const open = view.schedules.now.find((entry) => entry.key === card.open);
    return [
        h("div", { class: "meta" }, h("b", {}, card.rule_text), h("span", {}, card.tz), marks(view, card), card.by === "aggregator" ? h("span", { class: "note" }, `${agentName()} 建的`) : null),
        rtNote(card.rt),
        h("div", { class: "note" }, `接下來：${card.next.map((entry) => entry.local).join("、")}`),
        h("div", { class: "note" }, minutesLine(card)),
        open === undefined ? null : nowCard(page, view, actions, open),
        controls(page, view, actions, card),
        page.open.has(`schedule-form:${card.topic}`)
            ? scheduleForm(page, view, actions, card.topic)
            : null,
        h("h3", {}, "最近十場"),
        recordStrip(card),
    ];
}
/** A topic's schedule section: its schedule, or the way to add one to a topic in 待辦. */
export function topicSchedule(page, view, actions, id) {
    const topic = view.topics[id];
    if (topic === undefined)
        return null;
    const card = scheduleOn(view.schedules, id);
    if (card !== undefined)
        return h("section", { "data-section": "schedule" }, h("h2", {}, "排程"), scheduleDetails(page, view, actions, card));
    if (topic.status === "archived")
        return null;
    if (topic.queue !== "later")
        return h("p", { class: "note" }, "要加排程，先把議題移到「待辦」：有排程的議題留在待辦，到時間時顯示在「現在」。");
    const form = `schedule-form:${id}`;
    return h("section", { "data-section": "schedule" }, h("h2", {}, "排程"), page.open.has(form)
        ? scheduleForm(page, view, actions, id)
        : h("button", { onclick: () => actions.toggle(form) }, "加排程…"));
}
