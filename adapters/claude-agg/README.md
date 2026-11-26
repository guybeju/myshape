# claude-agg

claude-agg is an aggregator for the myshape board that is not Firstmate: a
Claude agent that reports its work to the board and takes the actions made on
the board's page. It is built against the board's contract only
([`myshape/spec/contracts.markdown`](../../myshape/spec/contracts.markdown),
sections 4 and 7). It imports nothing from `myshape/` or `adapters/firstmate/`,
and the board imports nothing from it.

So far it holds the program the board runs, `bin/agg-board.mjs`, the formats
of the agent's state files, and the supervisor in `src/supervisor/` (below).
The supervisor takes the Agent SDK's `query()` as an injected function; the
package is not a dependency yet and there is no entry point that runs the
supervisor, so nothing here calls a model. The tests pass a scripted double.

## The supervisor: `src/supervisor/`

It reads a board home's `data/topics.json`, `data/topics-archive.json`,
`data/myshape/hashtags.json` and `data/myshape/schedules.json`, computes the
order new work is handed out in (`dispatch-order.ts`), and then:

- **plans** each dispatchable topic that has no task with one read-only
  planner session (`Read`, `Grep`, `Glob`, `dontAsk`), keeping only tasks for
  the repositories its settings list;
- **dispatches** at most 2 sessions in all and 1 per topic (`scheduler.ts`);
  the rest wait in `queued.json` with the reason as `hold`. Nothing new starts
  for a topic in 待辦 or archived, and a running worker is never stopped;
- **claims** a task in `tasks.json` and its `tags/<task-id>` first, then takes
  it out of `queued.json`, then runs `git worktree add <root>/<task-id> -b
  agg/<task-id> <base>` in the repository's main checkout, with the worktree
  root outside the board home;
- **runs** one worker session per task with the options of
  `session-options.ts` (auto mode with no prompts, the deny rules and the
  PreToolUse guard of `guard.ts`, the target repository's project settings
  from its main checkout, no MCP but what it passes, 200 turns, a structured
  output), and stops a session whose start message is not `auto` or names an
  API key;
- **writes** the ledger (`task.dispatched`, `task.status`, `task.pr_ready`,
  `task.merged`, `task.cleaned_up`) and summaries through the board's
  `bin/myshape.sh summary`; workers never write the board;
- **takes the captain's actions** from `agg/inbox/` each pass, oldest first,
  and moves each file to `inbox/handled/` once it is handed on:
  - a worker's `question` opens a hold keyed by its task, its options as the
    last line 「選項：A | B」; `release` (the work waits) unless the worker
    delivered its work (`ready` or `landed`), then `close`. A page answer to a
    `release` hold resumes the worker's session with the answer; one to a
    `close` hold only closes it;
  - a `message` for a topic goes into the topic's running worker session, or
    else to the planner together with the topic's tasks, which may plan a new
    task; a `direct` goes into the running session, or resumes a stopped
    worker's session; one that lands after its worker ended is logged and
    dropped (`deliver` refuses one for a worker already ended);
  - a worker's `todos` go on the board with `todo add` (item ids under the
    task id, the task id as `--ref`); once the captain claimed or dropped
    every open item of a task, the worker's session is resumed to check, and
    the supervisor runs `todo done` for an item it no longer lists, `todo
    failed --reason` for one it lists again, and `todo obsolete` for an item
    no longer needed or left when the task ends;
  - a topic whose tasks have all landed gets `close-propose`;
  - every resume goes through the same scheduler (2 sessions, 1 per topic),
    and the captain's text reaches a session only inside a data frame;
- **cleans up** a worktree with `git worktree remove` once its task ended
  (after the PR merged or closed, for a PR), never with `--force`, and records
  `blocked` with 「worktree 還有沒推的提交」 instead when it holds commits no remote
  has;
- **stops dispatching** when a session ends on the quota or rate limit,
  leaves running workers alone, opens a hold on that task, and resumes its
  session when the time the limit gave has passed or the captain answers
  「現在恢復」;
- **reconciles** at start: a worker of the last run that was still working is
  `paused`, a task listed in both `tasks.json` and `queued.json` stays in
  `tasks.json` only, worktrees git no longer lists are dropped from
  `tasks.json`, and a lock in the worktree root keeps a second supervisor
  away.

`src/supervisor/hashtags.ts` holds the guarded hashtag operation: it puts one
hashtag on a topic or takes it off through `bin/myshape.sh hashtag`, only
when the name is a hashtag name and the captain's `aggregator_may_tag`,
`aggregator_may_create`, lock, per-topic, board-wide and hourly limits (read
from `hashtags.json` and `events.jsonl`) allow it. Nothing calls it yet: which
output may ask for a hashtag change comes with the board's tag list. The
agent creates no topic and no schedule.

The model is the user's setting, passed to every session unchanged; with no
setting, sessions get no model option. The subscription token is read from a
file only its owner can read (`token.ts`), goes only into the sessions'
environment, and is taken out of every text the supervisor writes.

## What the board runs: `bin/agg-board.mjs`

One self-contained file, run by the board as both its feed and its deliver:

| Call | What it does |
| --- | --- |
| `agg-board.mjs feed main <offset> <sha> [<closed-offset> <closed-sha>]` | Prints the home's report (contract section 4): tasks, queued tasks, open holds, topic tags and the ledger from the board's cursor, built from the state files |
| `agg-board.mjs topics main <task>...` | Prints `{"topics": {...}}`, the topic tags of those tasks |
| `agg-board.mjs deliver` | Reads one action record on stdin and prints one outcome line (contract section 7.1) |

