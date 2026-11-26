// The supervisor (plan section 4): it plans topics into tasks, starts at most
// two sessions at once (one per topic), runs each worker in its own git
// worktree outside the board home, writes the agent's state files and the
// ledger, writes summaries through the board's command, cleans worktrees up,
// and stops dispatching while the quota or rate limit says so. It takes the
// captain's actions from inbox/ (messages, directs, answers, 要你動手 notices),
// opens holds for workers' questions, keeps workers' 要你動手 items on the
// board, and proposes closing a topic whose tasks have all landed. For the
// board's schedules it takes an occurrence, keeps a place free for it, starts
// its work at its time, closes it when the work ends, and answers a missed one
// by its rt (schedule-step.ts, occurrences.ts). It is the only writer of the
// agent's state and the only one that runs the board's command; workers never
// write the board.

import { createHash } from "node:crypto";
import { join } from "node:path";

import type { HoldEntry, TaskEntry } from "#agg/state-files.js";

import {
  readBoard,
  readTodos,
  type Board,
  type SchedulesFile,
  type TodoItem,
} from "./board-files.js";
import {
  BoardCommand,
  Git,
  pullRequestState,
  type PlainEnv,
  type RunCommand,
  type SummaryKind,
} from "./commands.js";
import { dispatchOrder, followMerges, topicEntry, type OrderEntry } from "./dispatch-order.js";
import {
  endingOf,
  TEXT,
  TEXT_PREFIX,
  type EndTodos,
  type Ending,
  type HoldRequest,
} from "./ending.js";
import { parseInboxFile, sortInbox, type InboxItem, type Sorted } from "./inbox.js";
import { closeReason } from "./landing.js";
import {
  NOTE,
  occurrencePhase,
  scheduleWork,
  workId,
  workOf,
  type OccurrencePhase,
  type ScheduleWork,
  type WorkRef,
} from "./occurrences.js";
import { parsePlannerOutput, type PlannedWork, type Todo } from "./outputs.js";
import {
  livePrompt,
  plannerPrompt,
  resumePrompt,
  workerPrompt,
  type ResumeInput,
} from "./prompts.js";
import { ScheduleStep, type MakeUp } from "./schedule-step.js";
import { schedule, type Candidate, type Slot, type TopicStatus } from "./scheduler.js";
import type { QueryFn } from "./sdk.js";
import { followSession, PromptStream, type SessionReport } from "./session.js";
import { plannerOptions, workerOptions, type SessionContext } from "./session-options.js";
import { checkSettings, takeLock, type RepoSetting, type Settings } from "./settings.js";
import { StateStore, type PlannedTask } from "./state-store.js";
import { boardTodos, todoOps, type TodoOp } from "./todos.js";
import { redactor } from "./token.js";

export interface Deps {
  query: QueryFn;
  run: RunCommand;
  /** The subscription token, handed to sessions only. */
  token: string;
  env: PlainEnv;
  nowMs: () => number;
  log: (line: string) => void;
  realPath: (path: string) => string;
  pid: number;
  isAlive: (pid: number) => boolean;
}

export const DETAIL = {
  preparing: "準備 worktree",
  started: "worker 在做",
  restarted: "supervisor 重啟時這個 worker 已經不在了，等 captain 決定接著做或結束",
  resumed: "額度恢復，接著做",
  unpushed: "worktree 還有沒推的提交",
  dirty: (reason: string) => `worktree 沒有刪掉：${reason}`,
  noWorktree: (reason: string) => `建不出 worktree：${reason}`,
  noSession: "沒有可以接回的 session",
  merged: "已合併",
  closed: "PR 關掉了，沒有合併",
  answered: (label: string) => `接著做：captain 回答了「${label}」`,
  directed: "接著做：captain 直送了話",
  verifying: "回來確認 captain 做完的要你動手的事",
} as const;

export const QUOTA_HOLD = {
  title: "額度用盡或被限流",
  resumeNow: "現在恢復",
  question: (until: string) =>
    [
      "訂閱額度用盡或被限流，supervisor 暫停派新的 worker；在跑的不停，這個 task 停在原地。",
      `預計 ${until} 自動恢復派工。要現在就恢復，選「現在恢復」。`,
      "選項：現在恢復 | 等它自己恢復",
    ].join("\n"),
};

/** How long dispatching waits when the quota signal gives no time it clears. */
export const QUOTA_WAIT_MS = 30 * 60 * 1000;

const PLAN_PREFIX = "plan:";

function planId(topic: string): string {
  return `${PLAN_PREFIX}${topic}`;
}

const NOTHING_SORTED: Sorted = {
  retire: [],
  close: [],
  push: [],
  messages: new Map(),
  inputs: new Map(),
  schedule: [],
};

const NO_SCHEDULES: SchedulesFile = { series: new Map(), occurrences: new Map() };

const PHASE_STATUS: Readonly<Record<OccurrencePhase, TopicStatus>> = {
  due: "dispatchable",
  notYet: "notYet",
  silent: "silent",
  ended: "gone",
};

/** What a planner plans for: an occurrence's work, a make-up, or the topic's ordinary work. */
interface PlanFor {
  ref: WorkRef;
  /** The missed notice a make-up answers, retired once the planner has run. */
  makeUp: MakeUp | undefined;
}

