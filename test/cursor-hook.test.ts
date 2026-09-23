import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-steering-cursor-hook-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runHook(home: string, workspace: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = join(import.meta.dir, "../hooks/cursor-run.sh");
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  const child = spawn("bash", [script], {
    env: {
      HOME: home,
      CURSOR_PROJECT_DIR: workspace,
      PATH: "/usr/bin:/bin",
    },
  });
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
  child.stdin.end();
  return promise;
}

describe("cursor-run.sh", () => {
  it("injects steering markdown without bun and ignores inclusion modes", async () => {
    const root = await makeTemporaryDirectory();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".kiro/steering"), { recursive: true });
    await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
    await writeFile(join(home, ".kiro/steering/global.md"), "Global body");
    await writeFile(join(workspace, ".kiro/steering/review.md"), "---\ninclusion: manual\n---\nReview body");
    await writeFile(join(workspace, ".kiro/steering/quote.md"), 'Say "hi"\nnext');
    await chmod(join(import.meta.dir, "../hooks/cursor-run.sh"), 0o755);

    const result = await runHook(home, workspace);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { additional_context: string };
    const globalAt = parsed.additional_context.indexOf("Global body");
    const reviewAt = parsed.additional_context.indexOf("Review body");
    expect(globalAt).toBeGreaterThanOrEqual(0);
    expect(reviewAt).toBeGreaterThan(globalAt);
    expect(parsed.additional_context).not.toContain("inclusion: manual");
    expect(parsed.additional_context).toContain('Say "hi"\nnext');
  });

  it("prints nothing when no steering files exist", async () => {
    const root = await makeTemporaryDirectory();
    const result = await runHook(join(root, "home"), join(root, "workspace"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("Cursor plugin package", () => {
  it("points the Cursor manifest at the skill pack and a bash sessionStart hook", async () => {
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
    const marketplace = JSON.parse(await readFile(join(root, ".cursor-plugin/marketplace.json"), "utf8")) as {
      name: string;
      plugins: Array<{ name: string; source: string; description: string }>;
    };
    expect(marketplace.name).toBe("omp-steering");
    expect(marketplace.plugins).toEqual([
      {
        name: "omp-steering",
        source: "./",
        description: "Load Kiro steering files (always, fileMatch, manual, auto) into Cursor.",
      },
    ]);

    const hooks = JSON.parse(await readFile(join(root, "hooks/hooks-cursor.json"), "utf8")) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual(["sessionStart"]);
    expect(hooks.hooks.sessionStart.map((entry) => entry.command)).toEqual(["bash ./hooks/cursor-run.sh"]);

    const runner = await readFile(join(root, "hooks/cursor-run.sh"), "utf8");
    expect(runner).not.toContain("bun");
    expect(runner).not.toContain("cursor-hook.ts");
  });
});
