# claude-agg

claude-agg is an aggregator for the myshape board that is not Firstmate: a
Claude agent that reports its work to the board and takes the actions made on
the board's page. It is built against the board's contract only
([`myshape/spec/contracts.markdown`](../../myshape/spec/contracts.markdown),
sections 4 and 7). It imports nothing from `myshape/` or `adapters/firstmate/`,
and the board imports nothing from it.

It holds the program the board runs, `bin/agg-board.mjs`, the formats of the
agent's state files, the supervisor in `src/supervisor/` (below), built on the
Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, pinned in `package.json`),
and its entry point `bin/claude-agg-supervisor.mjs`, which whoever runs it
starts by hand in a terminal ([Running the supervisor](#running-the-supervisor)).
The tests pass a scripted double for the SDK's `query()`, so no test calls a
model unless the real-binary checks are switched on.

## The supervisor: `src/supervisor/`

It reads a board home's `data/topics.json`, `data/topics-archive.json`,
`data/myshape/hashtags.json` and `data/myshape/schedules.json`, computes the
order new work is handed out in (`dispatch-order.ts`), and then:

- **plans** each dispatchable topic that has no task with one read-only
  planner session (`Read`, `Grep`, `Glob`, no prompts) in an empty directory of
  its own, allowed to read only the listed repositories' main checkouts,
  keeping only tasks for those repositories;
- **dispatches** at most 2 sessions in all and 1 per topic (`scheduler.ts`);
  the rest wait in `queued.json` with the reason as `hold`. Nothing new starts
  for a topic in 待辦 or archived, and a running worker is never stopped;
- **claims** a task in `tasks.json` and its `tags/<task-id>` first, then takes
  it out of `queued.json`, then runs `git worktree add <root>/<task-id> -b
  agg/<task-id> <base>` in the repository's main checkout, with the worktree
  root outside the board home;
- **runs** one worker session per task with the options of
  `session-options.ts`: the `default` permission mode with no prompts (with
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, which it always is, Claude Code
  starts every session in `default` whatever is asked), so only what is
  listed runs: file edits and writes inside the worktree, the two forge
  tools, and Bash commands the sandbox runs (`autoAllowBashIfSandboxed`; no
  Bash allow rule). Everything else is denied, as are edits of the
  worktree's `.git`. Also the deny rules and the PreToolUse guard of
  `guard.ts`, the target repository's project settings from its main
  checkout, no MCP but its own, 200 turns, a structured output. It stops a
  session whose start message is not `default` or names another credential
  source than the settings select;
- **sandboxes** each worker: its Bash commands run in the SDK's sandbox
  (bubblewrap and socat on Linux; on macOS the system's own sandbox), which
  must start or the session does not (`failIfUnavailable`), with no
  unsandboxed retry. They reach only the npm, PyPI and crates registries
  (`github.com` and `api.github.com` are denied). They read nothing in the
  home directory, the other users' and mounted directories (`/home`,
  `/Users`, `/root`, `/Volumes`, `/mnt`, `/media`) or the shared temporary
  and log directories (`/tmp`, `/var/tmp`, `/dev/shm`, `/run/user`,
  `/var/log`; on macOS also `/private/tmp`, `/private/var/folders`,
  `/private/var/log`), except the worktree, the main checkout's `.git`, the
  settings' `readPaths` and the session's own temporary directory. The gh
  login, `~/.ssh`, Claude's own credentials, the credential file and the
  board home are denied by name too. They write only the worktree, the main
  checkout's shared `.git` (not its `hooks/` or `config`: the sandbox allows
  that for a linked worktree) and the session's own temporary directory,
  which the supervisor makes for each session alone (`/tmp/cagg-…`, its
  `TMPDIR` and `CLAUDE_CODE_TMPDIR`) and removes when the session ends. Its
  file tools cannot write outside the worktree
  (`blockWritesOutsideWorkingDirectories`), have no read allow rule, so a
  read outside the worktree waits for an approval nobody gives, and are
  denied the credential paths by name. It has no `WebFetch` or `WebSearch`,
  and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` takes the credential out of every
  command, hook and MCP server it starts;
- **pushes and opens PRs for the worker**: a ship worker has no forge
  credential and gets two tools, `push_branch` and `open_pr`, that the
  supervisor runs with its own login (`forge.ts`); there is no tool that
  merges. `push_branch` takes the default branch's tip from `git ls-remote`,
  fetches the worker's branch by name into a bare repository only the
  supervisor writes (`<worktree root>/.claude-agg-push/<repo>.git`), refuses
  unless the branch shares history with that tip and changes nothing under
  `.github/`, and pushes exactly the compared commit to `agg/<task>`. A refusal
  is the task's summary. A scout worker gets neither tool;
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
- **follows the board's schedules** (plan section 3.8, `occurrences.ts` and
  `schedule-step.ts`), reading each occurrence from `schedules.json` every
  pass and never working one out itself:
  - on `schedule.upcoming` it runs `schedule take <key> --note <line>` (on
    `schedule.due` too, when nothing took it yet), and from then on keeps one
    of the 2 places free for the occurrence: other work starts only while the
    sessions running plus the places kept stay under 2. Nothing running is
    stopped;
  - at the occurrence's time (its `at` in the file, since a taken occurrence
    gets no `schedule.due`) the planner plans from the topic's goal, and its
    tasks are dispatched though the topic stays in 待辦. Nothing starts for an
    occurrence before its time, nor for one whose schedule does not ring
    (paused, all paused, or waiting for the captain's enable);
  - once every task of the occurrence has ended it runs `schedule close <key>
    done --note <line>`; a planner that finds nothing to do closes it the same
    way. Queued work of an occurrence that ended before it started leaves the
    queue;
  - on `schedule.missed`, a `soft-rt` occurrence is made up once (unless the
    notice has expired); a `hard-rt` or `none` one gets a `report` summary
    saying it was missed, filed under the topic;
  - an occurrence's tasks are named after it (`<schedule>-at-<UTC>-<n>`, a
    make-up `<schedule>-at-<UTC>-makeup-<n>`, the missed report's carrier
    `<schedule>-at-<UTC>-missed`, at most 64 characters, with a long schedule
    id cut and a SHA-256 prefix added), so a restart finds which task works for
    which occurrence. The carrier is a summary-only id: it has a tag so the
    board files the report under the topic, but no task and no ledger line, and
    a repeated missed notice writes no second tag line or summary. A restart never takes an occurrence the file already says is
    taken, and starts and closes one it took before;
  - a topic with a schedule is never proposed closed;
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
agent creates no topic, and creates, edits, pauses, resumes, skips or deletes
no schedule: its only schedule commands are `take` and `close … done`.

The model is the user's setting, passed to every session unchanged; with no
setting, sessions get no model option.

This adapter uses an API key; the author uses a subscription token for own
use. The credential is read from a file only its owner can read
(`credential.ts`), goes only into the sessions' environment, as exactly one
name, and is taken out of every text the supervisor writes.

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

## Running the supervisor

It runs on Linux or macOS. On Linux the workers' sandbox needs bubblewrap and
socat installed (`sudo apt-get install bubblewrap socat` on Debian and
Ubuntu); without them no worker session starts.

1. Wire the program to a board home of its own (above).
2. Make an API key for the adapter and put it in a file only you can read,
   holding the one line `ANTHROPIC_API_KEY=<key>`:

   ```sh
   mkdir -m 700 -p ~/.config/claude-agg
   install -m 600 /dev/null ~/.config/claude-agg/key
   ```

   then write the line into it with an editor.
3. Write the settings file, mode 0600 (the supervisor refuses one that is a
   link or that anyone else can read or write):

   ```json
   {
     "v": 1,
     "home": "/home/<user>/agg-home",
     "worktreeRoot": "/home/<user>/claude-agg-work",
     "boardCommand": "<checkout>/bin/myshape.sh",
     "repos": {
       "app": {"path": "/home/<user>/src/app", "base": "origin/main", "defaultBranch": "main"}
     },
     "auth": "api-key",
     "credentialFile": "/home/<user>/.config/claude-agg/key",
     "readPaths": ["/home/<user>/.gitconfig"]
   }
   ```

   - `repos` are the only repositories workers work in (see the rule below).
     A worktree is added from `path` (the main checkout) at `base`; no worker
     may push `defaultBranch`.
   - `worktreeRoot` must exist and lie outside the board home.
   - `model` is optional: the model every session uses, passed as written.
     With none, sessions use the SDK's own default.
   - `readPaths` (optional) are absolute paths a worker's commands may read
     besides its worktree, such as a toolchain installed under the home
     directory or the git configuration that names its author. The
     supervisor refuses an entry that is your home directory or one above it,
     or that holds the credential file, the board home, `~/.config/gh`,
     `~/.ssh` or `~/.claude/.credentials.json`. Before you list
     `~/.gitconfig`, check that it holds no credential: no `[credential]`
     helper line, and no `url.*.insteadOf` with a token in it.
   - `credentialFile` is the absolute path of the credential file: a regular
     file (not a symbolic link), owned by you, mode 0600 or stricter, holding
     exactly one line `ANTHROPIC_API_KEY=<key>`, with nothing else in the file
     (a final newline is fine; no spaces around `=`, no quotes, no `export`).
     Anything else and the supervisor does not start, saying which line it
     wanted.
   - `auth` is `api-key`. The other mode the settings take,
     `subscription-token`, is the author's own use and is not described here.
4. Start it, from the repository root:

   ```sh
   pnpm --dir adapters/claude-agg install --frozen-lockfile
   pnpm --dir adapters/claude-agg run supervisor <path to the settings file>
   ```

   The `supervisor` script builds `src/` into `dist/` and runs
   `bin/claude-agg-supervisor.mjs`, which starts the board service if it is
   not running, takes the lock `<worktree root>/.claude-agg-supervisor.lock`
   (a second supervisor on the same root does not start), and runs a pass
   whenever the board's files or the agent's inbox change and at least once a
   minute. It logs to the terminal.
5. Stop it with Ctrl-C, or `kill <pid>` with the pid it printed (also in the
   lock file). It starts nothing more, aborts the sessions that run, gives
   the lock back and exits 0. A task whose worker was cut off is `paused` at
   the next start, its worktree and session kept. A second Ctrl-C while it
   stops ends it at once.

There is no service unit: it runs while its terminal does.

**Which repositories may be listed.** A worker session runs the hooks and
permission rules committed in its repository's main checkout
(`.claude/settings.json`, outside the sandbox, with your access), and GitHub
runs that repository's workflows on every branch the supervisor pushes for a
worker, on code the worker wrote. So list a repository only if:

- it is yours;
- you have read its main checkout's `.claude/`;
- every workflow that a push or a pull request triggers in it is read-only
  (its token's permissions are read) and uses no secrets;
- its main checkout's `.git/config` holds no credential (no token in a remote
  URL, no `http.extraheader`): a worker's commands can read that `.git`.

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
The schedule test in `worker-loop.integration.test.ts` waits for the board's
real clock (about three minutes): the captain's schedule is made through the
page's API, a few minutes ahead.

`src/supervisor/real-claude.test.ts` runs the bundled `claude` binary itself
(the sandbox starting, what a worker can and cannot reach, resume not loading
a worktree's `.claude/`), so it runs only when `AGG_REAL_CLAUDE=1` is set and
skips otherwise; see that file for what it needs.

The `Claude aggregator` job in `.github/workflows/tests.yml` runs the same
checks, plus the guards on the top-level `bin/`, the vendor lists and imports.