/** A resume: what the captain did, and the inbox files it consumes. */
interface Resume {
  input: ResumeInput;
  detail: string;
  files: InboxItem[];
  /** The write id of the answer to the task's hold, when an answer resumes it. */
  answerId: string | undefined;
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface Quota {
  untilMs: number;
  /** The task whose hold says so, or null when no task carries it (the planner hit it). */
  hold: string | null;
}

export class Supervisor {
  private readonly settings: Settings;
  private readonly deps: Deps;
  private readonly store: StateStore;
  private readonly board: BoardCommand;
  private readonly git: Git;
  private readonly redact: (text: string) => string;
  private readonly release: () => void;
  private tasks = new Map<string, TaskEntry>();
  private holds = new Map<string, HoldEntry>();
  private queued: PlannedTask[] = [];
  private readonly live = new Map<
    string,
    { topic: string; occurrence?: string; done: Promise<void> }
  >();
  private readonly planned = new Set<string>();
  private quota: Quota | null = null;
  /** The inbox as this pass sorted it. */
  private sorted: Sorted = NOTHING_SORTED;
  /** The streaming input of each running worker session. */
  private readonly streams = new Map<string, PromptStream>();
  /** Inbox files pushed into a running session and not taken yet, with the task. */
  private readonly pushed = new Map<string, string>();
  /**
   * Message files already handed to a planner this run. A planner is given
   * each message once, so a message whose file could not be moved never
   * starts the planner again and again.
   */
  private readonly offered = new Set<string>();
  /** The board's 要你動手 items as this pass read them. */
  private todoItems: ReadonlyMap<string, TodoItem> = new Map();
  /** The board's merges as the last pass read them. */
  private merged: ReadonlyMap<string, string> = new Map();
  /** The board's live and archived topics as the last pass read them. */
  private boardNow: Pick<Board, "topics" | "archived"> | undefined;
  /** The board's schedules as the last pass read them. */
  private schedules: SchedulesFile = NO_SCHEDULES;
  private readonly step: ScheduleStep;
  /** Occurrences whose planner planned nothing, or gave no usable plan, this run. */
  private readonly plannedFor = new Map<string, "nothing" | "failed">();
  /** Missed soft-rt occurrences waiting for their planner this pass, by topic. */
  private makeUps: ReadonlyMap<string, MakeUp> = new Map();

  private constructor(settings: Settings, deps: Deps, release: () => void) {
    this.settings = settings;
    this.deps = deps;
    this.release = release;
    this.redact = redactor(deps.token);
    this.store = new StateStore(join(settings.home, "agg"), this.redact, () =>
      Math.floor(deps.nowMs() / 1000),
    );
    this.board = new BoardCommand(deps.run, settings.boardCommand, settings.home, deps.env);
    this.git = new Git(deps.run, deps.env);
    this.step = new ScheduleStep({
      board: this.board,
      store: this.store,
      log: (line) => this.log(line),
      nowMs: deps.nowMs,
      current: (topic) => this.current(topic),
      live: (topic) => this.liveTopic(topic),
      ids: () => [...this.tasks.keys(), ...this.queued.map((entry) => entry.id)],
    });
  }

  /** Checks the settings, takes the lock, sets the home up, starts the board, and reconciles. */
  static async start(settings: Settings, deps: Deps): Promise<Supervisor> {
    if (deps.token === "") throw new Error("claude-agg: no subscription token; nothing starts");
    const checked = checkSettings(settings, deps.realPath);
    const release = takeLock(checked.worktreeRoot, deps.pid, deps.isAlive);
    const supervisor = new Supervisor(checked, deps, release);
    try {
      supervisor.store.setUp();
      const problem = await supervisor.board.ensureRunning();
      if (problem !== undefined) supervisor.log(`the board is not running: ${problem}`);
      await supervisor.reconcile();
    } catch (error) {
      release();
      throw error;
    }
    return supervisor;
  }

  log(line: string): void {
    this.deps.log(this.redact(line));
  }

  /** Gives the lock back. Sessions still running keep running until they end. */
  close(): void {
    this.release();
  }

  /** Resolves once no session runs and none is left to start. */
  async idle(): Promise<void> {
    while (this.live.size > 0) {
      await Promise.all([...this.live.values()].map((entry) => entry.done));
    }
  }

  /** What the supervisor's state says now: for tests and the captain's view. */
  snapshot(): { tasks: Map<string, TaskEntry>; queued: PlannedTask[]; running: Slot[] } {
    const running = [...this.live].map(([id, entry]) => ({ id, topic: entry.topic }));
    return { tasks: new Map(this.tasks), queued: [...this.queued], running };
  }

  private saveTasks(): void {
    this.store.writeTasks(this.tasks);
  }

  private task(id: string): TaskEntry {
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error(`no task ${id} in tasks.json`);
    return task;
  }

  private setState(id: string, state: TaskEntry["state"], text: string): void {
    const task = this.task(id);
    task.state = state;
    task.detail = this.redact(text);
    this.saveTasks();
    this.store.appendLedger({ event: "task.status", task: id, state, text: task.detail });
  }

  // --- start -----------------------------------------------------------------

  private async reconcile(): Promise<void> {
    this.tasks = this.store.readTasks();
    this.holds = this.store.readHolds();
    this.queued = this.store.readQueued().filter((entry) => !this.tasks.has(entry.id));
    for (const [id, task] of this.tasks) {
      if (task.state === "working") this.setState(id, "paused", DETAIL.restarted);
    }
    await this.reconcileWorktrees();
    for (const [id, task] of this.tasks) {
      const ended = task.state === "failed" || (task.state === "done" && !task.pr_url);
      if (ended && task.worktree !== undefined) await this.cleanUp(id);
    }
    this.quota = this.openQuotaStop();
    this.saveTasks();
    this.store.writeQueued(this.queued);
  }

  /** The quota stop an open quota hold of the last run still says, or null. */
  private openQuotaStop(): Quota | null {
    for (const [id, hold] of this.holds) {
      if (hold.state !== "open" || hold.title !== QUOTA_HOLD.title) continue;
      const until = Date.parse(hold.hold_until ?? "");
      return { untilMs: Number.isNaN(until) ? this.deps.nowMs() + QUOTA_WAIT_MS : until, hold: id };
    }
    return null;
  }

  /** Every worktree git lists in the settings' repositories, or undefined when a list fails. */
  private async listedWorktrees(): Promise<Set<string> | undefined> {
    const listed = new Set<string>();
    for (const repo of Object.values(this.settings.repos)) {
      const paths = await this.git.worktrees(repo.path);
      if (paths === undefined) {
        this.log(`git worktree list failed in ${repo.path}; worktrees are left as they are`);
        return undefined;
      }
      for (const path of paths) listed.add(path);
    }
    return listed;
  }

  private async reconcileWorktrees(): Promise<void> {
    const listed = await this.listedWorktrees();
    if (listed === undefined) return;
    const known = new Set<string>();
    for (const [id, task] of this.tasks) {
      if (task.worktree === undefined) continue;
      if (listed.has(task.worktree)) {
        known.add(task.worktree);
        continue;
      }
      this.log(`task ${id}: its worktree ${task.worktree} is gone`);
      delete task.worktree;
    }
    for (const path of listed) {
      if (path.startsWith(`${this.settings.worktreeRoot}/`) && !known.has(path)) {
        this.log(`worktree ${path} belongs to no task; it is left as it is`);
      }
    }
  }

