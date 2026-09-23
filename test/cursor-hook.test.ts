import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCursorHook } from "../src/cursor-hook.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-steering-cursor-hook-"));
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
  await writeFile(join(workspace, ".kiro/steering/review.md"), "---\ninclusion: manual\n---\nReview body");
  await writeFile(
    join(workspace, ".kiro/steering/react.md"),
    '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\nReact body',
  );
  return { home, workspace, pluginData };
}

describe("handleCursorHook", () => {
  it("injects always steering as additional_context on sessionStart", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const result = await handleCursorHook(
      {
        hook_event_name: "sessionStart",
        conversation_id: "c1",
        workspace_roots: [workspace],
      },
      { homeDir: home, pluginData },
    );
    expect(result?.additional_context).toContain("Global body");
    expect(result?.additional_context).not.toContain("React body");
    expect(result?.permission).toBeUndefined();
  });

  it("expands #name on beforeSubmitPrompt", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const result = await handleCursorHook(
      {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "c2",
        workspace_roots: [workspace],
        prompt: "Use #review",
      },
      { homeDir: home, pluginData },
    );
    expect(result?.additional_context).toContain("Review body");
  });

  it("denies the first matching Write and injects a later Read", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const deny = await handleCursorHook(
      {
        hook_event_name: "preToolUse",
        conversation_id: "c3",
        workspace_roots: [workspace],
        tool_name: "Write",
        tool_input: { file_path: "src/Button.tsx" },
      },
      { homeDir: home, pluginData },
    );
    expect(deny?.permission).toBe("deny");
    expect(deny?.agent_message).toContain("React body");

    const read = await handleCursorHook(
      {
        hook_event_name: "preToolUse",
        conversation_id: "c4",
        workspace_roots: [workspace],
        tool_name: "Read",
        tool_input: { file_path: "src/Button.tsx" },
      },
      { homeDir: home, pluginData },
    );
    expect(read?.permission).toBeUndefined();
    expect(read?.additional_context).toContain("React body");
  });
});

describe("Cursor plugin package", () => {
  it("points the Cursor manifest at the skill pack and Cursor hook config", async () => {
    const root = join(import.meta.dir, "..");
    const npm = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const cursor = JSON.parse(await readFile(join(root, ".cursor-plugin/plugin.json"), "utf8")) as {
      name: string;
      version: string;
      skills: string;
      hooks: string;
    };
    expect(cursor.name).toBe("omp-steering");
    expect(cursor.version).toBe(npm.version);
    expect(cursor.skills).toBe("./skills/");
    expect(cursor.hooks).toBe("./hooks/hooks-cursor.json");

    const hooks = JSON.parse(await readFile(join(root, "hooks/hooks-cursor.json"), "utf8")) as {
      version: number;
      hooks: Record<string, Array<{ command: string; timeout: number }>>;
    };
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks).sort()).toEqual(["beforeSubmitPrompt", "preToolUse", "sessionStart"]);
    for (const entries of Object.values(hooks.hooks)) {
      expect(entries.map((entry) => entry.command)).toEqual(["bash ./hooks/cursor-run.sh"]);
    }
  });

  it("runs the Cursor hook script against stdin", async () => {
    const { home, workspace } = await fixtureWorkspace();
    const script = join(import.meta.dir, "../hooks/cursor-run.sh");
    await chmod(script, 0o755);
    const payload = JSON.stringify({
      hook_event_name: "sessionStart",
      conversation_id: "runner",
      workspace_roots: [workspace],
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(script, [], {
        env: { ...process.env, CURSOR_PLUGIN_ROOT: join(import.meta.dir, ".."), HOME: home },
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
        else reject(new Error(`cursor-run.sh exited ${code}: ${err}`));
      });
      child.stdin.write(payload);
      child.stdin.end();
    });
    const parsed = JSON.parse(stdout) as { additional_context?: string };
    expect(parsed.additional_context).toContain("Global body");
  });
});
