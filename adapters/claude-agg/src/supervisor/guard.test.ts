import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  existingRealPath,
  guardToolUse,
  preToolUseHook,
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
  const signal = new AbortController().signal;

  it("answers deny with the reason", async () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 1" },
      cwd: CWD,
      session_id: "s",
    };
    expect(await hook(input, "u1", { signal })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: REASONS.merge,
      },
    });
  });

  it("gives no decision for an allowed call, so the permission mode decides", async () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      cwd: CWD,
      session_id: "s",
    };
    expect(await hook(input, "u1", { signal })).toEqual({});
  });

  it("refuses a call whose cwd it cannot read", async () => {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: "relative",
    };
    expect((await hook(input, "u1", { signal })).hookSpecificOutput?.permissionDecisionReason).toBe(
      REASONS.unreadable,
    );
  });

  it("ignores other events", async () => {
    expect(await hook({ hook_event_name: "PostToolUse" }, undefined, { signal })).toEqual({});
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