  // --- each pass -------------------------------------------------------------

  /**
   * One pass: clears the quota stop when it is over, takes the captain's
   * actions from the inbox, then starts what may start.
   */
  tick(): void {
    this.clearQuota();
    let board: Board;
    try {
      board = readBoard(this.settings.home);
    } catch (error) {
      this.log(`cannot read the board's files: ${(error as Error).message}`);
      return;
    }
    this.merged = board.topics.merged;
    this.boardNow = board;
    this.schedules = board.schedules;
    this.takeInbox();
    this.makeUps = this.step.takeNotices(this.sorted.schedule, board.schedules);
    const work = this.scheduleWork();
    this.step.close(work.close);
    this.dropQueued(work.drop);
    const order = dispatchOrder(board, this.deps.nowMs());
    const candidates = this.candidates(order.order, (id) => followMerges(board.topics.merged, id));
    const entries = new Map(order.order.map((entry) => [entry.topic, entry]));
    const decision = schedule({
      running: this.slots(),
      candidates,
      status: this.statusOf(board, entries),
      quotaUntil: this.quota === null ? null : isoTime(this.quota.untilMs),
      reserved: work.reserved,
    });
    for (const candidate of decision.start)
      this.launch(candidate, this.withEntries(board, entries));
    this.writeWaiting(decision.waiting);
  }

  private slots(): Slot[] {
    return [...this.live].map(([id, { topic, occurrence }]) =>
      occurrence === undefined ? { id, topic } : { id, topic, occurrence },
    );
  }

  /**
   * How each candidate stands: an occurrence's plan or fresh work by the
   * occurrence's phase; a make-up, or schedule work already started (held or
   * paused), while its topic is live; anything else by its topic's place.
   */
  private statusOf(
    board: Board,
    entries: ReadonlyMap<string, OrderEntry>,
  ): (candidate: Candidate) => TopicStatus {
    const later = new Set(board.topics.queues.later.map((id) => this.current(id)));
    const nowMs = this.deps.nowMs();
    return (candidate) => {
      const plan = candidate.id.startsWith(PLAN_PREFIX);
      const work = plan ? undefined : this.workRef(candidate.id, candidate.topic);
      const fresh = work !== undefined && !work.makeUp && !this.tasks.has(candidate.id);
      const key = plan || fresh ? candidate.occurrence : undefined;
      if (key !== undefined) return PHASE_STATUS[occurrencePhase(board.schedules, key, nowMs)];
      if (work !== undefined || (plan && this.makeUps.has(candidate.topic)))
        return this.liveTopic(candidate.topic) ? "dispatchable" : "gone";
      if (entries.has(candidate.topic)) return "dispatchable";
      return later.has(candidate.topic) ? "later" : "gone";
    };
  }

  /** The order's entries, plus one for each live topic of schedule work outside the order. */
  private withEntries(
    board: Board,
    entries: ReadonlyMap<string, OrderEntry>,
  ): ReadonlyMap<string, OrderEntry> {
    const all = new Map(entries);
    const topics = [...this.makeUps.keys(), ...[...this.live.values()].map((entry) => entry.topic)];
    for (const id of [...this.tasks.keys(), ...this.queued.map((entry) => entry.id)]) {
      if (workOf(id) !== undefined) topics.push(this.topicOfAny(id));
    }
    for (const topic of topics) {
      if (all.has(topic)) continue;
      const entry = topicEntry(board, topic, "schedule work outside the order");
      if (entry !== undefined) all.set(topic, entry);
    }
    return all;
  }

  // --- schedules -----------------------------------------------------------------

  /** Whether `topic` (merges followed) is live on the board as the last pass read it. */
  private liveTopic(topic: string): boolean {
    const now = this.current(topic);
    const board = this.boardNow;
    return board !== undefined && board.topics.topics.has(now) && !board.archived.has(now);
  }

  /** A task's or queued task's topic now: its tag, else its queued topic, merges followed. */
  private topicOfAny(id: string): string {
    const tag = this.store.readTags().get(id);
    if (tag !== undefined) return this.current(tag);
    return this.current(this.queued.find((entry) => entry.id === id)?.topic_hint ?? "");
  }

  /**
   * The occurrence work the id names, when its schedule is in the file and
   * on that topic (merges followed); undefined for any other task, so a topic
   * that happens to be named like an occurrence is never taken for one.
   */
  private workRef(id: string, topic: string): WorkRef | undefined {
    const ref = workOf(id);
    if (ref === undefined) return undefined;
    const series = this.schedules.series.get(ref.key.split(":")[0] ?? "");
    return series !== undefined && this.current(series.topic) === topic ? ref : undefined;
  }

  /** The key of the occurrence a candidate works for, when it is an occurrence's own work. */
  private occurrenceOf(id: string, topic: string): { occurrence?: string } {
    const ref = this.workRef(id, topic);
    return ref === undefined || ref.makeUp ? {} : { occurrence: ref.key };
  }

  private scheduleWork(): ScheduleWork {
    const tags = this.store.readTags();
    const tasks = new Map(
      [...this.tasks]
        .filter(([id]) => this.workRef(id, this.current(tags.get(id) ?? "")) !== undefined)
        .map(([id, task]) => [id, task.state]),
    );
    const queued = this.queued
      .filter((entry) => this.workRef(entry.id, this.current(entry.topic_hint)) !== undefined)
      .map((entry) => entry.id);
    const live = new Set([...this.live.values()].flatMap((entry) => entry.occurrence ?? []));
    return scheduleWork({
      schedules: this.schedules,
      nowMs: this.deps.nowMs(),
      tasks,
      queued,
      live,
      planned: this.plannedFor,
      usable: (topic) => this.liveTopic(topic),
    });
  }

  /** Takes queued work off the queue whose occurrence ended before it started. */
  private dropQueued(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    for (const id of ids)
      this.log(`${id}: its occurrence ended before it started; taken off the queue`);
    this.queued = this.queued.filter((entry) => !drop.has(entry.id));
    this.store.writeQueued(this.queued);
  }

