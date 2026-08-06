import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import registerKiroSteering, { renderSteeringPrompt } from "../src/index.js";
import { parseSteering } from "../src/steering.js";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
type SentMessage = {
  content: string;
  display?: boolean;
  details?: { targetPath?: string; steeringFiles?: string[] };
  options?: { deliverAs?: string; triggerTurn?: boolean };
};

interface MockPi {
  handlers: Map<string, Handler>;
  commands: Map<string, Command>;
  sentMessages: SentMessage[];
  notifications: string[];
  messageRenderers: Map<string, unknown>;
  api: ExtensionAPI;
}

function createMockPi(): MockPi {
  const mock: Omit<MockPi, "api"> = {
    handlers: new Map(),
    commands: new Map(),
    sentMessages: [],
    notifications: [],
    messageRenderers: new Map(),
  };
  // Structural stand-in: the extension only touches these members.
  const api = {
    on: (event: string, handler: Handler) => mock.handlers.set(event, handler),
    registerCommand: (name: string, command: Command) => mock.commands.set(name, command),
    registerMessageRenderer: (customType: string, renderer: unknown) => mock.messageRenderers.set(customType, renderer),
    sendMessage: (message: Omit<SentMessage, "options">, options?: SentMessage["options"]) =>
      mock.sentMessages.push({ ...message, options }),
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

describe("omp extension integration", () => {
  it("loads steering, injects named refs, and activates fileMatch before hashline edits", async () => {
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
    expect(mock.messageRenderers.has("kiro-steering")).toBe(true);
    const renderer = mock.messageRenderers.get("kiro-steering") as (
      message: unknown,
      options: unknown,
      theme: unknown,
    ) => { render: (width: number) => string[] };
    const rendered = renderer(
      {
        customType: "kiro-steering",
        content: "Review body FULL",
        display: true,
        details: { steeringFiles: [".kiro/steering/review.md"], targetPath: "src/Button.tsx" },
      },
      { expanded: false },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    )
      .render(120)
      .join("\n");
    expect(rendered).toContain(".kiro/steering/review.md");
    expect(rendered).toContain("src/Button.tsx");
    expect(rendered).not.toContain("Review body FULL");

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

    // #name keeps user text intact; full body goes via sendMessage with file list in details
    expect(await fire("input", { source: "interactive", text: "Use #review" })).toBeUndefined();
    expect(mock.sentMessages.at(-1)?.content).toContain("Review body");
    expect(mock.sentMessages.at(-1)?.display).toBe(true);
    expect(mock.sentMessages.at(-1)?.details?.steeringFiles).toEqual([".kiro/steering/review.md"]);
    expect(await fire("input", { source: "extension", text: "Use #review" })).toBeUndefined();
    expect(mock.sentMessages).toHaveLength(1);

    // hashline `edit`: the target only exists inside the patch text
    const editCall = { toolName: "edit", input: { input: "[src/Button.tsx#1A2B]\nPUT 1.=1:\n+const a = 1;\n" } };
    expect(await fire("tool_call", editCall)).toMatchObject({ block: true });
    expect(mock.sentMessages.at(-1)?.content).toContain("React body");
    expect(mock.sentMessages.at(-1)?.details?.steeringFiles).toEqual([".kiro/steering/react.md"]);

    await fire("turn_start", {});
    expect(await fire("tool_call", editCall)).toBeUndefined();

    // `read` carries a selector suffix and must activate without blocking
    expect(await fire("tool_call", { toolName: "read", input: { path: "src/app.css:10-20" } })).toBeUndefined();
    expect(mock.sentMessages.at(-1)?.content).toContain("Style body");

    const unmatched = await fire("tool_call", { toolName: "read", input: { path: "src/app.go" } });
    expect(unmatched).toBeUndefined();
    expect(mock.sentMessages).toHaveLength(3);

    expect(mock.commands.has("steering")).toBe(true);
    await mock.commands.get("steering")?.handler("review Check this change", ctx);
    const steered = mock.sentMessages.at(-1);
    expect(steered?.content).toContain("Review body");
    expect(steered?.content).toContain("User request: Check this change");
    expect(steered?.details?.steeringFiles).toEqual([".kiro/steering/review.md"]);
    expect(steered?.options?.triggerTurn).toBe(true);

    await rm(root, { recursive: true });
  });
});
