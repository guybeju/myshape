import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { AGENT_NAME } from "#agg/agent-name.js";
import { PACKAGE_DIR } from "#agg/test-home.js";

import { NEVER_APPROVED, NEVER_APPROVED_CONSTRUCTS } from "./guard.js";
import {
  checkPlugin,
  checkPluginPlace,
  missingFromInit,
  PLUGIN_DIR,
  PLUGIN_FILES,
  PLUGIN_NAME,
  PluginError,
  STATUS_SKILL,
  WORKER_SKILL,
} from "./plugin.js";
import type { InitMessage } from "./sdk.js";

const scratch = mkdtempSync(join(tmpdir(), "cagg-plugin-test-"));
let copies = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of the real plugin in the scratch directory, to break one way. */
function copy(): string {
  copies += 1;
  const dir = join(scratch, `plugin-${copies}`);
  cpSync(PLUGIN_DIR, dir, { recursive: true });
  return dir;
}

function put(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const WORKER_FILE = "skills/claude-agg-worker/SKILL.md";
const MANIFEST = ".claude-plugin/plugin.json";

function refusal(dir: string): string {
  try {
    checkPlugin(dir);
  } catch (error) {
    expect(error).toBeInstanceOf(PluginError);
    return (error as Error).message;
  }
  throw new Error(`checkPlugin took ${dir}`);
}

/** Every file of the real plugin, relative to it. */
function realFiles(dir = PLUGIN_DIR, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? realFiles(dir, path) : [path];
  });
}

describe("the plugin in this checkout", () => {
  it("is adapters/claude-agg/plugin/, named as the aggregator", () => {
    expect(PLUGIN_DIR).toBe(join(PACKAGE_DIR, "plugin"));
    expect(PLUGIN_NAME).toBe(AGENT_NAME);
    expect(WORKER_SKILL).toBe("claude-agg:claude-agg-worker");
    expect(STATUS_SKILL).toBe("claude-agg:claude-agg-status");
  });

  it("passes the start check, which resolves it", () => {
    expect(checkPlugin(PLUGIN_DIR)).toBe(realpathSync(PLUGIN_DIR));
  });

  it("declares no hooks, MCP servers, agents or commands: a manifest and two skills only", () => {
    expect(realFiles().toSorted()).toEqual([...PLUGIN_FILES].toSorted());
    for (const file of realFiles()) {
      expect(file).not.toMatch(/^(hooks|agents|commands|bin|output-styles)\//);
      expect(file).not.toMatch(/(^|\/)(\.mcp\.json|\.lsp\.json|hooks\.json|settings\.json)$/);
    }
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, MANIFEST), "utf8")) as object;
    expect(Object.keys(manifest).toSorted()).toEqual(["description", "name"]);
    for (const file of PLUGIN_FILES.filter((path) => path.endsWith("SKILL.md"))) {
      const text = readFileSync(join(PLUGIN_DIR, file), "utf8");
      const head = text.split("\n---\n")[0] ?? "";
      expect(head).not.toMatch(/^(allowed-tools|hooks|model|agent|context|shell):/m);
      expect(text).not.toMatch(/!`|`!/);
    }
  });

  it("gives the worker every Bash shape the guard never approves", () => {
    const text = readFileSync(join(PLUGIN_DIR, WORKER_FILE), "utf8");
    for (const word of [...NEVER_APPROVED, ...NEVER_APPROVED_CONSTRUCTS, "<<", "&"]) {
      expect(text, word).toContain(`\`${word}\``);
    }
    for (const tool of ["push_branch", "open_pr", "myshape.sh", "dangerouslyDisableSandbox"]) {
      expect(text, tool).toContain(tool);
    }
  });
});