  /** Whether an occurrence still needs its planner: none of its work exists, and none ran this run. */
  private needsPlan(key: string): boolean {
    if (this.plannedFor.has(key)) return false;
    const ids = [...this.tasks.keys(), ...this.queued.map((entry) => entry.id)];
    return !ids.some((id) => {
      const ref = workOf(id);
      return ref !== undefined && !ref.makeUp && ref.key === key;
    });
  }

  // --- the captain's actions ---------------------------------------------------

  private current(topic: string): string {
    return followMerges(this.merged, topic);
  }

  /** The topic a task is under now: its last tag, merges followed. */
  private topicOf(id: string): string {
    return this.current(this.store.readTags().get(id) ?? "");
  }

  private readInboxItems(): InboxItem[] {
    const items: InboxItem[] = [];
    for (const { file, text } of this.store.readInbox()) {
      const item = parseInboxFile(file, text);
      if (item !== undefined) items.push(item);
      else {
        this.log(`inbox/${file} is not an action deliver landed; moved to inbox/handled/`);
        this.store.retireInbox(file);
      }
    }
    return items;
  }

  private readTodoItems(): ReadonlyMap<string, TodoItem> {
    try {
      return readTodos(this.settings.home);
    } catch (error) {
      this.log(`cannot read the board's todos: ${(error as Error).message}`);
      return new Map();
    }
  }

  /** The running worker on `topic` whose session takes input now. */
  private liveWorkerOn(topic: string): string | undefined {
    for (const [id, entry] of this.live) {
      if (entry.topic === topic && this.streams.get(id)?.open === true) return id;
    }
    return undefined;
  }

  /** Sorts the inbox, and does now what needs no session: retire, close holds, push input. */
  private takeInbox(): void {
    this.todoItems = this.readTodoItems();
    const items = this.readInboxItems().filter((item) => !this.pushed.has(item.file));
    this.sorted = sortInbox(items, {
      tasks: this.tasks,
      holds: this.holds,
      current: (topic) => this.current(topic),
      liveWorkerOn: (topic) => this.liveWorkerOn(topic),
      takesInput: (task) => this.streams.get(task)?.open === true,
      quotaTitle: QUOTA_HOLD.title,
    });
    for (const [topic, messages] of this.sorted.messages) {
      const fresh = messages.filter((item) => !this.offered.has(item.file));
      if (fresh.length === 0) this.sorted.messages.delete(topic);
      else this.sorted.messages.set(topic, fresh);
    }
    for (const { item, log } of this.sorted.retire) {
      if (log !== undefined) this.log(log);
      this.store.retireInbox(item.file);
    }
    for (const item of this.sorted.close) this.closeAnswered(item);
    for (const { task, item } of this.sorted.push) this.pushInput(task, item);
  }

  /** The captain answered a hold that was a question only: it closes, and nothing resumes. */
  private closeAnswered(item: InboxItem & { kind: "answer" }): void {
    const answer = this.currentAnswer(item.task);
    if (answer !== undefined) {
      this.closeHold(item.task, answer.id);
      this.log(`task ${item.task}: the captain answered ${answer.label || answer.answer}`);
    }
    this.store.retireInbox(item.file);
    this.proposeClose(item.task).catch((error: unknown) =>
      this.log(`task ${item.task}: no close proposal: ${(error as Error).message}`),
    );
  }

  /** Hands a message or direct to the running session; the inbox file goes once it is taken. */
  private pushInput(task: string, item: InboxItem & { kind: "message" | "direct" }): void {
    const stream = this.streams.get(task);
    const taken = () => {
      this.pushed.delete(item.file);
      this.log(`task ${task}: passed the captain's ${item.kind} on to its running session`);
      try {
        this.store.retireInbox(item.file);
      } catch (error) {
        this.log(`inbox/${item.file} was passed on but not moved: ${(error as Error).message}`);
      }
    };
    this.pushed.set(item.file, task);
    if (stream?.push(livePrompt(item.kind, item.text), taken) !== true)
      this.pushed.delete(item.file);
  }

  /** Moves an inbox file to inbox/handled/, logging a failure instead of throwing. */
  private retireLogged(file: string): void {
    try {
      this.store.retireInbox(file);
    } catch (error) {
      this.log(`inbox/${file} was handled but not moved: ${(error as Error).message}`);
    }
  }

  /** Forgets what was pushed into `task`'s session and not taken: it waits in the inbox. */
  private releasePushed(task: string): void {
    for (const [file, owner] of this.pushed) if (owner === task) this.pushed.delete(file);
  }

  /** What the captain did that resumes `id`'s session now, or undefined. */
  private resumeOf(id: string): Resume | undefined {
    const task = this.stopped(id);
    if (task === undefined) return undefined;
    const files = this.sorted.inputs.get(id) ?? [];
    const answer = this.answerOf(id, files);
    if (answer === undefined && this.waitsForAnswer(id)) return undefined;
    const directs = files.flatMap((item) => (item.kind === "direct" ? [item.text] : []));
    const input: ResumeInput = { quota: this.resumable(id), directs };
    const todos = this.todoInput(id, task, files);
    if (answer !== undefined) input.answer = answer.text;
    if (todos !== undefined) input.todos = todos;
    const detail = resumeDetail(input);
    return detail === undefined ? undefined : { input, detail, files, answerId: answer?.id };
  }

  /**
   * Whether `id` waits on the answer to its worker's question: then only
   * the answer resumes it, and directs and todo notices wait with it.
   */
  private waitsForAnswer(id: string): boolean {
    const hold = this.holds.get(id);
    return (
      hold?.state === "open" && hold.on_answer === "release" && hold.title !== QUOTA_HOLD.title
    );
  }

  /** The task when it has a session that is not running and has not ended, else undefined. */
  private stopped(id: string): TaskEntry | undefined {
    const task = this.tasks.get(id);
    if (task === undefined || this.live.has(id)) return undefined;
    return task.state === "done" || task.state === "failed" ? undefined : task;
  }

