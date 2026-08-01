import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import registerKiroSteering, { expandNamedSteeringReferences, renderSteeringPrompt } from "../src/index.js";
import { parseSteering } from "../src/steering.js";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

interface MockPi {
  handlers: Map<string, Handler>;
  commands: Map<string, Command>;
  sentMessages: { content: string }[];
  sentUserMessages: string[];
  notifications: string[];
  api: ExtensionAPI;
}

function createMockPi(): MockPi {
  const mock: Omit<MockPi, "api"> = {
    handlers: new Map(),
    commands: new Map(),
    sentMessages: [],
    sentUserMessages: [],
    notifications: [],
  };
  // Structural stand-in: the extension only touches these four members.
  const api = {
    on: (event: string, handler: Handler) => mock.handlers.set(event, handler),
    registerCommand: (name: string, command: Command) => mock.commands.set(name, command),
    sendMessage: (message: { content: string }) => mock.sentMessages.push(message),
    sendUserMessage: (message: string) => mock.sentUserMessages.push(message),
  } as unknown as ExtensionAPI;
  return { ...mock, api };
}

function fixtureFile(fileName: string, source: string, scope: "global" | "workspace" = "workspace") {
  return parseSteering(source, {
    absolutePath: `/workspace/.kiro/steering/${fileName}.md`,
    displayPath: `.kiro/steering/${fileName}.md`,
    scope,
  });
}

describe("renderSteeringPrompt", () => {
  it("includes always content and only metadata for conditional steering", async () => {
    const files = [
      fixtureFile("project", "Always body"),
      fixtureFile("react", '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\nReact body'),
      fixtureFile("api", "---\ninclusion: auto\nname: api-design\ndescription: Use when designing APIs\n---\nAPI body"),
      fixtureFile("review", "---\ninclusion: manual\n---\nReview body"),
    ];

    const prompt = await renderSteeringPrompt(files, "/workspace");

    expect(prompt).toContain("Always body");
    expect(prompt).toContain("**/*.tsx");
    expect(prompt).toContain("api-design: Use when designing APIs");
    expect(prompt).not.toContain("React body");
    expect(prompt).not.toContain("API body");
    expect(prompt).not.toContain("Review body");
  });
});

describe("expandNamedSteeringReferences", () => {
  it("replaces known manual and auto #names without touching unrelated hashtags", async () => {
    const files = [
      fixtureFile("review", "---\ninclusion: manual\n---\nReview body"),
      fixtureFile("api", "---\ninclusion: auto\nname: api-design\ndescription: API rules\n---\nAPI body"),
    ];

    const expanded = await expandNamedSteeringReferences(
      "Use #review and #api-design but keep #123",
      files,
      "/workspace",
    );

    expect(expanded).toContain("Review body");
    expect(expanded).toContain("API body");
    expect(expanded).toContain("#123");
  });
});

describe("omp extension integration", () => {
  it("loads steering, expands manual references, and activates fileMatch before hashline edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-steering-ext-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(join(home, ".kiro/steering"), { recursive: true });
    await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
    await writeFile(join(home, ".kiro/steering/global.md"), "Global body");
    await writeFile(join(workspace, ".kiro/steering/review.md"), "---\ninclusion: manual\n---\nReview body");
    await writeFile(
      join(workspace, ".kiro/steering/react.md"),
      '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\nReact body',
    );
    await writeFile(
      join(workspace, ".kiro/steering/styles.md"),
      '---\ninclusion: fileMatch\nfileMatchPattern: "**/*.css"\n---\nStyle body',
    );

    const mock = createMockPi();
    registerKiroSteering(mock.api, { homeDir: home });
    const ctx = {
      cwd: workspace,
      ui: { notify: (message: string) => mock.notifications.push(message) },
    } as unknown as ExtensionContext;
    const fire = async (event: string, payload: Record<string, unknown>) => mock.handlers.get(event)?.(payload, ctx);

    await fire("session_start", {});
    expect(mock.notifications[0]).toContain("Loaded 4 Kiro steering file(s)");

    const beforeResult = (await fire("before_agent_start", {
      systemPrompt: ["BASE"],
      prompt: "Update Button.tsx",
    })) as { systemPrompt: string[] };
    expect(beforeResult.systemPrompt[0]).toBe("BASE");
    expect(beforeResult.systemPrompt.at(-1)).toContain("Global body");

    const inputResult = (await fire("input", { source: "interactive", text: "Use #review" })) as {
      text: string;
    };
    expect(inputResult.text).toContain("Review body");
    expect(await fire("input", { source: "extension", text: "Use #review" })).toBeUndefined();

    // hashline `edit`: the target only exists inside the patch text
    const editCall = { toolName: "edit", input: { input: "[src/Button.tsx#1A2B]\nPUT 1.=1:\n+const a = 1;\n" } };
    expect(await fire("tool_call", editCall)).toMatchObject({ block: true });
    expect(mock.sentMessages.at(-1)?.content).toContain("React body");

    await fire("turn_start", {});
    expect(await fire("tool_call", editCall)).toBeUndefined();

    // `read` carries a selector suffix and must activate without blocking
    expect(await fire("tool_call", { toolName: "read", input: { path: "src/app.css:10-20" } })).toBeUndefined();
    expect(mock.sentMessages.at(-1)?.content).toContain("Style body");

    const unmatched = await fire("tool_call", { toolName: "read", input: { path: "src/app.go" } });
    expect(unmatched).toBeUndefined();
    expect(mock.sentMessages).toHaveLength(2);

    expect(mock.commands.has("steering")).toBe(true);
    await mock.commands.get("steering")?.handler("review Check this change", ctx);
    expect(mock.sentUserMessages.at(-1)).toContain("Review body");
    expect(mock.sentUserMessages.at(-1)).toContain("User request: Check this change");

    await rm(root, { recursive: true });
  });
});