describe("checkPlugin", () => {
  it.each([
    ["a hooks file", "hooks/hooks.json", '{"hooks": {}}'],
    ["an MCP server file", ".mcp.json", '{"mcpServers": {}}'],
    ["an agent", "agents/helper.md", "---\nname: helper\n---\n"],
    ["a command", "commands/go.md", "go\n"],
    ["a program", "bin/tool", "#!/bin/sh\n"],
    ["plugin settings", "settings.json", "{}"],
    ["a third skill", "skills/other/SKILL.md", "---\nname: other\ndescription: d\n---\n"],
    ["a skill's extra file", "skills/claude-agg-worker/run.sh", "echo\n"],
  ])("refuses %s", (_what, file, text) => {
    const dir = copy();
    put(dir, file, text);
    expect(refusal(dir)).toContain(`${file} not allowed`);
  });

  it.each(["hooks", "mcpServers", "agents", "commands", "lspServers", "outputStyles", "skills"])(
    "refuses a manifest that declares %s",
    (key) => {
      const dir = copy();
      put(dir, MANIFEST, JSON.stringify({ name: PLUGIN_NAME, [key]: "./x" }));
      expect(refusal(dir)).toContain(`${MANIFEST} declares ${key}`);
    },
  );

  it.each([
    ["not JSON", "{", "is not JSON"],
    ["an array", "[]", "is not a JSON object"],
    ["null", "null", "is not a JSON object"],
    ["another name", '{"name": "other"}', "must name the plugin claude-agg"],
  ])("refuses a manifest that is %s", (_what, text, problem) => {
    const dir = copy();
    put(dir, MANIFEST, text);
    expect(refusal(dir)).toContain(problem);
  });

  it.each(["allowed-tools: Bash", "hooks: x", "model: opus", "context: fork"])(
    "refuses a skill whose frontmatter declares %s",
    (line) => {
      const dir = copy();
      put(dir, WORKER_FILE, `---\nname: claude-agg-worker\ndescription: d\n${line}\n---\nbody\n`);
      expect(refusal(dir)).toContain(`${WORKER_FILE} declares ${line.split(":")[0]}`);
    },
  );

  it.each([
    ["an inline command", "Run !`id` now.\n"],
    ["a fenced command block", "```!\nid\n```\n"],
  ])("refuses a skill that holds %s", (_what, body) => {
    const dir = copy();
    put(dir, WORKER_FILE, `---\nname: claude-agg-worker\ndescription: d\n---\n${body}`);
    expect(refusal(dir)).toContain("holds a shell command");
  });

  it.each([
    ["no frontmatter", "# rules\n", "has no frontmatter"],
    ["another name", "---\nname: other\ndescription: d\n---\n", "must be named claude-agg-worker"],
    ["no description", "---\nname: claude-agg-worker\n---\n", "has no description"],
    ["a line it cannot read", "---\nname: claude-agg-worker\n  more\n---\n", "cannot read"],
  ])("refuses a skill with %s", (_what, text, problem) => {
    const dir = copy();
    put(dir, WORKER_FILE, text);
    expect(refusal(dir)).toContain(problem);
  });

  it("refuses a missing skill", () => {
    const dir = copy();
    rmSync(join(dir, "skills", "claude-agg-status"), { recursive: true });
    expect(refusal(dir)).toContain("skills/claude-agg-status/SKILL.md missing");
  });

  it("refuses a plugin directory that is a link, and a link inside it", () => {
    const link = join(scratch, "linked-plugin");
    symlinkSync(copy(), link);
    expect(refusal(link)).toContain("is a symbolic link");
    const dir = copy();
    rmSync(join(dir, WORKER_FILE));
    symlinkSync(join(PLUGIN_DIR, WORKER_FILE), join(dir, WORKER_FILE));
    expect(refusal(dir)).toContain(`${WORKER_FILE} is not a regular file or directory`);
  });

  it("refuses a missing path and a file", () => {
    expect(refusal(join(scratch, "nowhere"))).toContain("cannot read");
    expect(refusal(join(copy(), MANIFEST))).toContain("is not a directory");
  });

  it("resolves the links above the directory", () => {
    const parent = join(scratch, "parent-link");
    symlinkSync(scratch, parent);
    const dir = copy();
    const through = join(parent, dir.slice(scratch.length + 1));
    expect(checkPlugin(through)).toBe(realpathSync(dir));
  });
});