  /**
   * The answer in answers/ to the question `id`'s open hold asks now. An
   * answer to another question (one the hold no longer asks) is moved to
   * answers/handled/ with a log line, so it can never answer the new one.
   */
  private currentAnswer(id: string) {
    const hold = this.holds.get(id);
    const answer = this.store.readAnswer(id);
    if (hold === undefined || answer === undefined) return undefined;
    const asked = createHash("sha256").update(hold.question).digest("hex");
    if (answer.questionSha256 === asked) return answer;
    this.log(`task ${id}: an answer to an earlier question was set aside`);
    this.store.retireAnswer(id, answer.id);
    return undefined;
  }

  /** The captain's answer to the task's open hold, when an answer among `files` is waiting. */
  private answerOf(id: string, files: readonly InboxItem[]) {
    const hold = this.holds.get(id);
    if (hold === undefined || !files.some((item) => item.kind === "answer")) return undefined;
    const answer = this.currentAnswer(id);
    if (answer === undefined) return undefined;
    const { title, question } = hold;
    return { id: answer.id, text: { title, question, answer: answer.answer, label: answer.label } };
  }

  /**
   * The 要你動手 items that resume a task waiting on them: once the captain
   * claimed or dropped one and none of its items is still to do.
   */
  private todoInput(id: string, task: TaskEntry, files: readonly InboxItem[]) {
    const notices = files.flatMap((item) => (item.kind === "notice" ? [item] : []));
    if (notices.length === 0 || !(task.detail ?? "").startsWith(TEXT_PREFIX.todos))
      return undefined;
    const mine = [...this.todoItems].filter(([, item]) => item.ref === id);
    if (mine.some(([, item]) => item.state === "open" || item.state === "rejected"))
      return undefined;
    const claimed = mine
      .filter(([, item]) => item.state === "claimed")
      .map(([itemId, item]) => ({ id: itemId, title: item.title }));
    const dropped = notices
      .filter((notice) => notice.event === "todo.closed" && notice.item !== null)
      .map((notice) => ({ id: notice.item?.id ?? "", title: notice.item?.title ?? "" }));
    return { claimed, dropped };
  }

  /**
   * Paused tasks to resume, then planned tasks by topic order, then topics to
   * plan: occurrences that are open first, then make-ups, then the rest.
   */
  private candidates(order: readonly OrderEntry[], current: (id: string) => string): Candidate[] {
    const tags = this.store.readTags();
    const rank = new Map(order.map((entry, index) => [entry.topic, index]));
    const resume = [...this.tasks]
      .filter(([id]) => this.resumeOf(id) !== undefined)
      .map(([id]) => ({ id, topic: current(tags.get(id) ?? "") }))
      .map((slot) => ({ ...slot, ...this.occurrenceOf(slot.id, slot.topic) }));
    const planned = this.queued
      .filter((entry) => !this.tasks.has(entry.id))
      .map((entry) => ({ id: entry.id, topic: current(entry.topic_hint) }))
      .map((slot) => ({ ...slot, ...this.occurrenceOf(slot.id, slot.topic) }))
      .toSorted(
        (a, b) => (rank.get(a.topic) ?? order.length) - (rank.get(b.topic) ?? order.length),
      );
    const busy = new Set([
      ...[...tags.values()].map(current),
      ...planned.map((entry) => entry.topic),
      ...this.planned,
    ]);
    const asked = (topic: string) => this.sorted.messages.has(topic);
    const due = order.flatMap((entry) =>
      entry.occurrence !== null && this.needsPlan(entry.occurrence.key)
        ? [{ id: planId(entry.topic), topic: entry.topic, occurrence: entry.occurrence.key }]
        : [],
    );
    const makeUps = [...this.makeUps.keys()].map((topic) => ({ id: planId(topic), topic }));
    const ordinary = order
      .filter((entry) => entry.occurrence === null)
      .filter((entry) => !busy.has(entry.topic) || asked(entry.topic))
      .map((entry) => ({ id: planId(entry.topic), topic: entry.topic }));
    const toPlan = [...due, ...makeUps, ...ordinary].filter((entry) => !this.live.has(entry.id));
    return [...resume, ...planned, ...toPlan];
  }

  /** Whether `id` is a task the quota stopped, to resume once it clears. */
  private resumable(id: string): boolean {
    const task = this.tasks.get(id);
    return task?.state === "paused" && (task.detail ?? "").startsWith(TEXT.quota);
  }

  private writeWaiting(waiting: ReadonlyMap<string, string>): void {
    let changed = false;
    for (const entry of this.queued) {
      const hold = waiting.get(entry.id) ?? null;
      if ((entry.hold ?? null) === hold) continue;
      entry.hold = hold;
      changed = true;
    }
    if (changed) this.store.writeQueued(this.queued);
  }

  /**
   * Starts one candidate. One whose topic has no entry in the dispatch order
   * is skipped, not started: starting it would end at once and start the next
   * pass, again and again.
   */
  private launch(candidate: Candidate, entries: ReadonlyMap<string, OrderEntry>): void {
    const entry = entries.get(candidate.topic);
    if (entry === undefined) {
      this.log(
        `${candidate.id}: its topic ${candidate.topic} is not in the dispatch order; not started`,
      );
      return;
    }
    let done: Promise<void>;
    const resume = this.resumeOf(candidate.id);
    if (candidate.id.startsWith(PLAN_PREFIX)) {
      const purpose = this.planFor(candidate);
      if (purpose === undefined) this.planned.add(candidate.topic);
      else if (!purpose.ref.makeUp) {
        this.step.takeIfOpen(purpose.ref.key, this.schedules, NOTE.takeDue);
      }
      done = this.plan(entry, this.sorted.messages.get(candidate.topic) ?? [], purpose);
    } else if (resume !== undefined) {
      done = this.resume(candidate.id, resume);
    } else if (this.tasks.has(candidate.id)) {
      this.log(`${candidate.id} is already a task; not started again`);
      return;
    } else {
      done = this.dispatch(candidate.id, candidate.topic, entry);
    }
    const tracked = done
      .catch((error: unknown) => this.log(`${candidate.id}: ${(error as Error).message}`))
      .finally(() => {
        this.live.delete(candidate.id);
        try {
          this.tick();
        } catch (error) {
          this.log(`the pass after ${candidate.id} failed: ${(error as Error).message}`);
        }
      });
    const { occurrence } = candidate;
    this.live.set(
      candidate.id,
      occurrence === undefined
        ? { topic: candidate.topic, done: tracked }
        : { topic: candidate.topic, occurrence, done: tracked },
    );
  }

