import { homedir } from "node:os";
import type { CustomMessage, ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-coding-agent";
import {
  namedSteeringByName,
  renderActivatedRules,
  renderSteeringFile,
  renderSteeringPrompt,
  toolPaths,
} from "./render.js";
import { discoverSteering, matchFileSteering, type SteeringFile } from "./steering.js";

export { renderSteeringPrompt } from "./render.js";

const STEERING_MESSAGE_TYPE = "kiro-steering";

interface SteeringMessageDetails {
  targetPath?: string;
  steeringFiles: string[];
}

interface ExtensionOptions {
  homeDir?: string;
}

interface SteeringRuntime {
  pi: ExtensionAPI;
  homeDir: string;
  files: SteeringFile[];
  workspaceRoot: string;
  activeFileRules: Set<string>;
  pendingFileRules: Set<string>;
}

const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true };

export default function registerKiroSteering(pi: ExtensionAPI, options: ExtensionOptions = {}): void {
  const runtime: SteeringRuntime = {
    pi,
    homeDir: options.homeDir ?? homedir(),
    files: [],
    workspaceRoot: "",
    activeFileRules: new Set(),
    pendingFileRules: new Set(),
  };

  pi.registerMessageRenderer<SteeringMessageDetails>(STEERING_MESSAGE_TYPE, (message, _options, theme) =>
    renderSteeringMessage(message, theme),
  );
  pi.on("session_start", async (_event, ctx) => startSession(runtime, ctx));
  pi.on("before_agent_start", async (event, ctx) => {
    await refresh(runtime, ctx);
    const steeringPrompt = await renderSteeringPrompt(runtime.files, runtime.workspaceRoot);
    if (steeringPrompt === "") return;
    return { systemPrompt: [...event.systemPrompt, steeringPrompt] };
  });
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return;
    await refresh(runtime, ctx);
    await injectNamedSteeringReferences(runtime, event.text);
  });
  pi.on("turn_start", () => {
    for (const path of runtime.pendingFileRules) runtime.activeFileRules.add(path);
    runtime.pendingFileRules.clear();
  });
  pi.on("tool_call", async (event) => activateMatchingRules(runtime, event.toolName, event.input));

  pi.registerCommand("steering", {
    description: "Include a manual or auto Kiro steering file",
    getArgumentCompletions: (prefix) => completeSteeringName(runtime.files, prefix),
    handler: async (args, ctx) => runSteeringCommand(runtime, args, ctx),
  });
}

async function refresh(runtime: SteeringRuntime, ctx: ExtensionContext): Promise<string[]> {
  runtime.workspaceRoot = ctx.cwd;
  const result = await discoverSteering({
    homeDir: runtime.homeDir,
    workspaceRoot: runtime.workspaceRoot,
  });
  runtime.files = result.files;
  return result.errors;
}

async function startSession(runtime: SteeringRuntime, ctx: ExtensionContext): Promise<void> {
  runtime.activeFileRules.clear();
  runtime.pendingFileRules.clear();
  const errors = await refresh(runtime, ctx);
  if (runtime.files.length > 0) ctx.ui.notify(`Loaded ${runtime.files.length} Kiro steering file(s)`, "info");
  if (errors.length > 0) ctx.ui.notify(`Skipped invalid Kiro steering:\n${errors.join("\n")}`, "warning");
}

async function activateMatchingRules(runtime: SteeringRuntime, toolName: string, input: unknown) {
  const paths = toolPaths(input);
  if (paths.length === 0) return;

  const newlyPending: SteeringFile[] = [];
  const activatedPaths: string[] = [];
  for (const path of paths) {
    const inactive = matchFileSteering(runtime.files, path, runtime.workspaceRoot).filter(
      (file) => !runtime.activeFileRules.has(file.absolutePath),
    );
    if (inactive.length === 0) continue;
    activatedPaths.push(path);
    for (const file of inactive) {
      if (runtime.pendingFileRules.has(file.absolutePath)) continue;
      runtime.pendingFileRules.add(file.absolutePath);
      newlyPending.push(file);
    }
  }
  if (activatedPaths.length === 0) return;

  const target = activatedPaths.join(", ");
  if (newlyPending.length > 0) {
    runtime.pi.sendMessage(
      {
        customType: STEERING_MESSAGE_TYPE,
        content: await renderActivatedRules(newlyPending, runtime.workspaceRoot, target),
        display: true,
        details: { targetPath: target, steeringFiles: newlyPending.map((file) => file.displayPath) },
      },
      { deliverAs: "steer" },
    );
  }

  if (MUTATING_TOOLS[toolName] === true) {
    return {
      block: true as const,
      reason: `Kiro fileMatch steering was added for ${target}. Retry this mutation on the next turn.`,
    };
  }
}

function completeSteeringName(files: SteeringFile[], prefix: string) {
  const items: Array<{ value: string; label: string; description?: string }> = [];
  for (const file of namedSteeringByName(files).values()) {
    if (file.name.startsWith(prefix)) {
      items.push({ value: file.name, label: file.name, description: file.description });
    }
  }
  return items.length > 0 ? items : null;
}

async function runSteeringCommand(runtime: SteeringRuntime, args: string, ctx: ExtensionContext): Promise<void> {
  await refresh(runtime, ctx);
  const trimmed = args.trim();
  const name = trimmed.split(/\s+/, 1)[0];
  const available = namedSteeringByName(runtime.files);

  if (name === "") {
    const names = [...available.keys()].join(", ");
    ctx.ui.notify(names === "" ? "No manual or auto Kiro steering files found" : `Kiro steering: ${names}`, "info");
    return;
  }

  const file = available.get(name);
  if (file === undefined) {
    ctx.ui.notify(`Unknown Kiro steering: ${name}`, "warning");
    return;
  }

  const request = trimmed.slice(name.length).trim();
  const content = await renderSteeringFile(file, runtime.workspaceRoot);
  runtime.pi.sendMessage(
    {
      customType: STEERING_MESSAGE_TYPE,
      content: request === "" ? content : `${content}\n\nUser request: ${request}`,
      display: true,
      details: { steeringFiles: [file.displayPath] },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

async function injectNamedSteeringReferences(runtime: SteeringRuntime, text: string): Promise<void> {
  const namedFiles = namedSteeringByName(runtime.files);
  const matched = new Map<string, SteeringFile>();
  for (const match of text.matchAll(/#([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
    const file = namedFiles.get(match[1]);
    if (file !== undefined) matched.set(file.absolutePath, file);
  }
  if (matched.size === 0) return;

  const files = [...matched.values()];
  const content = (await Promise.all(files.map((file) => renderSteeringFile(file, runtime.workspaceRoot)))).join(
    "\n\n",
  );
  runtime.pi.sendMessage(
    {
      customType: STEERING_MESSAGE_TYPE,
      content,
      display: true,
      details: { steeringFiles: files.map((file) => file.displayPath) },
    },
    { deliverAs: "steer" },
  );
}

function renderSteeringMessage(message: CustomMessage<SteeringMessageDetails>, theme: Theme): Text {
  const files = message.details?.steeringFiles ?? [];
  const label = files.length > 0 ? files.join(", ") : "steering";
  const target = message.details?.targetPath ? ` for ${message.details.targetPath}` : "";
  return new Text(theme.fg("customMessageLabel", theme.bold(`kiro-steering ${label}${target}`)), 0, 0);
}
