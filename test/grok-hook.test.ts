import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_CONTEXT_CAP, handleGrokHook } from "../src/grok-hook.js";
import { toolPaths } from "../src/render.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-steering-grok-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixtureWorkspace(): Promise<{ home: string; workspace: string; pluginData: string }> {
  const root = await makeTemporaryDirectory();
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const pluginData = join(root, "plugin-data");
  await mkdir(join(home, ".kiro/steering"), { recursive: true });
  await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
  await writeFile(join(home, ".kiro/steering/global.md"), "Global body");
  await writeFile(join(workspace, ".kiro/steering/review.md"), "---\ninclusion: manual\n---\nReview body");
  await writeFile(
    join(workspace, ".kiro/steering/react.md"),
    '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\nReact body',
  );
  await writeFile(
    join(workspace, ".kiro/steering/api.md"),
    "---\ninclusion: auto\nname: api-design\ndescription: Use when designing APIs\n---\nAPI body",
  );
  return { home, workspace, pluginData };
}

describe("toolPaths", () => {
  it("collects Grok target_file and file_path plus omp path/hashline", () => {
    expect(toolPaths({ target_file: "src/Button.tsx" })).toEqual(["src/Button.tsx"]);
    expect(toolPaths({ file_path: "src/app.css" })).toEqual(["src/app.css"]);
    expect(toolPaths({ target_directory: "src/components" })).toEqual(["src/components"]);
    expect(toolPaths({ path: "src/app.css:10-20" })).toContain("src/app.css");
    expect(toolPaths({ input: "[src/Button.tsx#1A2B]\nPUT 1.=1:\n" })).toContain("src/Button.tsx");
  });
});

describe("handleGrokHook", () => {
  it("injects always bodies and only metadata for conditional steering on SessionStart", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const result = await handleGrokHook(
      { hook_event_name: "SessionStart", cwd: workspace, sessionId: "s1" },
      { homeDir: home, pluginData },
    );

    expect(result?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(result?.additionalContext).toContain("Global body");
    expect(result?.additionalContext).toContain("**/*.tsx");
    expect(result?.additionalContext).toContain("api-design: Use when designing APIs");
    expect(result?.additionalContext).not.toContain("React body");
    expect(result?.additionalContext).not.toContain("API body");
    expect(result?.additionalContext).not.toContain("Review body");
  });

  it("delivers always steering once on UserPromptSubmit and expands #name", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const first = await handleGrokHook(
      {
        hookEventName: "user_prompt_submit",
        cwd: workspace,
        sessionId: "s2",
        prompt: "Use #review",
      },
      { homeDir: home, pluginData },
    );
    expect(first?.additionalContext).toContain("Global body");
    expect(first?.additionalContext).toContain("Review body");
    expect(first?.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");

    const second = await handleGrokHook(
      {
        hookEventName: "user_prompt_submit",
        cwd: workspace,
        sessionId: "s2",
        prompt: "continue",
      },
      { homeDir: home, pluginData },
    );
    expect(second).toBeUndefined();

    const named = await handleGrokHook(
      {
        hook_event_name: "UserPromptSubmit",
        cwd: workspace,
        sessionId: "s2",
        prompt: "again #review",
      },
      { homeDir: home, pluginData },
    );
    expect(named?.additionalContext).toContain("Review body");
    expect(named?.additionalContext).not.toContain("Global body");
  });

  it("denies the first matching Grok mutation and allows the retry", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const deny = await handleGrokHook(
      {
        hook_event_name: "PreToolUse",
        cwd: workspace,
        sessionId: "s3",
        toolName: "search_replace",
        toolInput: { file_path: "src/Button.tsx" },
      },
      { homeDir: home, pluginData },
    );
    expect(deny?.decision).toBe("deny");
    expect(deny?.reason).toContain("React body");
    expect(deny?.reason).toContain("Retry this mutation");

    const retry = await handleGrokHook(
      {
        hook_event_name: "PreToolUse",
        cwd: workspace,
        sessionId: "s3",
        toolName: "search_replace",
        toolInput: { file_path: "src/Button.tsx" },
      },
      { homeDir: home, pluginData },
    );
    expect(retry).toBeUndefined();
  });

  it("allows a matching read and injects fileMatch after the call", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const result = await handleGrokHook(
      {
        hook_event_name: "PreToolUse",
        cwd: workspace,
        sessionId: "s4",
        toolName: "read_file",
        toolInput: { target_file: "src/Button.tsx" },
      },
      { homeDir: home, pluginData },
    );
    expect(result?.decision).toBeUndefined();
    expect(result?.additionalContext).toContain("React body");
    expect(result?.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
  });

  it("clips oversized deny reasons to Grok's context cap", async () => {
    const root = await makeTemporaryDirectory();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const pluginData = join(root, "plugin-data");
    await mkdir(join(home, ".kiro/steering"), { recursive: true });
    await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
    await writeFile(
      join(workspace, ".kiro/steering/react.md"),
      `---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\n${"R".repeat(GROK_CONTEXT_CAP + 50)}`,
    );

    const deny = await handleGrokHook(
      {
        hook_event_name: "PreToolUse",
        cwd: workspace,
        sessionId: "s5",
        toolName: "write",
        toolInput: { file_path: "src/Button.tsx" },
      },
      { homeDir: home, pluginData },
    );
    expect(deny?.decision).toBe("deny");
    expect(deny?.reason?.length).toBeLessThanOrEqual(GROK_CONTEXT_CAP);
    expect(deny?.reason).toContain("Read the matching files");
    expect(deny?.reason).not.toContain("RRRR");
  });

  it("reports invalid steering on SessionStart instead of loading it", async () => {
    const root = await makeTemporaryDirectory();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const pluginData = join(root, "plugin-data");
    await mkdir(join(home, ".kiro/steering"), { recursive: true });
    await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
    await writeFile(join(workspace, ".kiro/steering/broken.md"), "---\ninclusion: sometimes\n---\nBody");

    const result = await handleGrokHook(
      { hook_event_name: "SessionStart", cwd: workspace, sessionId: "s6" },
      { homeDir: home, pluginData },
    );
    expect(result?.additionalContext).toContain("unsupported inclusion mode: sometimes");
  });
});

