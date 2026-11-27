import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { denyReason, preToolUseInput } from "./harness.test-helper.js";

import {
  existingRealPath,
  guardToolUse,
  preToolUseHook,
  sandboxApprovable,
  REASONS,
  type GuardContext,
} from "./guard.js";

const HOME = "/srv/agg-home";
const CWD = "/work/claude-agg/t-1";
const CTX: GuardContext = {
  home: HOME,
  port: 47_829,
  defaultBranch: "main",
  realPath: (path) => path,
  userHome: "/srv",
  approvesSandboxedBash: true,
};

function bash(command: string, ctx = CTX) {
  return guardToolUse("Bash", { command }, CWD, ctx);
}

const denied = (reason: string) => ({ allow: false, reason });

describe("myshape.sh", () => {
  it.each([
    "bin/myshape.sh summary t-1 ready -",
    "/checkout/bin/myshape.sh list",
    "bash my'shape'.sh status",
    'x=1; "myshape.sh" open',
    "myshape-lib.sh",
  ])("refuses %s", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.board));
  });
});

describe("the board home", () => {
  it.each([
    ["Read", { file_path: `${HOME}/state/myshape/token` }],
    ["Read", { file_path: `${HOME}/agg/tasks.json` }],
    ["Edit", { file_path: `${HOME}/data/topics.json` }],
    ["Write", { file_path: `${HOME}/agg/inbox/x.json` }],
    ["MultiEdit", { file_path: `${HOME}/x` }],
    ["NotebookEdit", { notebook_path: `${HOME}/n.ipynb` }],
    ["Grep", { pattern: "token", path: HOME }],
    ["Glob", { pattern: `${HOME}/**/*.json` }],
    ["Glob", { pattern: "../../../../srv/agg-home/**/*.json" }],
    ["Glob", { pattern: "agg-home/**", path: "/srv" }],
    ["LS", { path: `${HOME}/state` }],
    ["Read", { file_path: `../../../../srv/agg-home/state/myshape/token` }],
  ])("refuses %s %j", (tool, input) => {
    expect(guardToolUse(tool, input, CWD, CTX)).toEqual(denied(REASONS.home));
  });

  it("refuses a path that reaches the home through a symbolic link", () => {
    const ctx = { ...CTX, realPath: (path: string) => path.replace(`${CWD}/link`, HOME) };
    expect(guardToolUse("Read", { file_path: "link/state/myshape/token" }, CWD, ctx)).toEqual(
      denied(REASONS.home),
    );
  });

  it("refuses every tool when the session's own directory is in the home", () => {
    expect(guardToolUse("Read", { file_path: "a" }, `${HOME}/agg`, CTX)).toEqual(
      denied(REASONS.home),
    );
  });

  it.each([
    `cat ${HOME}/state/myshape/token`,
    "cat state/myshape/token",
    "MYSHAPE_HOME=/elsewhere ls",
    `cd ${HOME} && ls`,
  ])("refuses the command %s", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.home));
  });

  it("allows a home whose name only starts the same", () => {
    expect(guardToolUse("Read", { file_path: `${HOME}-other/x` }, CWD, CTX)).toEqual({
      allow: true,
    });
  });
});

describe("merging", () => {
  it.each([
    "gh pr \\\n  merge 7",
    "gh pr merge 7 --merge",
    "gh  pr   merge --squash",
    "gh api -X PUT repos/o/r/pulls/7/merge",
  ])("refuses %s", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.merge));
  });
});

