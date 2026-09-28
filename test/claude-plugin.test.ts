import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGrokHook } from "../src/grok-hook.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-steering-claude-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixtureWorkspace(): Promise<{ home: string; workspace: string; pluginData: string }> {
  const root = await makeTemporaryDirectory();
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const pluginData = join(root, "plugin-data");
  await mkdir(join(home, ".kiro/steering"), { recursive: true });
  await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
  await writeFile(join(home, ".kiro/steering/global.md"), "Global body");
  await writeFile(
    join(workspace, ".kiro/steering/react.md"),
    '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\nReact body',
  );
  return { home, workspace, pluginData };
}

function runCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  const child = spawn("bash", ["-c", command], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (code) => {
    resolve({ code: code ?? 1, stdout, stderr });
  });
  child.stdin.write(stdin);
  child.stdin.end();
  return promise;
}

describe("Claude plugin package", () => {
  it("keeps the Claude manifest on the package version and points the marketplace at this repo", async () => {
    const root = join(import.meta.dir, "..");
    const npm = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const claude = JSON.parse(await readFile(join(root, ".claude-plugin/plugin.json"), "utf8")) as {
      name: string;
      version: string;
      hooks?: string;
      skills?: string;
    };
    expect(claude.name).toBe("omp-steering");
    expect(claude.version).toBe(npm.version);
    expect(claude.hooks).toBeUndefined();
    expect(claude.skills).toBeUndefined();

    const marketplace = JSON.parse(await readFile(join(root, ".claude-plugin/marketplace.json"), "utf8")) as {
      name: string;
      plugins: Array<{ name: string; source: string; description: string }>;
    };
    expect(marketplace.name).toBe("omp-steering");
    expect(marketplace.plugins).toEqual([
      {
        name: "omp-steering",
        source: "./",
        description: "Load Kiro steering files (always, fileMatch, manual, auto) into Claude Code.",
      },
    ]);
  });

  it("runs the shared hook command from CLAUDE_PLUGIN_ROOT when GROK_PLUGIN_ROOT is unset", async () => {
    const { home, workspace } = await fixtureWorkspace();
    const root = join(import.meta.dir, "..");
    const hooks = JSON.parse(await readFile(join(root, "hooks/hooks.json"), "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = hooks.hooks.SessionStart[0]?.hooks[0]?.command;
    const pluginRootCommand = 'bash "' + "$" + "{GROK_PLUGIN_ROOT:-" + "$" + '{CLAUDE_PLUGIN_ROOT}}/hooks/run.sh"';
    expect(command).toBe(pluginRootCommand);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: root };
    delete env.GROK_PLUGIN_ROOT;
    const result = await runCommand(
      command ?? "",
      env,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: workspace, session_id: "claude-runner" }),
    );
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      additionalContext?: string;
      hookSpecificOutput?: { hookEventName?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(parsed.additionalContext).toContain("Global body");
  });

  it("prefers GROK_PLUGIN_ROOT when both plugin roots are set", async () => {
    const { home, workspace } = await fixtureWorkspace();
    const root = join(import.meta.dir, "..");
    const missing = await makeTemporaryDirectory();
    const hooks = JSON.parse(await readFile(join(root, "hooks/hooks.json"), "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = hooks.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    const result = await runCommand(
      command,
      { ...process.env, HOME: home, GROK_PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: missing },
      JSON.stringify({ hook_event_name: "SessionStart", cwd: workspace, session_id: "grok-wins" }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).additionalContext).toContain("Global body");
  });

  it("passes claude plugin validate when claude is on PATH", () => {
    const claude = Bun.which("claude");
    if (claude === null) return;

    const result = Bun.spawnSync([claude, "plugin", "validate", "--strict", join(import.meta.dir, "..")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode, output).toBe(0);
  });
});

describe("Claude hook events", () => {
  it("denies the first NotebookEdit on a matching path and records Claude's permission fields", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const deny = await handleGrokHook(
      {
        hook_event_name: "PreToolUse",
        cwd: workspace,
        session_id: "claude-edit",
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "src/Button.tsx" },
      },
      { homeDir: home, pluginData },
    );

    expect(deny?.decision).toBe("deny");
    expect(deny?.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(deny?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(deny?.hookSpecificOutput?.permissionDecisionReason).toContain("React body");
    expect(deny?.hookSpecificOutput?.permissionDecisionReason).toContain("Retry this mutation");
  });

  it("stores session state under CLAUDE_PLUGIN_DATA when Grok plugin data is unset", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const previousClaude = process.env.CLAUDE_PLUGIN_DATA;
    const previousGrok = process.env.GROK_PLUGIN_DATA;
    delete process.env.GROK_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = pluginData;
    try {
      await handleGrokHook(
        { hook_event_name: "UserPromptSubmit", cwd: workspace, session_id: "claude-state", prompt: "hi" },
        { homeDir: home },
      );
      const state = JSON.parse(await readFile(join(pluginData, "sessions", "claude-state.json"), "utf8")) as {
        alwaysDelivered: boolean;
      };
      expect(state.alwaysDelivered).toBe(true);
    } finally {
      if (previousClaude === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previousClaude;
      if (previousGrok === undefined) delete process.env.GROK_PLUGIN_DATA;
      else process.env.GROK_PLUGIN_DATA = previousGrok;
    }
  });
});

describe("Claude hook command", () => {
  async function command(): Promise<string> {
    const hooks = JSON.parse(await readFile(join(import.meta.dir, "../hooks/hooks.json"), "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const value = hooks.hooks.PreToolUse[0]?.hooks[0]?.command;
    if (value === undefined) throw new Error("missing PreToolUse command");
    return value;
  }

  function claudeEnv(home: string, pluginData: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_ROOT: join(import.meta.dir, ".."),
      CLAUDE_PLUGIN_DATA: pluginData,
    };
    delete env.GROK_PLUGIN_ROOT;
    delete env.GROK_PLUGIN_DATA;
    return env;
  }

  it("denies the first Claude Edit, allows the retry, and does not deny an unmatched path", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const env = claudeEnv(home, pluginData);
    const hook = await command();
    const deny = await runCommand(
      hook,
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: workspace,
        session_id: "claude-edit-cmd",
        tool_name: "Edit",
        tool_input: { file_path: "src/Button.tsx" },
      }),
    );
    expect(deny.code, deny.stderr).toBe(0);
    const parsed = JSON.parse(deny.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain("React body");
    expect(parsed.hookSpecificOutput?.permissionDecisionReason).toContain("Retry this mutation");

    const retry = await runCommand(
      hook,
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: workspace,
        session_id: "claude-edit-cmd",
        tool_name: "Edit",
        tool_input: { file_path: "src/Button.tsx" },
      }),
    );
    expect(retry.code, retry.stderr).toBe(0);
    expect(retry.stdout).toBe("");

    const unmatched = await runCommand(
      hook,
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: workspace,
        session_id: "claude-edit-cmd",
        tool_name: "Write",
        tool_input: { file_path: "src/app.css" },
      }),
    );
    expect(unmatched.code, unmatched.stderr).toBe(0);
    expect(unmatched.stdout).toBe("");
  });

  it("injects fileMatch on Claude Read, then allows Edit, and expands #name on the first prompt", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    await writeFile(join(workspace, ".kiro/steering/review.md"), "---\ninclusion: manual\n---\nReview body");
    const env = claudeEnv(home, pluginData);
    const hook = await command();

    const start = await runCommand(
      hook,
      env,
      JSON.stringify({ hook_event_name: "SessionStart", cwd: workspace, session_id: "claude-read-cmd" }),
    );
    expect(start.code, start.stderr).toBe(0);
    const started = JSON.parse(start.stdout) as { additionalContext?: string };
    expect(started.additionalContext).toContain("Global body");
    expect(started.additionalContext).not.toContain("React body");
    expect(started.additionalContext).not.toContain("Review body");

    const read = await runCommand(
      hook,
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: workspace,
        session_id: "claude-read-cmd",
        tool_name: "Read",
        tool_input: { file_path: "src/Button.tsx" },
      }),
    );
    expect(read.code, read.stderr).toBe(0);
    const injected = JSON.parse(read.stdout) as {
      additionalContext?: string;
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(injected.additionalContext).toContain("React body");
    expect(injected.hookSpecificOutput?.permissionDecision).toBeUndefined();

    const editAfterRead = await runCommand(
      hook,
      env,
      JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: workspace,
        session_id: "claude-read-cmd",
        tool_name: "Edit",
        tool_input: { file_path: "src/Button.tsx" },
      }),
    );
    expect(editAfterRead.code, editAfterRead.stderr).toBe(0);
    expect(editAfterRead.stdout).toBe("");

    const named = await runCommand(
      hook,
      env,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: workspace,
        session_id: "claude-read-cmd",
        prompt: "use #review",
      }),
    );
    expect(named.code, named.stderr).toBe(0);
    const expanded = JSON.parse(named.stdout) as { additionalContext?: string };
    expect(expanded.additionalContext).toContain("Review body");
    expect(expanded.additionalContext).toContain("Global body");

    const again = await runCommand(
      hook,
      env,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: workspace,
        session_id: "claude-read-cmd",
        prompt: "continue",
      }),
    );
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toBe("");
  });
});