  /** What a plan candidate plans for: its occurrence, the topic's make-up, or undefined. */
  private planFor(candidate: Candidate): PlanFor | undefined {
    if (candidate.occurrence !== undefined)
      return { ref: { key: candidate.occurrence, makeUp: false }, makeUp: undefined };
    const makeUp = this.makeUps.get(candidate.topic);
    return makeUp === undefined ? undefined : { ref: { key: makeUp.key, makeUp: true }, makeUp };
  }

  // --- the planner -------------------------------------------------------------

  private sessionContext(defaultBranch: string | null, abort: AbortController): SessionContext {
    return {
      model: this.settings.model,
      env: this.deps.env,
      token: this.deps.token,
      abortController: abort,
      guard: {
        home: this.settings.home,
        port: this.settings.port,
        defaultBranch,
        realPath: this.deps.realPath,
        userHome: this.deps.env.HOME,
      },
    };
  }

  /** The topic's tasks and queued tasks, as the planner sees them. */
  private topicTasks(
    topic: string,
  ): { id: string; title: string; state: string; detail: string }[] {
    const tasks = [...this.tasks]
      .filter(([id]) => this.topicOf(id) === topic)
      .map(([id, task]) => ({
        id,
        title: task.title ?? "",
        state: task.state,
        detail: task.detail ?? "",
      }));
    const queued = this.queued
      .filter((entry) => this.current(entry.topic_hint) === topic)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        state: "queued",
        detail: entry.hold ?? "",
      }));
    return [...tasks, ...queued];
  }

  private async plan(
    entry: OrderEntry,
    messages: readonly (InboxItem & { kind: "message" })[],
    purpose: PlanFor | undefined,
  ): Promise<void> {
    for (const item of messages) this.offered.add(item.file);
    const abort = new AbortController();
    const prompt = new PromptStream(
      plannerPrompt({
        topic: { id: entry.topic, name: entry.name, goal: entry.goal, hashtags: entry.hashtags },
        repos: Object.keys(this.settings.repos),
        messages: messages.map((item) => item.text),
        tasks: this.topicTasks(entry.topic),
      }),
    );
    const options = plannerOptions(this.settings.worktreeRoot, this.sessionContext(null, abort));
    const run = this.deps.query({ prompt, options });
    const report = await followSession(run, prompt, abort, { mode: "dontAsk", onStart: () => {} });
    this.takePlan(entry.topic, report, purpose?.ref);
    if (report.end.kind === "quota") {
      for (const item of messages) this.offered.delete(item.file);
      return;
    }
    for (const item of messages) this.retireLogged(item.file);
    if (purpose?.makeUp !== undefined) this.retireLogged(purpose.makeUp.item.file);
  }

  private takePlan(topic: string, report: SessionReport, ref: WorkRef | undefined): void {
    const { end } = report;
    if (end.kind === "quota") {
      this.planned.delete(topic);
      this.stopForQuota(null, end.resetsAtMs);
      return;
    }
    const output = end.kind === "output" ? parsePlannerOutput(end.output) : undefined;
    if (output === undefined) {
      this.log(
        `planner for ${topic} gave no usable plan (${end.kind}); not planned again this run`,
      );
      if (ref !== undefined && !ref.makeUp) this.plannedFor.set(ref.key, "failed");
      return;
    }
    if (output.question !== null) {
      this.log(
        `planner for ${topic} asked: ${output.question.title}; questions come in a later step`,
      );
    }
    const queued = this.queuePlanned(topic, output.tasks, ref);
    if (queued === 0 && ref !== undefined && !ref.makeUp) this.plannedFor.set(ref.key, "nothing");
  }

  /**
   * Puts the planner's tasks for `topic` at the end of the queue, those for
   * known repositories, named after the occurrence when they are its work.
   *
   * Returns:
   *   How many it queued.
   */
  private queuePlanned(topic: string, tasks: readonly PlannedWork[], ref?: WorkRef): number {
    let queued = 0;
    for (const work of tasks) {
      if (this.settings.repos[work.repo] === undefined) {
        this.log(
          `planner for ${topic} named repo ${work.repo}, which is not in the settings; skipped`,
        );
        continue;
      }
      queued += 1;
      this.queued.push({
        id: ref === undefined ? this.nextId(topic) : this.nextWorkId(ref),
        kind: work.kind,
        title: work.title,
        hold: null,
        captain: false,
        blockers: [],
        topic_hint: topic,
        repo: work.repo,
        prompt: work.prompt,
      });
    }
    this.store.writeQueued(this.queued);
    return queued;
  }

  private nextId(topic: string): string {
    return this.firstUnused((n) => `${topic}-${n}`);
  }

  private nextWorkId(ref: WorkRef): string {
    return this.firstUnused((n) => workId(ref, n));
  }

  private firstUnused(name: (n: number) => string): string {
    const used = new Set([...this.tasks.keys(), ...this.queued.map((entry) => entry.id)]);
    for (const id of this.store.readTags().keys()) used.add(id);
    let n = 1;
    while (used.has(name(n))) n += 1;
    return name(n);
  }

  // --- a worker ----------------------------------------------------------------

  private repoOf(task: TaskEntry): RepoSetting {
    const repo = this.settings.repos[task.repo ?? ""];
    if (repo === undefined) throw new Error(`repo ${String(task.repo)} is not in the settings`);
    return repo;
  }

  /** Claims a planned task: tasks.json and its tag first, then queued.json, then the worktree. */
  private async dispatch(id: string, topic: string, entry: OrderEntry): Promise<void> {
    const planned = this.queued.find((item) => item.id === id);
    if (planned === undefined) return;
    const repo = this.settings.repos[planned.repo];
    if (repo === undefined) {
      this.log(`task ${id}: repo ${planned.repo} is not in the settings; taken off the queue`);
      this.queued = this.queued.filter((item) => item.id !== id);
      this.store.writeQueued(this.queued);
      return;
    }
    const worktree = join(this.settings.worktreeRoot, id);
    const branch = `agg/${id}`;
    this.tasks.set(id, {
      kind: planned.kind,
      state: "working",
      detail: DETAIL.preparing,
      unstarted: true,
      title: planned.title,
      repo: planned.repo,
      worktree,
      branch,
      pr_url: null,
    });
    this.saveTasks();
    this.store.appendTag(id, topic, isoTime(this.deps.nowMs()));
    this.queued = this.queued.filter((item) => item.id !== id);
    this.store.writeQueued(this.queued);
    this.store.appendLedger({ event: "task.dispatched", task: id, kind: planned.kind });
    const problem = await this.git.addWorktree(repo.path, worktree, branch, repo.base);
    if (problem !== undefined) {
      delete this.task(id).worktree;
      await this.end(id, endingFailed(DETAIL.noWorktree(problem)), 0);
      return;
    }
    const brief = { task: id, branch, topic: { id: topic, name: entry.name, goal: entry.goal } };
    await this.work(id, workerPrompt({ ...brief, title: planned.title, prompt: planned.prompt }));
  }

  /**
   * Resumes `id`'s session with what the captain did. The task is marked
   * working first, then the answer and inbox files it consumes are retired,
   * then the session runs: a crash in between leaves the task paused at the
   * next start, never resumed twice with the same input.
   */
  private async resume(id: string, resume: Resume): Promise<void> {
    const task = this.task(id);
    const session = task.worktree === undefined ? undefined : task.session_id;
    if (session !== undefined) this.setState(id, "working", resume.detail);
    if (resume.answerId !== undefined) this.closeHold(id, resume.answerId);
    for (const item of resume.files) this.store.retireInbox(item.file);
    if (session === undefined) {
      await this.end(id, endingFailed(DETAIL.noSession), 0);
      return;
    }
    await this.work(id, resumePrompt(resume.input), session);
  }

  private async work(id: string, text: string, resume?: string): Promise<void> {
    const task = this.task(id);
    const repo = this.repoOf(task);
    const abort = new AbortController();
    const prompt = new PromptStream(text);
    const options = workerOptions(
      {
        worktree: task.worktree ?? "",
        mainCheckout: repo.path,
        resume,
        scout: task.kind === "scout",
      },
      this.sessionContext(repo.defaultBranch, abort),
    );
    const run = this.deps.query({ prompt, options });
    this.streams.set(id, prompt);
    const report = await followSession(run, prompt, abort, {
      mode: "auto",
      onStart: (init) => {
        task.session_id = init.session_id;
        if (init.model !== undefined) task.model = init.model;
        task.unstarted = false;
        this.setState(id, "working", `${DETAIL.started}（模型：${init.model ?? "沒寫"}）`);
      },
    });
    this.streams.delete(id);
    this.releasePushed(id);
    if (report.sessionId !== undefined) task.session_id = report.sessionId;
    if (report.model !== undefined) task.model = report.model;
    await this.end(id, endingOf(report.end), report.costUsd);
  }

  private async end(id: string, ending: Ending, costUsd: number): Promise<void> {
    const task = this.task(id);
    task.unstarted = false;
    if (costUsd > 0) task.cost_usd_estimate = costUsd;
    if (ending.prReady !== null) {
      task.pr_url = ending.prReady;
      this.store.appendLedger({ event: "task.pr_ready", task: id, pr: ending.prReady });
    }
    const cost =
      task.cost_usd_estimate === undefined
        ? ""
        : `（估計花費 ${task.cost_usd_estimate.toFixed(2)} 美元）`;
    this.setState(id, ending.state, `${ending.text}${cost}`);
    if (ending.summary !== null) await this.summary(id, ending.summary.kind, ending.summary.text);
    if (ending.hold !== null) this.openHold(id, ending.hold);
    await this.syncTodos(id, ending.todos);
    if (ending.quota !== null) this.stopForQuota(id, ending.quota.resetsAtMs);
    if (ending.cleanUp) await this.cleanUp(id);
    await this.proposeClose(id);
  }

  /** Opens the hold a worker's question asks for, keyed by its task (plan section 4.4). */
  private openHold(id: string, request: HoldRequest): void {
    const reserved = request.title === QUOTA_HOLD.title;
    this.holds.set(id, {
      state: "open",
      title: reserved ? `${request.title}（worker 的問題）` : request.title,
      question: request.question,
      on_answer: request.onAnswer,
      hold_set: isoTime(this.deps.nowMs()),
      origin: "",
      hold_bucket: "live",
      hold_until: null,
      unresolved_blocker_ids: [],
    });
    this.store.writeHolds(this.holds);
  }

  /** Brings the task's 要你動手 items on the board in line with how its session ended. */
  private async syncTodos(id: string, todos: EndTodos): Promise<void> {
    if (todos.kind === "keep") return;
    const items = new Map([...this.readTodoItems()].filter(([, item]) => item.ref === id));
    const ops =
      todos.kind === "drop"
        ? todoOps(items, todos)
        : todoOps(items, {
            kind: "sync",
            wanted: boardTodos(
              id,
              this.topicOf(id),
              todos.todos.map((todo) => this.redactTodo(todo)),
            ),
            summary: todos.summary,
          });
    for (const op of ops) await this.runTodo(id, op);
  }

  private redactTodo(todo: Todo): Todo {
    const { redact } = this;
    return {
      id: redact(todo.id),
      title: redact(todo.title),
      do: redact(todo.do),
      cmds: todo.cmds.map(redact),
    };
  }

  private async runTodo(id: string, op: TodoOp): Promise<void> {
    let problem: string | undefined;
    if (op.op === "add") problem = await this.board.todoAdd(op.item);
    else if (op.op === "done") problem = await this.board.todoDone(op.id);
    else if (op.op === "failed")
      problem = await this.board.todoFailed(op.id, this.redact(op.reason));
    else problem = await this.board.todoObsolete(op.id, op.reason);
    const item = op.op === "add" ? op.item.id : op.id;
    if (problem !== undefined)
      this.log(`task ${id}: todo ${op.op} ${item} was not taken: ${problem}`);
  }

  /** Proposes closing the task's topic when all of its tasks have landed. */
  private async proposeClose(id: string): Promise<void> {
    const topic = this.topicOf(id);
    let board: Board;
    try {
      board = readBoard(this.settings.home);
    } catch (error) {
      this.log(`cannot read the board's files: ${(error as Error).message}`);
      return;
    }
    const scheduled = [...board.schedules.series.values()].some(
      (series) => followMerges(board.topics.merged, series.topic) === topic,
    );
    if (scheduled) return;
    const tags = this.store.readTags();
    const tasks = new Map(
      [...this.tasks].filter(
        ([task]) => followMerges(board.topics.merged, tags.get(task) ?? "") === topic,
      ),
    );
    const others = [...this.live].filter(([live, entry]) => live !== id && entry.topic === topic);
    const queued = this.queued.some((entry) => this.current(entry.topic_hint) === topic);
    const reason = closeReason({
      live: board.topics.topics.has(topic),
      proposed: board.topics.proposed.has(topic),
      tasks,
      held: new Set(
        [...this.holds].filter(([, hold]) => hold.state === "open").map(([task]) => task),
      ),
      pending: others.length > 0 || queued || this.sorted.messages.has(topic),
      closedDetail: DETAIL.closed,
    });
    if (reason === undefined) return;
    const problem = await this.board.closePropose(topic, reason);
    if (problem === undefined) this.log(`proposed closing topic ${topic}: ${reason}`);
    else this.log(`topic ${topic}: the close proposal was not taken: ${problem}`);
  }

  private async summary(id: string, kind: SummaryKind, text: string): Promise<void> {
    const problem = await this.board.summary(id, kind, this.redact(text));
    if (problem !== undefined) this.log(`task ${id}: the summary was not stored: ${problem}`);
  }

  /** Removes the task's worktree, unless it holds commits no remote has or changes. */
  private async cleanUp(id: string): Promise<void> {
    const task = this.task(id);
    if (task.worktree === undefined) return;
    const unpushed = await this.git.unpushedCommits(task.worktree);
    if (unpushed !== 0) {
      this.setState(id, "blocked", DETAIL.unpushed);
      return;
    }
    const problem = await this.git.removeWorktree(this.repoOf(task).path, task.worktree);
    if (problem !== undefined) {
      this.setState(id, "blocked", DETAIL.dirty(problem));
      return;
    }
    delete task.worktree;
    this.saveTasks();
    this.store.appendLedger({ event: "task.cleaned_up", task: id });
  }

  // --- pull requests -------------------------------------------------------------

  /** Looks at each ready task's PR: merged or closed, its worktree goes. */
  async pollPullRequests(): Promise<void> {
    for (const [id, task] of this.tasks) {
      if (task.state !== "done" || !task.pr_url || task.worktree === undefined) continue;
      const state = await pullRequestState(this.deps.run, this.deps.env, task.pr_url);
      if (state === "MERGED") {
        this.store.appendLedger({ event: "task.merged", task: id, pr: task.pr_url });
        this.setState(id, "done", DETAIL.merged);
        await this.summary(id, "landed", `已合併：${task.pr_url}`);
        await this.cleanUp(id);
        await this.proposeClose(id);
      } else if (state === "CLOSED") {
        this.setState(id, "done", DETAIL.closed);
        await this.cleanUp(id);
      }
    }
  }

  // --- the quota stop ----------------------------------------------------------

  private stopForQuota(id: string | null, resetsAtMs: number | null): void {
    const untilMs = Math.max(resetsAtMs ?? this.deps.nowMs() + QUOTA_WAIT_MS, this.deps.nowMs());
    const quota = this.quota ?? { untilMs, hold: null };
    quota.untilMs = Math.max(quota.untilMs, untilMs);
    this.quota = quota;
    this.log(`dispatching stops for the quota or rate limit until ${isoTime(quota.untilMs)}`);
    if (quota.hold === null && id !== null && this.holds.get(id)?.state !== "open") {
      quota.hold = id;
    }
    if (quota.hold !== null) this.writeQuotaHold(quota.hold, quota.untilMs);
  }

  /** Opens or updates the hold on `id` that says dispatching stopped until `untilMs`. */
  private writeQuotaHold(id: string, untilMs: number): void {
    this.holds.set(id, {
      state: "open",
      title: QUOTA_HOLD.title,
      question: QUOTA_HOLD.question(isoTime(untilMs)),
      on_answer: "release",
      hold_set: this.holds.get(id)?.hold_set ?? isoTime(this.deps.nowMs()),
      hold_bucket: "live",
      hold_until: isoTime(untilMs),
    });
    this.store.writeHolds(this.holds);
  }

  /** Ends the quota stop once its time has come or the captain answered 現在恢復. */
  private clearQuota(): void {
    const quota = this.quota;
    if (quota === null) return;
    const now = this.takeQuotaAnswer(quota);
    if (!now && this.deps.nowMs() < quota.untilMs) return;
    if (quota.hold !== null) this.closeHold(quota.hold, undefined);
    this.quota = null;
    this.log("dispatching resumes after the quota stop");
  }

  /**
   * Closes the quota hold the captain answered, if they did.
   *
   * Returns:
   *   Whether the answer was 現在恢復.
   */
  private takeQuotaAnswer(quota: Quota): boolean {
    if (quota.hold === null) return false;
    const answer = this.store.readAnswer(quota.hold);
    if (answer === undefined) return false;
    this.closeHold(quota.hold, answer.id);
    quota.hold = null;
    return [answer.answer, answer.label].includes(QUOTA_HOLD.resumeNow);
  }

  private closeHold(id: string, answerId: string | undefined): void {
    const hold = this.holds.get(id);
    if (hold !== undefined) hold.state = "closed";
    this.store.writeHolds(this.holds);
    if (answerId !== undefined) this.store.retireAnswer(id, answerId);
  }
}

/** The detail of a task resumed with `input`, or undefined when nothing resumes it. */
function resumeDetail(input: ResumeInput): string | undefined {
  if (input.answer !== undefined) return DETAIL.answered(input.answer.label || input.answer.answer);
  if (input.directs.length > 0) return DETAIL.directed;
  if (input.todos !== undefined) return DETAIL.verifying;
  return input.quota ? DETAIL.resumed : undefined;
}

function endingFailed(text: string): Ending {
  return endingOf({ kind: "refused", reason: text });
}