describe("pushes", () => {
  it.each([
    "git push origin main",
    "git push -u origin main",
    "git push origin HEAD:main",
    "git push origin +main",
    "git push origin refs/heads/main",
    "git push origin agg/t-1:main",
    "git push origin agg/t-1:refs/heads/main",
    "git push --all origin",
    "git push --mirror origin",
    "git -C /work/x push origin main",
    "npm test && git push origin main",
    "git push origin agg/t-1 main",
    "git push origin :main",
    "git push origin x:HEAD",
    "git add -A\ngit push origin main",
    "git status\n  git push origin main",
    "git push origin \\\n  main",
    "git push origin refs/heads/*:refs/heads/*",
    "git push origin +agg/*",
  ])("refuses %s", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.pushDefault));
  });

  it.each(["git push", "git push origin", "git push origin HEAD", "git push -u origin"])(
    "refuses %s, which does not name its branch",
    (command) => {
      expect(bash(command)).toEqual(denied(REASONS.pushUnnamed));
    },
  );

  it("reads git anywhere in a command, so a wrapper cannot hide a push", () => {
    expect(bash("xargs git push origin main")).toEqual(denied(REASONS.pushDefault));
    expect(bash("echo git push")).toEqual(denied(REASONS.pushUnnamed));
  });

  it("follows the repository's own default branch", () => {
    const ctx = { ...CTX, defaultBranch: "trunk" };
    expect(bash("git push origin trunk", ctx)).toEqual(denied(REASONS.pushDefault));
    expect(bash("git push origin main", ctx)).toEqual({ allow: true });
  });

  it("refuses every push for a session that may push nothing", () => {
    expect(bash("git push origin agg/t-1", { ...CTX, defaultBranch: null })).toEqual(
      denied(REASONS.noPush),
    );
  });

  it.each([
    "git push origin agg/t-1",
    "git push -u origin agg/t-1",
    "git push origin HEAD:agg/t-1",
    "git commit -m push fixes",
    "git log --grep push",
  ])("allows %s", (command) => {
    expect(bash(command)).toEqual({ allow: true });
  });
});

describe("the board's port", () => {
  it.each(["curl http://127.0.0.1:47829/api/state", "curl localhost:47829", "wget [::1]:47829"])(
    "refuses %s",
    (command) => {
      expect(bash(command)).toEqual(denied(REASONS.port));
    },
  );

  it.each(["http://127.0.0.1:47829/api/programs/confirm", "http://localhost:47829/"])(
    "refuses WebFetch of %s",
    (url) => {
      expect(guardToolUse("WebFetch", { url }, CWD, CTX)).toEqual(denied(REASONS.port));
    },
  );

  it("allows other ports and hosts", () => {
    expect(bash("curl http://127.0.0.1:3000/")).toEqual({ allow: true });
    expect(bash("echo 478290")).toEqual({ allow: true });
    expect(guardToolUse("WebFetch", { url: "https://example.com/" }, CWD, CTX)).toEqual({
      allow: true,
    });
  });
});

describe("what it cannot read", () => {
  it.each([
    ["Bash", null],
    ["Bash", { command: 7 }],
    ["Read", { file_path: ["x"] }],
    ["WebFetch", { url: "not a url" }],
    ["WebFetch", {}],
  ])("refuses %s %j", (tool, input) => {
    expect(guardToolUse(tool, input, CWD, CTX)).toEqual(denied(REASONS.unreadable));
  });

  it("allows ordinary work", () => {
    expect(bash("npm test")).toEqual({ allow: true });
    expect(guardToolUse("Read", { file_path: "src/a.ts" }, CWD, CTX)).toEqual({ allow: true });
    expect(guardToolUse("TodoWrite", { todos: [] }, CWD, CTX)).toEqual({ allow: true });
  });
});