describe("Grok plugin package", () => {
  it("ships an executable hook runner that forwards stdin to the TypeScript hook", async () => {
    const { home, workspace } = await fixtureWorkspace();
    const script = join(import.meta.dir, "../hooks/run.sh");
    const stat = await readFile(script); // ensure it exists
    expect(stat.byteLength).toBeGreaterThan(0);
    await chmod(script, 0o755);

    const payload = JSON.stringify({
      hook_event_name: "SessionStart",
      cwd: workspace,
      sessionId: "runner",
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(script, [], {
        env: { ...process.env, GROK_PLUGIN_ROOT: join(import.meta.dir, ".."), HOME: home },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`run.sh exited ${code}: ${err}`));
      });
      child.stdin.write(payload);
      child.stdin.end();
    });

    const parsed = JSON.parse(stdout) as { additionalContext?: string };
    expect(parsed.additionalContext).toContain("Global body");
  });

  it("keeps package.json and Grok plugin manifests on the same version", async () => {
    const root = join(import.meta.dir, "..");
    const npm = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const plugin = JSON.parse(await readFile(join(root, "plugin.json"), "utf8")) as { version: string; name: string };
    const grok = JSON.parse(await readFile(join(root, ".grok-plugin/plugin.json"), "utf8")) as {
      version: string;
      name: string;
    };
    expect(plugin.name).toBe("omp-steering");
    expect(plugin.version).toBe(npm.version);
    expect(grok.name).toBe("omp-steering");
    expect(grok.version).toBe(npm.version);
  });

  it("passes grok plugin validate when grok is on PATH", () => {
    const grok = Bun.which("grok");
    if (grok === null) return;

    const result = Bun.spawnSync([grok, "plugin", "validate", join(import.meta.dir, "..")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).toMatch(/Plugin manifest is valid/i);
  });
});
