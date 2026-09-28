import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGrokHook } from "../src/grok-hook.js";
import { toolPaths } from "../src/render.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-steering-agy-"));
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

describe("Antigravity plugin package", () => {
  it("ships a root hooks.json agy can load without variable expansion", async () => {
    const root = join(import.meta.dir, "..");
    const plugin = JSON.parse(await readFile(join(root, "plugin.json"), "utf8")) as { name: string };
    expect(plugin.name).toBe("omp-steering");

    const hooks = JSON.parse(await readFile(join(root, "hooks.json"), "utf8")) as {
      "omp-steering": {
        PreInvocation: Array<{ command: string }>;
        PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    };
    const named = hooks["omp-steering"];
    expect(named.PreInvocation[0]?.command).toBe("bash hooks/agy-run.sh PreInvocation");
    expect(named.PreToolUse[0]?.matcher).toBe(
      "view_file|write_to_file|replace_file_content|multi_replace_file_content",
    );
    expect(named.PreToolUse[0]?.hooks[0]?.command).toBe("bash hooks/agy-run.sh PreToolUse");
    const commands = [named.PreInvocation[0]?.command ?? "", named.PreToolUse[0]?.hooks[0]?.command ?? ""];
    for (const command of commands) expect(command).not.toContain("${");
  });
});

describe("Antigravity hook events", () => {
  it("collects AbsolutePath and TargetFile", () => {
    expect(toolPaths({ AbsolutePath: "/workspace/src/Button.tsx" })).toEqual(["/workspace/src/Button.tsx"]);
    expect(toolPaths({ TargetFile: "src/Button.tsx" })).toEqual(["src/Button.tsx"]);
  });

  it("injects always steering and expands #name from the transcript", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const transcript = join(workspace, "transcript.jsonl");
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: "USER_INPUT",
        content: "<USER_REQUEST>\nReview this using #review\n</USER_REQUEST>",
      })}\n`,
    );

    const result = await handleGrokHook(
      {
        hookEventName: "PreInvocation",
        workspacePaths: [workspace],
        conversationId: "agy-1",
        transcriptPath: transcript,
      },
      { homeDir: home, pluginData },
    );

    expect(result?.injectSteps?.[0]?.ephemeralMessage).toContain("Global body");
    expect(result?.injectSteps?.[0]?.ephemeralMessage).toContain("Review body");
    expect(result?.injectSteps?.[0]?.ephemeralMessage).not.toContain("React body");
    expect(result?.additionalContext).toBeUndefined();
  });

  it("denies the first matching view_file and allows the retry", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const target = join(workspace, "src/Button.tsx");
    const first = await handleGrokHook(
      {
        hookEventName: "PreToolUse",
        agy: true,
        conversationId: "agy-2",
        workspacePaths: [workspace],
        toolCall: { name: "view_file", args: { AbsolutePath: target } },
      },
      { homeDir: home, pluginData },
    );
    expect(first?.decision).toBe("deny");
    expect(first?.reason).toContain("React body");
    expect(first?.hookSpecificOutput).toBeUndefined();

    const second = await handleGrokHook(
      {
        hookEventName: "PreToolUse",
        agy: true,
        conversationId: "agy-2",
        workspacePaths: [workspace],
        toolCall: { name: "view_file", args: { AbsolutePath: target } },
      },
      { homeDir: home, pluginData },
    );
    expect(second).toBeUndefined();
  });

  it("denies the first matching write_to_file once", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    const result = await handleGrokHook(
      {
        hookEventName: "PreToolUse",
        workspacePaths: [workspace],
        conversationId: "agy-3",
        toolCall: { name: "write_to_file", args: { TargetFile: "src/Button.tsx" } },
      },
      { homeDir: home, pluginData },
    );
    expect(result?.decision).toBe("deny");
    expect(result?.reason).toContain("Retry this write_to_file");
  });

  it("denies replace_file_content and multi_replace_file_content on the first match", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    for (const toolName of ["replace_file_content", "multi_replace_file_content"]) {
      const result = await handleGrokHook(
        {
          hookEventName: "PreToolUse",
          workspacePaths: [workspace],
          conversationId: `agy-${toolName}`,
          toolCall: { name: toolName, args: { TargetFile: "src/Button.tsx" } },
        },
        { homeDir: home, pluginData },
      );
      expect(result?.decision).toBe("deny");
      expect(result?.reason).toContain("React body");
      expect(result?.reason).toContain(`Retry this ${toolName} on the next turn.`);
    }
  });

  it("reports invalid steering in the ephemeral message and still injects valid files", async () => {
    const { home, workspace, pluginData } = await fixtureWorkspace();
    await writeFile(join(workspace, ".kiro/steering/bad.md"), "---\ninclusion: sometimes\n---\nbad");
    const result = await handleGrokHook(
      { hookEventName: "PreInvocation", workspacePaths: [workspace], conversationId: "agy-bad" },
      { homeDir: home, pluginData },
    );
    const message = result?.injectSteps?.[0]?.ephemeralMessage ?? "";
    expect(message).toContain("Global body");
    expect(message).toContain("unsupported inclusion mode: sometimes");
    expect(message).not.toContain("\nbad");
  });
});

describe("Antigravity hook command", () => {
  it("runs PreInvocation from the plugin root and emits injectSteps", async () => {
    const { home, workspace } = await fixtureWorkspace();
    const root = join(import.meta.dir, "..");
    const command = "bash hooks/agy-run.sh PreInvocation";
    const result = await runCommand(
      command,
      { ...process.env, HOME: home },
      JSON.stringify({
        workspacePaths: [workspace],
        conversationId: "agy-runner",
        invocationNum: 0,
      }),
      root,
    );
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { injectSteps?: Array<{ ephemeralMessage: string }> };
    expect(parsed.injectSteps?.[0]?.ephemeralMessage).toContain("Global body");
  });

  it("tells Antigravity that bun is required when bun is not on PATH", async () => {
    const { home, workspace } = await fixtureWorkspace();
    const root = join(import.meta.dir, "..");
    const result = await runCommand(
      "bash hooks/agy-run.sh PreInvocation",
      { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
      JSON.stringify({ workspacePaths: [workspace], conversationId: "agy-nobun" }),
      root,
    );
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as { injectSteps?: Array<{ ephemeralMessage: string }> };
    expect(parsed.injectSteps?.[0]?.ephemeralMessage).toBe(
      "omp-steering: bun is required on PATH to load Kiro steering files.",
    );
  });
});

function runCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  stdin: string,
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  const child = spawn("bash", ["-c", command], { env, cwd });
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
