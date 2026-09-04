import { homedir } from "node:os";
import type { CustomMessage, ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-coding-agent";
import { discoverSteering, expandFileReferences, matchFileSteering, type SteeringFile } from "./steering.js";

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

/** `edit` hashline targets live in `[path#TAG]` headers; apply_patch uses `*** Update File:` envelopes. */
const HASHLINE_HEADER = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;
const APPLY_PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
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

/**
 * Every filesystem target the call touches: the plain `path`/`paths` fields most
 * tools expose, hashline `[path#TAG]` headers, and apply_patch file envelopes.
 * A `read` path may carry a selector suffix (`file.ts:50-200`), so its bare path
 * is offered as well.
 */
function toolPaths(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const paths = new Set<string>();

  const candidates = [record.path, ...(Array.isArray(record.paths) ? record.paths : [])];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const header = /^\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]$/.exec(candidate.trim());
    const path = header ? header[1].trim() : candidate.replace(/^@/, "");
    paths.add(path);
    const selector = path.lastIndexOf(":");
    if (selector > path.lastIndexOf("/")) paths.add(path.slice(0, selector));
  }

  for (const key of ["input", "_input"]) {
    const patch = record[key];
    if (typeof patch !== "string") continue;
    for (const match of patch.matchAll(HASHLINE_HEADER)) paths.add(match[1].trim());
    for (const match of patch.matchAll(APPLY_PATCH_FILE)) paths.add(match[1].trim());
  }

  return [...paths];
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

export async function renderSteeringPrompt(files: SteeringFile[], workspaceRoot: string): Promise<string> {
  if (files.length === 0) return "";

  const sections = [
    "## Kiro Steering",
    "These instructions come from Kiro steering files. Workspace steering has priority over conflicting global steering.",
  ];
  const alwaysFiles = files.filter((file) => file.inclusion === "always");
  if (alwaysFiles.length > 0) {
    sections.push(
      "### Always included",
      ...(await Promise.all(alwaysFiles.map((file) => renderSteeringFile(file, workspaceRoot)))),
    );
  }

  const fileMatchFiles = files.filter((file) => file.inclusion === "fileMatch");
  if (fileMatchFiles.length > 0) {
    sections.push(
      "### Conditional file steering",
      "Before working with a matching file, load and follow its steering file. The extension also activates these rules when file tools expose a matching path.",
      ...fileMatchFiles.map(
        (file) => `- ${file.absolutePath} → ${file.patterns.map((pattern) => JSON.stringify(pattern)).join(", ")}`,
      ),
    );
  }

  const namedFiles = [...namedSteeringByName(files).values()];
  const autoFiles = namedFiles.filter((file) => file.inclusion === "auto");
  if (autoFiles.length > 0) {
    sections.push(
      "### Auto steering",
      "When the request matches a description below, read the listed steering file before proceeding.",
      ...autoFiles.map((file) => `- ${file.name}: ${file.description} (${file.absolutePath})`),
    );
  }

  const manualFiles = namedFiles.filter((file) => file.inclusion === "manual");
  if (manualFiles.length > 0) {
    sections.push(
      "### Manual steering",
      `Available through #name or /steering <name>: ${manualFiles.map((file) => file.name).join(", ")}`,
    );
  }

  return sections.join("\n\n");
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

async function renderActivatedRules(files: SteeringFile[], workspaceRoot: string, targetPath: string): Promise<string> {
  const rendered = await Promise.all(files.map((file) => renderSteeringFile(file, workspaceRoot)));
  return `Kiro fileMatch steering activated for ${targetPath}:\n\n${rendered.join("\n\n")}`;
}

async function renderSteeringFile(file: SteeringFile, workspaceRoot: string): Promise<string> {
  const body = await expandFileReferences(file.body, workspaceRoot);
  return `<kiro-steering scope=${JSON.stringify(file.scope)} file=${JSON.stringify(file.displayPath)}>\n${body}\n</kiro-steering>`;
}

function namedSteeringByName(files: SteeringFile[]): Map<string, SteeringFile> {
  const byName = new Map<string, SteeringFile>();
  for (const file of files) {
    if (file.inclusion === "manual" || file.inclusion === "auto") byName.set(file.name, file);
  }
  return byName;
}