describe("the hook", () => {
  const hook = preToolUseHook(CTX);
  it("answers deny with the reason", async () => {
    const input = preToolUseInput("Bash", { command: "gh pr merge 1" }, CWD);
    expect(await hook(input, "u1")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: REASONS.merge,
      },
    });
  });

  it("approves a worker's sandbox-approvable Bash call, which runs in the sandbox", async () => {
    const input = preToolUseInput("Bash", { command: "npm test 2>&1 | tail -5" }, CWD);
    expect(await hook(input, "u1")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: REASONS.sandboxed,
      },
    });
  });

  it("gives no decision for a shape the sandbox auto-allow never covers", async () => {
    const input = preToolUseInput("Bash", { command: "env | sort" }, CWD);
    expect(await hook(input, "u1")).toEqual({});
  });

  it("gives no decision for Bash where it approves nothing (the planner), nor for other tools", async () => {
    const planner = preToolUseHook({ ...CTX, approvesSandboxedBash: false });
    expect(await planner(preToolUseInput("Bash", { command: "npm test" }, CWD), "u1")).toEqual({});
    expect(await hook(preToolUseInput("Read", { file_path: `${CWD}/a` }, CWD), "u1")).toEqual({});
  });

  it.each([true, "true"])("denies dangerouslyDisableSandbox %j, approving or not", async (flag) => {
    for (const ctx of [CTX, { ...CTX, approvesSandboxedBash: false }]) {
      const input = preToolUseInput(
        "Bash",
        { command: "ls", dangerouslyDisableSandbox: flag },
        CWD,
      );
      expect(denyReason(await preToolUseHook(ctx)(input, "u1"))).toBe(REASONS.unsandboxed);
    }
  });

  it("refuses a call whose cwd it cannot read", async () => {
    const input = preToolUseInput("Bash", { command: "ls" }, "relative");
    expect(denyReason(await hook(input, "u1"))).toBe(REASONS.unreadable);
  });

  it("ignores other events", async () => {
    const input = {
      ...preToolUseInput("Bash", { command: "gh pr merge 1" }, CWD),
      hook_event_name: "PostToolUse" as const,
      tool_response: "",
    };
    expect(await hook(input, undefined)).toEqual({});
  });
});

describe("a git subcommand written with $", () => {
  it.each([
    "git $'push' origin main",
    "git ${x:-push} origin main",
    "git -C . $'push' origin main",
  ])("is taken as a push: %s", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.pushDefault));
  });

  it("is refused outright where nothing may be pushed", () => {
    expect(bash("git $'push' origin agg/t-1", { ...CTX, defaultBranch: null })).toEqual(
      denied(REASONS.noPush),
    );
  });
});

describe("sandboxApprovable", () => {
  it.each([
    "npm test",
    "pnpm install --frozen-lockfile && pnpm test",
    "printenv | cut -d= -f1 | sort",
    "git add -A && git commit -qm 'fix the parser'",
    "curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/",
    "npm test 2>&1 | tee test.log",
    "cargo build >out.log 2>&1",
    "rm -rf node_modules dist/old",
    'echo "$HOME" > note.txt',
    "/usr/bin/git status",
    "if test -f package.json; then npm test; fi",
    "{ npm test; npm run lint; }",
    "! git diff --quiet",
    "while read line; do echo x; done < list.txt",
    "make test",
    "make -j4 all",
  ])("approves %s", (command) => {
    expect(sandboxApprovable(command)).toBe(true);
  });

  it.each([
    ["env first", "env | cut -d= -f1"],
    ["env after a pipe", "ls | env"],
    ["time", "time npm test"],
    ["nohup", "nohup npm start"],
    ["timeout", "timeout 10 npm test"],
    ["nice", "nice -n 5 make"],
    ["stdbuf", "stdbuf -oL npm test"],
    ["command", "command -v git"],
    ["builtin", "builtin cd .."],
    ["noglob", "noglob ls *"],
    ["eval", 'eval "ls"'],
    ["awk", "awk '{print $1}' file"],
    ["gawk by path", "/usr/bin/gawk 1 file"],
    ["a leading assignment", "FOO=bar npm test"],
    ["an assignment after &&", "cd app && CI=1 npm test"],
    ["a here-document", "git commit -F - <<EOF\nmsg\nEOF"],
    ["a here-string", "cat <<< hi"],
    ["${!…}", "echo ${!PATH}"],
    ["${ |…}", "echo ${ |x}"],
    ["/proc/…/environ", "cat /proc/1/environ"],
    ["/dev/tcp", "echo x > /dev/tcp/1.2.3.4/80"],
    ["command substitution", 'git commit -m "$(cat msg)"'],
    ["backticks", "echo `id`"],
    ["a background &", "npm start & sleep 1"],
    ["a trailing &", "npm start &"],
    ["rm of /", "rm -rf /"],
    ["rm of ~", "rm -rf ~"],
    ["rm of ..", "rm -rf ../x"],
    ["rm of .", "rm -rf ."],
    ["rm of *", "rm -rf *"],
    ["rm with a variable", "rm -rf $DIR"],
    ["rm with no operand", "rm -rf"],
    ["rmdir of an absolute path", "rmdir /tmp/x"],
    ["env inside if/then", "if true; then env curl x; fi"],
    ["eval after else", "if false; then ls; else eval ls; fi"],
    ["env after elif", "if false; then ls; elif true; then env x; fi"],
    ["env in a { } group", "{ env curl x; }"],
    ["env after !", "! env curl x"],
    ["eval in while/do", "while true; do eval ls; done"],
    ["eval in until/do", "until false; do eval ls; done"],
    ["an assignment after then", "if true; then CI=1 npm test; fi"],
    ["nested wrappers", "if true; then { ! while true; do env x; done; }; fi"],
    ["a wrapper after a pipe", "ls | { env x; }"],
    ["a case statement", "case x in x) ls;; esac"],
    ["a for loop", "for f in a b; do ls $f; done"],
    ["a select loop", "select x in a; do ls; done"],
    ["a function keyword", "function f { ls; }"],
    ["coproc", "coproc ls"],
    ["[[ test", "[[ -f x ]] && ls"],
    ["[[ after if", "if [[ -f x ]]; then ls; fi"],
    ["make with an assignment", "make CC=clang"],
    ["make with an assignment after a target", "make all CFLAGS=-O2"],
    ["make by path with an assignment", "/usr/bin/make CC=clang"],
    ["an ANSI-C quoted first word", "$'env' curl x"],
    ["a defaulted variable as first word", "${x:-env} curl x"],
    ["a variable as first word", "$CMD x"],
    ["a variable inside the first word", "/usr/bin/$TOOL x"],
    ["a variable first word after then", "if true; then $'eval' ls; fi"],
    ["a variable first word after a pipe", "ls | $'env' x"],
    ["git with a quoted subcommand", "git $'push' origin main"],
  ])("does not approve %s", (_what, command) => {
    expect(sandboxApprovable(command)).toBe(false);
  });
});

