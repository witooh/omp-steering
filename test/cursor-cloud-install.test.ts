import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts/install-cursor-cloud.sh");
const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-steering-cloud-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = root,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [script, ...args], { encoding: "utf8", env, cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("install-cursor-cloud.sh", () => {
  it("installs the checkout skill into HOME and leaves the working tree alone", async () => {
    const home = await makeTemporaryDirectory();
    const project = await makeTemporaryDirectory();
    await mkdir(join(home, ".cursor", "skills", "keep-mine"), { recursive: true });
    await mkdir(join(home, ".cursor", "skills", "retired-pack"), { recursive: true });
    await writeFile(join(home, ".cursor", "skills", "keep-mine", "SKILL.md"), "# user skill\n");
    await writeFile(join(home, ".cursor", "skills", "retired-pack", "SKILL.md"), "# retired\n");
    await writeFile(join(home, ".cursor", ".omp-steering-skills"), "retired-pack\n../outside\nsteering\n");
    await writeFile(join(home, ".cursor", "hooks.json"), "{}\n");

    const installed = run([], { ...process.env, HOME: home, OMP_STEERING_REF: "v9.9.9" }, project);
    expect(installed.status).toBe(0);
    expect(installed.stdout).toMatch(/removed:\s+1/);

    const source = await readFile(join(root, "skills", "steering", "SKILL.md"), "utf8");
    expect(await readFile(join(home, ".cursor", "skills", "steering", "SKILL.md"), "utf8")).toBe(source);
    expect(await readFile(join(home, ".cursor", "skills", "keep-mine", "SKILL.md"), "utf8")).toBe("# user skill\n");
    expect(await readFile(join(home, ".cursor", ".omp-steering-skills"), "utf8")).toBe("steering\n");
    expect(await readFile(join(home, ".cursor", "hooks.json"), "utf8")).toBe("{}\n");
    await expect(stat(join(home, ".cursor", "skills", "retired-pack"))).rejects.toThrow();
    await expect(stat(join(project, ".cursor"))).rejects.toThrow();
    await expect(stat(join(root, ".cursor"))).rejects.toThrow();

    const again = run([], { ...process.env, HOME: home }, project);
    expect(again.status).toBe(0);
    expect(await readFile(join(home, ".cursor", "skills", "steering", "SKILL.md"), "utf8")).toBe(source);
  });

  it("refuses a copied script without a pinned ref and does not clone unsafe refs", async () => {
    const dir = await makeTemporaryDirectory();
    const standalone = join(dir, "install-cursor-cloud.sh");
    await writeFile(standalone, await readFile(script));
    await chmod(standalone, 0o755);
    const home = join(dir, "home");

    const missing = spawnSync("bash", [standalone], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("OMP_STEERING_REF must be a tag or branch name");
    await expect(stat(home)).rejects.toThrow();

    const bad = spawnSync("bash", [standalone], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, OMP_STEERING_REF: "../v0.1.5" },
    });
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).not.toContain("cloning");
    await expect(stat(home)).rejects.toThrow();
  });
});