describe("checkPluginPlace", () => {
  const places = [
    ["the board home", "/srv/home"],
    ["the worktree root", "/work"],
    ["repo app", "/repos/app"],
  ] as const;

  it("takes a plugin outside every place", () => {
    expect(() => checkPluginPlace("/opt/claude-agg/plugin", places)).not.toThrow();
    expect(() => checkPluginPlace("/repos/app-other/plugin", places)).not.toThrow();
  });

  it.each([
    ["inside a worktree", "/work/t-1/adapters/claude-agg/plugin", "the worktree root"],
    ["in the repository a worker works on", "/repos/app/adapters/claude-agg/plugin", "repo app"],
    ["in the board home", "/srv/home/plugin", "the board home"],
    ["the worktree root itself", "/work", "the worktree root"],
    ["above a place", "/repos", "repo app"],
  ])("refuses a plugin %s", (_what, plugin, place) => {
    expect(() => checkPluginPlace(plugin, places)).toThrow(`must lie outside ${place}`);
  });

  it("refuses any plugin when a place is the root directory", () => {
    expect(() => checkPluginPlace("/opt/plugin", [["the worktree root", "/"]])).toThrow(
      PluginError,
    );
  });
});

describe("missingFromInit", () => {
  const PATH = "/opt/claude-agg/plugin";
  function started(fields: Partial<InitMessage> = {}): InitMessage {
    return {
      type: "system",
      subtype: "init",
      session_id: "s",
      permissionMode: "default",
      apiKeySource: "none",
      plugins: [{ name: PLUGIN_NAME, path: PATH }],
      skills: [WORKER_SKILL, STATUS_SKILL],
      pluginErrors: [],
      ...fields,
    };
  }

  it("finds nothing missing when the plugin and both skills are listed", () => {
    expect(missingFromInit(started(), PATH)).toEqual([]);
  });

  it("wants the plugin at the path the supervisor resolved, not only its name", () => {
    expect(missingFromInit(started({ plugins: [] }), PATH)).toEqual([
      `plugin claude-agg（${PATH}）`,
    ]);
    const elsewhere = { plugins: [{ name: PLUGIN_NAME, path: "/repos/app/.claude/plugin" }] };
    expect(missingFromInit(started(elsewhere), PATH)).toEqual([`plugin claude-agg（${PATH}）`]);
    const renamed = { plugins: [{ name: "other", path: PATH }] };
    expect(missingFromInit(started(renamed), PATH)).toHaveLength(1);
  });

  it("wants each skill by its full name, not a bare one", () => {
    const bare = { skills: ["claude-agg-worker", "claude-agg-status"] };
    expect(missingFromInit(started(bare), PATH)).toEqual([
      `skill ${WORKER_SKILL}`,
      `skill ${STATUS_SKILL}`,
    ]);
    expect(missingFromInit(started({ skills: [WORKER_SKILL] }), PATH)).toEqual([
      `skill ${STATUS_SKILL}`,
    ]);
  });

  it("counts the plugin's load errors, by path or by name, and no other plugin's", () => {
    const pluginErrors = [
      { plugin: "inline[0]", type: "path-not-found", path: PATH },
      { plugin: "claude-agg", type: "hook-load-failed" },
      { plugin: "claude-agg@inline", type: "generic-error" },
      { plugin: "other@market", type: "dependency-unsatisfied", path: "/x" },
      { plugin: "claude-aggregate", type: "generic-error" },
    ];
    expect(missingFromInit(started({ pluginErrors }), PATH)).toEqual([
      "載入錯誤 path-not-found",
      "載入錯誤 hook-load-failed",
      "載入錯誤 generic-error",
    ]);
  });

  it("keeps only word characters of an error's type", () => {
    const pluginErrors = [{ plugin: "claude-agg", type: "bad‮ type\n<x>" }];
    expect(missingFromInit(started({ pluginErrors }), PATH)).toEqual(["載入錯誤 badtypex"]);
  });
});