describe("existingRealPath", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-agg-guard-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves links in the part that exists and keeps the rest", () => {
    mkdirSync(join(dir, "home"));
    symlinkSync(join(dir, "home"), join(dir, "link"));
    expect(existingRealPath(join(dir, "link", "state", "token"))).toBe(
      join(dir, "home", "state", "token"),
    );
    expect(existingRealPath("/")).toBe("/");
  });
});

describe("the hardening of this step", () => {
  it.each([
    "cat ~/agg-home/agg/tasks.json",
    "cat $HOME/agg-home/agg/answers/t-1.json",
    'echo x > "${HOME}/agg-home/agg/answers/t-1.json"',
    "cd ~ && cat agg-home/agg/holds.json; cat ~/agg-home/x",
    "F=~/agg-home/agg/tasks.json",
  ])("refuses the board home spelled with ~ or $HOME: %s", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.home));
  });

  it("refuses a path tool given the board home with ~", () => {
    expect(guardToolUse("Read", { file_path: "~/agg-home/agg/tasks.json" }, CWD, CTX)).toEqual(
      denied(REASONS.home),
    );
  });

  it("lets ~ and $HOME elsewhere through", () => {
    expect(bash("cat ~/.gitconfig")).toEqual({ allow: true });
    expect(bash("ls $HOMEDIR/agg-home")).toEqual({ allow: true });
    expect(bash("git log --format=%an~1")).toEqual({ allow: true });
  });

  it.each(["git push origin @", "git push origin +@"])("refuses %s like HEAD", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.pushUnnamed));
  });

  it("refuses @ pushed onto the default branch", () => {
    expect(bash("git push origin @:main")).toEqual(denied(REASONS.pushDefault));
    expect(bash("git push origin @:agg/t-1")).toEqual({ allow: true });
  });

  it.each([
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
    "gh api graphql -F query=@m.graphql -f q=enablePullRequestAutoMerge",
    'gh api graphql -f query="mutation{mergeBranch(input:{}){clientMutationId}}"',
  ])("refuses a GraphQL merge: %s", (command) => {
    expect(bash(command)).toEqual(denied(REASONS.merge));
  });

  it("lets a GraphQL read through", () => {
    expect(bash("gh api graphql -f query='{ viewer { login } }'")).toEqual({ allow: true });
  });
});
