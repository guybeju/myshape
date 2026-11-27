---
name: claude-agg-status
description: Show what the claude-agg supervisor is doing (its tasks, the questions waiting for you, the queue, recent events, whether it runs) and explain how to pause and resume it. Read-only. Pass the path of the supervisor's settings file.
---

# claude-agg status

The person asking runs claude-agg, the aggregator that works on topics of
their myshape board. Tell them, in their own language and in plain words,
what it is doing and what, if anything, waits for them. This skill only
reads: write, move or delete no file, and run no command that changes
anything. To pause or resume, tell them the command and let them run it.

## Find the files

The argument is the supervisor's settings file (the JSON file its start
command names). If there is no argument, ask for that path. Read the file
and take two absolute paths from it:

- `home`: the board home. The supervisor's state is in `<home>/agg/`.
- `worktreeRoot`: the directory the tasks' git worktrees are made in.

Do not open the file that the settings' `credentialFile` names: it holds the
key or token.

## Read the state

Read each file that exists; a missing one means that part is empty.

- `<worktreeRoot>/.claude-agg-supervisor.lock`: one line, the pid of the
  supervisor while it runs. Check it with `ps -p <pid>`. A lock whose pid is
  not running was left by a supervisor that did not stop cleanly; the next
  start takes it over.
- `<home>/agg/tasks.json`: `{"v": 1, "tasks": {<task id>: {...}}}`. For each
  task, `state` (`working`, `paused`, `blocked`, `failed` or `done`),
  `detail`, `title`, `repo`, `pr_url` and `cost_usd_estimate` (an estimate in
  US dollars, not a bill).
- `<home>/agg/holds.json`: `{"v": 1, "holds": {<task id>: {...}}}`. An entry
  with `state` `open` is a question waiting for the user: its `title` and
  `question`, whose last line lists the options as `選項：A | B`.
- `<home>/agg/queued.json`: `{"v": 1, "queued": [...]}`, planned tasks not
  started yet, in the order they start; `hold` says why each one waits.
- `<home>/agg/ledger.jsonl`: one JSON event per line. The last 20 lines are
  enough: `task.dispatched`, `task.status` (with `state` and `text`),
  `task.pr_ready`, `task.merged`, `task.cleaned_up`; `ts` is in epoch
  seconds.

## Report

Lead with whether the supervisor runs. Then, in this order: questions
waiting for the user, tasks that are `blocked` or `failed` and why, tasks
`working` or `paused`, queued tasks, pull requests ready for review
(`pr_url`), and finished tasks only as a count. Quote task ids so they can
be found on the board.

## What the user does on the board

Everything the supervisor asks for is answered on the board's page, not in
these files:

- A question waiting for them: answer it on the page; the worker carries on
  with the answer.
- A step only they can do (a login, sudo): it is listed on the page; mark it
  done there, and the worker checks it.
- A `paused` task: after a restart, a task whose worker was cut off waits.
  Writing to that task on the page resumes its worker; otherwise it stays
  paused.
- A task paused because the account's usage limit or rate limit ran out
  resumes by itself once the limit clears, or when they answer its question
  on the page.
- A pull request: they review and merge it themselves; the supervisor never
  merges.

## Pause and resume

There is no pause switch in these files. Pausing is stopping the
supervisor:

- In the terminal it runs in, press Ctrl-C; or run `kill <pid>` with the pid
  from the lock file.
- It starts no new work, stops the sessions that run, gives the lock back
  and exits. Tasks it cut off are `paused` the next time it starts, with
  their worktrees and sessions kept.
- To resume, start it again with the same command it was started with,
  from the root of the myshape checkout it runs from:
  `pnpm --dir adapters/claude-agg run supervisor <settings file>`.

To stop one topic from getting new work without stopping the supervisor,
move the topic to 待辦 (to do) or archive it on the board: no new task starts
for it, and a worker already running on it is not stopped.
