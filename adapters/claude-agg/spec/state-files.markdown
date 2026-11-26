# claude-agg state files

claude-agg keeps its state in one directory, `$MYSHAPE_HOME/agg/`, beside the
board's own `data/`, `state/` and `config/` (which it never writes). Two
programs touch it:

- **the supervisor** (a later step), the only writer of `tasks.json`,
  `holds.json`, `queued.json` and `ledger.jsonl`, and the only one that moves
  files into `inbox/handled/` and `answers/handled/`;
- **`bin/agg-board.mjs`**, the program the board runs. Its `feed` and
  `topics` only read. Its `deliver` reads the four supervisor files and makes
  exactly three kinds of write: a new file in `inbox/`, a new file in
  `answers/`, and one appended line in `tags/<task-id>`.

So no file is rewritten by both programs. The TypeScript types for every
format below are in `src/state-files.ts`.

## Layout and permissions

| Path | Mode | Written by | Content |
| --- | --- | --- | --- |
| `agg/` | 0700 | supervisor (setup) | this directory |
| `agg/tasks.json` | 0600 | supervisor, whole file | the tasks it runs |
| `agg/holds.json` | 0600 | supervisor, whole file | decisions it waits on from the captain |
| `agg/queued.json` | 0600 | supervisor, whole file | planned tasks not started yet |
| `agg/ledger.jsonl` | 0600 | supervisor, append only | worker lifecycle events |
| `agg/inbox/` | 0700 | supervisor (setup) | one file per action the board delivered |
| `agg/inbox/handled/` | 0700 | supervisor | inbox files the supervisor has handled |
| `agg/answers/` | 0700 | supervisor (setup) | the captain's answer to an open hold, one per task |
| `agg/answers/handled/` | 0700 | supervisor | answers the supervisor has handed on |
| `agg/tags/` | 0700 | supervisor (setup) | one topic-tag file per task |
| `agg/tags/<task-id>` | 0600 | both, append only | the task's topic tags |

The supervisor creates the directories when it sets a home up. `deliver`
creates no directory: when one is missing it answers `retry`, and `feed` exits
4 with a one-line banner when `agg/` itself is missing.

Whole-file writes by the supervisor use a temporary file in the same
directory and a rename. `deliver` writes a new file as a temporary file named
`.tmp-<name>-<pid>` in the target directory, then links it to its final name,
which fails when that name exists (so nothing is ever overwritten), then
removes the temporary file. Ids never start with `.`, so a reader skips every
name that does.

## Names

- A **task id** is `[A-Za-z0-9_][A-Za-z0-9._-]*`, at most 128 characters: the
  board's task grammar, and safe as a file name.
- A **write id** (the `id` of an action record) has the same grammar, at most
  200 characters.
- The only **home** is `main`.

## `tasks.json`

```json
{"v": 1, "tasks": {
  "billing-1": {"kind": "ship", "state": "working", "detail": "running the tests", "unstarted": false,
                "title": "Move billing", "repo": "owner/name", "session_id": "…", "worktree": "/…/billing-1",
                "branch": "agg/billing-1", "pr_url": null, "cost_usd_estimate": 0.42}
}}
```

- The key is the task id. `kind` is a non-empty word other than `secondmate`
  (the board reserves it); `ship` for a task that opens a pull request, so
  the board's rule for a cleaned-up `ship` task applies. `state` is one of
  `working`, `paused`, `blocked`, `failed`, `done` (the board shows any other
  word as unknown). `detail` (default `""`) and `unstarted` (default `false`)
  go to the board as they are.
- `done` and `failed` mean the worker has ended: `direct` refuses them. Every
  other state, and `unstarted`, takes a `direct` message for the supervisor
  to pass on.
- `title`, `repo`, `session_id`, `worktree`, `branch`, `pr_url` and
  `cost_usd_estimate` are the supervisor's; the board program never reads
  them and never reports them.

## `holds.json`

```json
{"v": 1, "holds": {
  "billing-1": {"state": "open", "title": "Which cache?", "question": "Keep the old cache?\n選項：A | B",
                "on_answer": "release", "hold_set": "2026-11-27T01:00:00Z", "origin": "",
                "hold_bucket": "live", "hold_until": null, "unresolved_blocker_ids": []}
}}
```

- The key is the id of the task the hold stops, so the board shows that
  task's light as waiting for the captain. One task has at most one hold at a
  time.
- `state` is `open` or `closed`. `question` is the full text; its last line is
  `選項：A | B` when there are options. `on_answer` is `close` (a question
  only) or `release` (it stops work). `hold_set` is the UTC ISO time it opened.
  `origin` (default `""`), `hold_bucket` (default `live`), `hold_until`
  (default `null`) and `unresolved_blocker_ids` (default `[]`) go to the board
  as they are.
- The board shows an open hold until an answer to that very question is in
  `answers/`.

## `queued.json`

```json
{"v": 1, "queued": [
  {"id": "billing-2", "kind": "ship", "title": "Second step", "hold": "等空位（2/2）",
   "captain": false, "blockers": [], "topic_hint": "billing"}
]}
```

The array order is the dispatch order. Each entry goes to the board's
`queued[]` with exactly these seven fields; `hold` (default `null`), `captain`
(default `false`), `blockers` (default `[]`) and `topic_hint` (default
`null`) may be left out. Other fields are the supervisor's.

## `ledger.jsonl`

One JSON object per line, each line ending in `\n`, appended in one write:
`{"v":1,"ts":<epoch seconds>,"event":"task.dispatched","task":"billing-1",…}`
with the events the board knows (`task.dispatched`, `task.status` with
`state` and `text`, `task.pr_ready`, `task.merged` with `pr`,
`task.cleaned_up`). `feed` hands the lines to the board unchanged, from a
byte offset with the SHA-256 of every byte before it as the cursor, at most
256 KiB of whole lines per call (`more: true` when there is more). A line
still being written (no `\n` yet) waits for the next call.

## `inbox/<write-id>.json`

```json
{"v": 1, "received_ms": 1795710460123, "record": {"v": 1, "id": "w-…", "attempt": 0, "kind": "message", …}}
```

One file per action the board delivered (`message`, `notice`, `direct`,
`answer`, `tag`), named by its write id: `record` is the action record as
the board sent it and `received_ms` is when `deliver` landed it, so the
supervisor handles the files in `received_ms` order. A write id already in
`inbox/` or `inbox/handled/` has landed: delivering it again changes nothing.
The supervisor moves a file into `inbox/handled/` under the same name once it
has handled it.

## `answers/<task-id>.json`

The same shape as an inbox file, with an `answer` record. It is the captain's
answer to the task's open hold whose question has the SHA-256
`record.question_sha256`. When the supervisor has passed the answer on, it
marks the hold `closed` in `holds.json` and moves the file into
`answers/handled/` (under `<task-id>.<write-id>.json`), so the task can be
held again. While an answer to an older question is still in `answers/`,
`deliver` answers `retry` to an answer for the new one.

## `tags/<task-id>`

Append only. Each line is `<topic id> <UTC ISO time>` and ends in `\n`; the
last line is the task's topic now (the board's topic-tag format). The
supervisor writes the first line when it makes the task; `deliver` appends a
line when the captain files the task under another topic on the page. `feed`
reports every file here, so ended tasks keep their topic.

## Stability

These formats hold while `v` is 1. A reader ignores fields it does not know.
Changing what a listed field means, or removing one, is a new `v`.