What `deliver` does with each kind:

| `kind` | It | Outcome |
| --- | --- | --- |
| `message`, `notice` (any `event`, known or not) | lands the record in `agg/inbox/<id>.json` | `delivered` |
| `direct` | lands it when `tasks.json` has the worker in any state but `done` or `failed` | `delivered`; `failed` with 「這個 worker 已經結束，訊息沒有送出。」 for an ended worker, and for an unknown worker or text that starts with `/`, `$`, `!` or `-` |
| `answer` | writes `agg/answers/<task>.json` when the task's hold is open and its question's SHA-256 is the record's `question_sha256`, then lands it in the inbox | `delivered` (the same answer again too); `handled_elsewhere` when the hold is closed, gone, asks another question or already has another answer; `retry` while the answer to an older question is still waiting for the supervisor |
| `tag` | appends `<topic> <time>` to `agg/tags/<task>` when its last line is still the one the board saw, then lands it in the inbox | `delivered` (also when the task is already under that topic); `handled_elsewhere` when it was filed elsewhere since |

Every kind is safe to deliver twice: a write id already in `inbox/` or
`inbox/handled/` is `delivered` with nothing written. A record whose shape is
wrong (not one line of JSON, `v` not 1, an unknown kind, a missing field, an
id, home, task or topic that is not a plain name) exits 2 and writes nothing;
so do `feed` and `topics` for an argument of the wrong shape or a home other
than `main`. While `agg/`, `agg/inbox/`, `agg/answers/` or `agg/tags/` is
missing, `deliver` answers `retry` and `feed` exits 4 with a one-line banner.

What it does not do:

- It reads only `$MYSHAPE_HOME/agg/` and its own file (to name its version as
  `code_commit`: the start of its own SHA-256). It writes only the three kinds
  above, under `$MYSHAPE_HOME/agg/`. It never touches the board's `data/`,
  `state/` or `config/`.
- It reads one environment name, `MYSHAPE_HOME`, of the five the board hands
  its programs.
- It starts no process, opens no network connection, calls no model and
  loads nothing but Node's built-in `fs`, `path` and `crypto`. The page's
  confirmation binds this one file's SHA-256, so the confirmation covers all
  of what the board runs.

The state files and who writes each are in
[`spec/state-files.markdown`](spec/state-files.markdown); their TypeScript
types are in `src/state-files.ts`.

## Wiring it to a board

The board runs the program only after the captain confirms it on the page,
and asks again whenever its content changes (contract section 7).

1. Use a board home of its own, with its own port in `config/myshape-port`.
2. Make sure the program's group cannot write it; the board refuses a
   group-writable program that needs a confirmation, even a confirmed one:

   ```sh
   chmod g-w <checkout>/adapters/claude-agg/bin/agg-board.mjs
   ```

3. Create the agent's state directories in that home:

   ```sh
   mkdir -m 700 -p <home>/agg/inbox/handled <home>/agg/answers/handled <home>/agg/tags
   ```

4. Write `<home>/config/myshape-aggregator.json`, mode 0644, naming the
   program by its absolute path in the checkout the board runs from, as both
   feed and deliver:

   ```json
   {"v":1,"name":"claude-agg","feed":"<checkout>/adapters/claude-agg/bin/agg-board.mjs","deliver":"<checkout>/adapters/claude-agg/bin/agg-board.mjs"}
   ```

5. Open the board (`MYSHAPE_HOME=<home> <checkout>/bin/myshape.sh open`) and
   confirm the program on the page, in its two steps. The second step shows
   the full path and the program's SHA-256; check it against
   `sha256sum <checkout>/adapters/claude-agg/bin/agg-board.mjs`. One
   confirmation covers both roles.

Only the captain confirms, on the page. The agent never reads the board's
token, never calls the page's API and never writes the board's confirmation
record. After a `git pull` that changes `agg-board.mjs`, the board stops
running it and holds its writes until the captain confirms the new content.

`agg-board.mjs` must never be moved or copied into the repository's top-level
`bin/`: a tracked file there that matches HEAD runs without any confirmation.
CI fails when the top-level `bin/` holds anything but the board's own files.

Neither vendor list (`myshape/vendor-files`,
`adapters/firstmate/fm-board/vendor-files`) names this directory, so a
Firstmate fork that vendors this repository does not receive it. CI checks that
too.

## Running the checks

Node 22 or later and pnpm (CI uses the version locked in
`ci-tools/board-tests/`). From the repository root:

```sh
pnpm --dir adapters/claude-agg install --frozen-lockfile
pnpm --dir adapters/claude-agg run typecheck
pnpm --dir adapters/claude-agg run lint
pnpm --dir adapters/claude-agg run format:check
pnpm --dir adapters/claude-agg test
```

`typecheck` checks `bin/agg-board.mjs` too, from its JSDoc types
(`checkJs`); lint and format cover `src/` and `bin/`. The tests run the
program as a child process against scratch homes, and the supervisor with a
scripted `query()` and fake commands; `worktrees.sandbox.test.ts` runs real
git in sandbox repositories under its own temporary directory. The tests in
`src/board.integration.test.ts` and `src/worker-loop.integration.test.ts`
start a real board service in a scratch root and home on a free port, so they
run only when `CI` is set (GitHub's runner sets it) and are skipped otherwise.

The `Claude aggregator` job in `.github/workflows/tests.yml` runs the same
checks, plus the guards on the top-level `bin/`, the vendor lists and imports.
