# myshape

myshape is a local web board that groups ongoing agent work into topics. It
runs as a small Node service on `127.0.0.1`, keeps its own topic data, and shows
three priority queues, per-topic updates, the agents attached to each topic
and the decisions waiting for an answer. `bin/myshape.sh` is its command; the
page in the browser talks to the same service.

The board does not know how the work is run. The tasks, updates and decisions
it shows come from an *aggregator*: the agent on the other side that reports
the work and receives the actions taken on the page.

## The aggregator contract

An aggregator connects to the board through two programs named in the home's
`config/myshape-aggregator.json`:

```json
{"v": 1, "name": "<name>", "feed": "<path>", "deliver": "<path>"}
```

- **Binding v1** (`"v": 1`): the file names the aggregator and the paths of its
  two programs, and nothing else. The board adds the words `feed` and
  `deliver` itself and never passes arguments from the file.
- **Feed, schema 1**: `<feed> feed <home> <offset> <sha> ...` prints one report
  for a home as JSON with `"schema": 1`, or exits 4 with a one-line reason
  when that home cannot report.
- **Deliver**: `<deliver> deliver` reads one action record on stdin and answers
  with one result line.

The full contract, including which programs run without a confirmation on the
page, is in [`myshape/spec/contracts.markdown`](myshape/spec/contracts.markdown)
(sections 4 and 7). `myshape/test/stub-aggregator/` is a stand-in aggregator
written only from that contract.

## Layout

| Path | What it is |
| --- | --- |
| `bin/myshape.sh`, `bin/myshape-lib.sh` | The board's command |
| `myshape/` | The service, the page, the specs (`myshape/spec/`) and the tests |
| `ci-tools/board-tests/` | The locked versions of `pnpm` and `tasks-axi` that CI installs |
| `adapters/firstmate/` | One aggregator's adapter: the Firstmate side of the board |

`adapters/firstmate/` is the adapter for [Firstmate](https://github.com/guybeju/firstmate).
Its files keep their paths relative to a Firstmate checkout's root
(`adapters/firstmate/bin/fm-board.sh` is `bin/fm-board.sh` there), and its
specs are in `adapters/firstmate/fm-board/spec/` and
`adapters/firstmate/dispatch-plan/spec/`. It is not part of the board: the
board runs and is tested without it.

## Running the board's checks

The tools are Node 22 or later, `bash`, `git`, `jq` and `curl`; the page test
also needs `firefox` on `PATH`. From the repository root:

```sh
npm ci --ignore-scripts --prefix ci-tools/board-tests
export PATH="$PWD/ci-tools/board-tests/node_modules/.bin:$PATH"
(cd myshape && pnpm install --frozen-lockfile)

bash myshape/test/check-dist.sh    # dist/ is what src/ compiles to
pnpm --dir myshape test            # unit tests
pnpm --dir myshape run typecheck
pnpm --dir myshape run lint
pnpm --dir myshape run format:check
myshape/test/run.sh                # the board's suites
```

A suite prints `skip:` and exits 0 when a tool it needs is missing; CI treats
any `skip:` line as a failure. The adapter's suites
(`fm-board/test/run.sh`, `dispatch-plan/test/run.sh`) run inside a Firstmate
checkout with this repository's files laid over its root; the workflow in
`.github/workflows/tests.yml` shows how.

## Provenance

This repository starts from
[guybeju/firstmate@763b758b](https://github.com/guybeju/firstmate/tree/763b758ba65ccf0d5d766690c7195c8b39602a29):
the import commit takes the board and its adapter from that commit without
changing a byte. Their history before the import is in the fork's
[commit history](https://github.com/guybeju/firstmate/commits/763b758ba65ccf0d5d766690c7195c8b39602a29).
References such as `guybeju/firstmate#29` in the specs point at that
repository's issues and pull requests.

## Licence

MIT; see [`LICENSE`](LICENSE).
