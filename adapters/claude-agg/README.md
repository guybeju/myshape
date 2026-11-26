# claude-agg

claude-agg is an aggregator for the myshape board that is not Firstmate: a
Claude agent that reports its work to the board and takes the actions made on
the board's page. It is built against the board's contract only
([`myshape/spec/contracts.markdown`](../../myshape/spec/contracts.markdown),
sections 4 and 7). It imports nothing from `myshape/` or `adapters/firstmate/`,
and the board imports nothing from it.

This directory is a skeleton for now: it holds the package, its checks, and the
start of the supervisor in `src/supervisor/`, which reads a board home's
`data/topics.json`, `data/topics-archive.json`, `data/myshape/hashtags.json`
and `data/myshape/schedules.json` and computes the order new work is handed out
in (`dispatch-order.ts`). Nothing in it runs yet: no program here starts a
worker, calls a model or writes to the board.

## What the board will run

The board will run one program from here, `bin/agg-board.mjs` (not written yet),
named as its feed and deliver in the home's `config/myshape-aggregator.json`.
Because it lives outside the repository's top-level `bin/`, the board runs it
only after it has been confirmed on the board's page, and asks again whenever
its content changes (contract section 7).

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

The `Claude aggregator` job in `.github/workflows/tests.yml` runs the same
checks, plus the guards on the top-level `bin/`, the vendor lists and imports.
