// The supervisor (plan section 4): it plans topics into tasks, starts at most
// two sessions at once (one per topic), runs each worker in its own git
// worktree outside the board home, writes the agent's state files and the
// ledger, writes summaries through the board's command, cleans worktrees up,
// and stops dispatching while the quota or rate limit says so. It is the only
// writer of the agent's state; workers never write the board.

import { join } from "node:path";

import type { HoldEntry, TaskEntry } from "#agg/state-files.js";

import { readBoard, type Board } from "./board-files.js";
import {
  BoardCommand,
  Git,
  pullRequestState,
  type PlainEnv,
  type RunCommand,
  type SummaryKind,
} from "./commands.js";
import { dispatchOrder, followMerges, type OrderEntry } from "./dispatch-order.js";
import { endingOf, TEXT, type Ending } from "./ending.js";
import { parsePlannerOutput } from "./outputs.js";
import { plannerPrompt, RESUME_PROMPT, workerPrompt } from "./prompts.js";
import { schedule, type Candidate, type Slot, type TopicStatus } from "./scheduler.js";
import type { QueryFn } from "./sdk.js";
import { followSession, PromptStream, type SessionReport } from "./session.js";
import { plannerOptions, workerOptions, type SessionContext } from "./session-options.js";
import { checkSettings, takeLock, type RepoSetting, type Settings } from "./settings.js";
import { StateStore, type PlannedTask } from "./state-store.js";
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
  private readonly live = new Map<string, { topic: string; done: Promise<void> }>();
  private readonly planned = new Set<string>();
  private quota: Quota | null = null;

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
    for (const [id, hold] of this.holds) {
      if (hold.state !== "open" || hold.title !== QUOTA_HOLD.title) continue;
      const until = Date.parse(hold.hold_until ?? "");
      const untilMs = Number.isNaN(until) ? this.deps.nowMs() + QUOTA_WAIT_MS : until;
      this.quota = { untilMs, hold: id };
    }
    this.saveTasks();
    this.store.writeQueued(this.queued);
  }

  private async reconcileWorktrees(): Promise<void> {
    const listed = new Set<string>();
    for (const repo of Object.values(this.settings.repos)) {
      const paths = await this.git.worktrees(repo.path);
      if (paths === undefined) {
        this.log(`git worktree list failed in ${repo.path}; worktrees there are left as they are`);
        return;
      }
      for (const path of paths) listed.add(path);
    }
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

  /** One pass: clears the quota stop when it is over, then starts what may start. */
  tick(): void {
    this.clearQuota();
    let board: Board;
    try {
      board = readBoard(this.settings.home);
    } catch (error) {
      this.log(`cannot read the board's files: ${(error as Error).message}`);
      return;
    }
    const order = dispatchOrder(board, this.deps.nowMs());
    const entries = new Map(order.order.map((entry) => [entry.topic, entry]));
    const later = new Set(
      board.topics.queues.later.map((id) => followMerges(board.topics.merged, id)),
    );
    const topicStatus = (topic: string): TopicStatus => {
      const now = followMerges(board.topics.merged, topic);
      if (entries.has(now)) return "dispatchable";
      return later.has(now) ? "later" : "gone";
    };
    const candidates = this.candidates(order.order, (id) => followMerges(board.topics.merged, id));
    const decision = schedule({
      running: [...this.live].map(([id, entry]) => ({ id, topic: entry.topic })),
      candidates,
      topicStatus,
      quotaUntil: this.quota === null ? null : isoTime(this.quota.untilMs),
    });
    for (const candidate of decision.start) this.launch(candidate, entries);
    this.writeWaiting(decision.waiting);
  }

  /** Paused tasks to resume, then planned tasks by topic order, then topics to plan. */
  private candidates(order: readonly OrderEntry[], current: (id: string) => string): Candidate[] {
    const tags = this.store.readTags();
    const rank = new Map(order.map((entry, index) => [entry.topic, index]));
    const resume = [...this.tasks]
      .filter(([, task]) => task.state === "paused" && (task.detail ?? "").startsWith(TEXT.quota))
      .map(([id]) => ({ id, topic: current(tags.get(id) ?? "") }));
    const planned = this.queued
      .map((entry) => ({ id: entry.id, topic: current(entry.topic_hint) }))
      .toSorted(
        (a, b) => (rank.get(a.topic) ?? order.length) - (rank.get(b.topic) ?? order.length),
      );
    const busy = new Set([
      ...[...tags.values()].map(current),
      ...planned.map((entry) => entry.topic),
      ...this.planned,
    ]);
    const toPlan = order
      .filter((entry) => !busy.has(entry.topic))
      .map((entry) => ({ id: `${PLAN_PREFIX}${entry.topic}`, topic: entry.topic }));
    return [...resume, ...planned, ...toPlan];
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

  private launch(candidate: Candidate, entries: ReadonlyMap<string, OrderEntry>): void {
    const entry = entries.get(candidate.topic);
    let done: Promise<void>;
    if (candidate.id.startsWith(PLAN_PREFIX)) {
      if (entry === undefined) return;
      this.planned.add(candidate.topic);
      done = this.plan(entry);
    } else if (this.tasks.has(candidate.id)) {
      done = this.resume(candidate.id);
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
    this.live.set(candidate.id, { topic: candidate.topic, done: tracked });
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
      },
    };
  }

  private async plan(entry: OrderEntry): Promise<void> {
    const abort = new AbortController();
    const prompt = new PromptStream(
      plannerPrompt({
        topic: { id: entry.topic, name: entry.name, goal: entry.goal, hashtags: entry.hashtags },
        repos: Object.keys(this.settings.repos),
      }),
    );
    const options = plannerOptions(this.settings.worktreeRoot, this.sessionContext(null, abort));
    const run = this.deps.query({ prompt, options });
    const report = await followSession(run, prompt, abort, { mode: "dontAsk", onStart: () => {} });
    this.takePlan(entry.topic, report);
  }

  private takePlan(topic: string, report: SessionReport): void {
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
      return;
    }
    if (output.question !== null) {
      this.log(
        `planner for ${topic} asked: ${output.question.title}; questions come in a later step`,
      );
    }
    for (const work of output.tasks) {
      if (this.settings.repos[work.repo] === undefined) {
        this.log(
          `planner for ${topic} named repo ${work.repo}, which is not in the settings; skipped`,
        );
        continue;
      }
      this.queued.push({
        id: this.nextId(topic),
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
  }

  private nextId(topic: string): string {
    const used = new Set([...this.tasks.keys(), ...this.queued.map((entry) => entry.id)]);
    for (const id of this.store.readTags().keys()) used.add(id);
    let n = 1;
    while (used.has(`${topic}-${n}`)) n += 1;
    return `${topic}-${n}`;
  }

  // --- a worker ----------------------------------------------------------------

  private repoOf(task: TaskEntry): RepoSetting {
    const repo = this.settings.repos[task.repo ?? ""];
    if (repo === undefined) throw new Error(`repo ${String(task.repo)} is not in the settings`);
    return repo;
  }

  /** Claims a planned task: tasks.json and its tag first, then queued.json, then the worktree. */
  private async dispatch(id: string, topic: string, entry: OrderEntry | undefined): Promise<void> {
    const planned = this.queued.find((item) => item.id === id);
    if (planned === undefined || entry === undefined) return;
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

  private async resume(id: string): Promise<void> {
    const task = this.task(id);
    if (task.session_id === undefined || task.worktree === undefined) {
      await this.end(id, endingFailed(DETAIL.noSession), 0);
      return;
    }
    this.setState(id, "working", DETAIL.resumed);
    await this.work(id, RESUME_PROMPT, task.session_id);
  }

  private async work(id: string, text: string, resume?: string): Promise<void> {
    const task = this.task(id);
    const repo = this.repoOf(task);
    const abort = new AbortController();
    const prompt = new PromptStream(text);
    const options = workerOptions(
      { worktree: task.worktree ?? "", mainCheckout: repo.path, resume },
      this.sessionContext(repo.defaultBranch, abort),
    );
    const run = this.deps.query({ prompt, options });
    const report = await followSession(run, prompt, abort, {
      mode: "auto",
      onStart: (init) => {
        task.session_id = init.session_id;
        if (init.model !== undefined) task.model = init.model;
        task.unstarted = false;
        this.setState(id, "working", `${DETAIL.started}（模型：${init.model ?? "沒寫"}）`);
      },
    });
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
    if (ending.quota !== null) this.stopForQuota(id, ending.quota.resetsAtMs);
    if (ending.cleanUp) await this.cleanUp(id);
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
    if (quota.hold === null) return;
    this.holds.set(quota.hold, {
      state: "open",
      title: QUOTA_HOLD.title,
      question: QUOTA_HOLD.question(isoTime(quota.untilMs)),
      on_answer: "release",
      hold_set: this.holds.get(quota.hold)?.hold_set ?? isoTime(this.deps.nowMs()),
      hold_bucket: "live",
      hold_until: isoTime(quota.untilMs),
    });
    this.store.writeHolds(this.holds);
  }

  /** Ends the quota stop once its time has come or the captain answered 現在恢復. */
  private clearQuota(): void {
    const quota = this.quota;
    if (quota === null) return;
    const answer = quota.hold === null ? undefined : this.store.readAnswer(quota.hold);
    const now =
      answer !== undefined && [answer.answer, answer.label].includes(QUOTA_HOLD.resumeNow);
    if (answer !== undefined && quota.hold !== null) {
      this.closeHold(quota.hold, answer.id);
      quota.hold = null;
    }
    if (!now && this.deps.nowMs() < quota.untilMs) return;
    if (quota.hold !== null) this.closeHold(quota.hold, undefined);
    this.quota = null;
    this.log("dispatching resumes after the quota stop");
  }

  private closeHold(id: string, answerId: string | undefined): void {
    const hold = this.holds.get(id);
    if (hold !== undefined) hold.state = "closed";
    this.store.writeHolds(this.holds);
    if (answerId !== undefined) this.store.retireAnswer(id, answerId);
  }
}

function endingFailed(text: string): Ending {
  return endingOf({ kind: "refused", reason: text });
}
