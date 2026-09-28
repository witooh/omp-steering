import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  namedSteeringByName,
  renderActivatedRules,
  renderSteeringFile,
  renderSteeringPrompt,
  toolPaths,
} from "./render.js";
import { discoverSteering, matchFileSteering, type SteeringFile } from "./steering.js";

/** Grok, Claude Code, and Antigravity clip injected hook text at 10_000 characters. */
export const GROK_CONTEXT_CAP = 10_000;

const MUTATING_TOOLS: Record<string, true> = {
  search_replace: true,
  write: true,
  edit: true,
  notebookedit: true,
  apply_patch: true,
  ast_edit: true,
  multiedit: true,
  strreplace: true,
  write_to_file: true,
  replace_file_content: true,
  multi_replace_file_content: true,
};

export interface GrokHookOptions {
  homeDir?: string;
  pluginData?: string;
}

export interface GrokHookOutput {
  decision?: string;
  reason?: string;
  additionalContext?: string;
  injectSteps?: Array<{ ephemeralMessage: string }>;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: "deny";
    permissionDecisionReason?: string;
  };
}

interface SessionState {
  activeFileRules: string[];
  alwaysDelivered: boolean;
}

export async function handleGrokHook(
  event: Record<string, unknown>,
  options: GrokHookOptions = {},
): Promise<GrokHookOutput | undefined> {
  const name = hookEventName(event);
  if (name === "SessionStart") return sessionStart(event, options);
  if (name === "UserPromptSubmit") return userPromptSubmit(event, options);
  if (name === "PreInvocation") return preInvocation(event, options);
  if (name === "PreToolUse") return preToolUse(normalizeAntigravityTool(event), options);
  return undefined;
}

async function sessionStart(
  event: Record<string, unknown>,
  options: GrokHookOptions,
): Promise<GrokHookOutput | undefined> {
  const { files, errors, workspaceRoot } = await loadSteering(event, options);
  const prompt = await renderSteeringPrompt(files, workspaceRoot);
  const body = joinSections(prompt, formatErrors(errors));
  if (body === "") return undefined;
  return contextOutput("SessionStart", body);
}

async function preInvocation(
  event: Record<string, unknown>,
  options: GrokHookOptions,
): Promise<GrokHookOutput | undefined> {
  const { files, errors, workspaceRoot } = await loadSteering(event, options);
  const sections = [await renderSteeringPrompt(files, workspaceRoot), formatErrors(errors)];
  const named = namedSteeringByName(files);
  const matched = new Map<string, SteeringFile>();
  for (const match of (await latestUserRequest(event, options)).matchAll(/#([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
    const file = named.get(match[1]);
    if (file !== undefined) matched.set(file.absolutePath, file);
  }
  if (matched.size > 0) {
    sections.push(...(await Promise.all([...matched.values()].map((file) => renderSteeringFile(file, workspaceRoot)))));
  }
  const body = joinSections(...sections);
  if (body === "") return undefined;
  return {
    injectSteps: [
      {
        ephemeralMessage: clip(
          body,
          "Kiro steering is active. Read ~/.kiro/steering and .kiro/steering before editing.",
        ),
      },
    ],
  };
}

async function userPromptSubmit(
  event: Record<string, unknown>,
  options: GrokHookOptions,
): Promise<GrokHookOutput | undefined> {
  const { files, errors, workspaceRoot, sessionId, pluginData } = await loadSteering(event, options);
  const state = await readState(pluginData, sessionId);
  const sections: string[] = [];

  if (!state.alwaysDelivered) {
    const prompt = await renderSteeringPrompt(files, workspaceRoot);
    if (prompt !== "") sections.push(prompt);
    sections.push(formatErrors(errors));
    state.alwaysDelivered = true;
    await writeState(pluginData, sessionId, state);
  }

  const named = namedSteeringByName(files);
  const matched = new Map<string, SteeringFile>();
  for (const match of eventPrompt(event).matchAll(/#([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
    const file = named.get(match[1]);
    if (file !== undefined) matched.set(file.absolutePath, file);
  }
  if (matched.size > 0) {
    sections.push(...(await Promise.all([...matched.values()].map((file) => renderSteeringFile(file, workspaceRoot)))));
  }

  const body = joinSections(...sections);
  if (body === "") return undefined;
  return contextOutput("UserPromptSubmit", body);
}

async function preToolUse(
  event: Record<string, unknown>,
  options: GrokHookOptions,
): Promise<GrokHookOutput | undefined> {
  const input = event.toolInput ?? event.tool_input;
  const paths = toolPaths(input);
  if (paths.length === 0) return undefined;

  const { files, workspaceRoot, sessionId, pluginData } = await loadSteering(event, options);
  const state = await readState(pluginData, sessionId);
  const active = new Set(state.activeFileRules);

  const newly: SteeringFile[] = [];
  const activatedPaths: string[] = [];
  for (const path of paths) {
    const inactive = matchFileSteering(files, path, workspaceRoot).filter((file) => !active.has(file.absolutePath));
    if (inactive.length === 0) continue;
    activatedPaths.push(path);
    for (const file of inactive) {
      if (active.has(file.absolutePath)) continue;
      active.add(file.absolutePath);
      newly.push(file);
    }
  }
  if (activatedPaths.length === 0) return undefined;

  state.activeFileRules = [...active];
  await writeState(pluginData, sessionId, state);

  const target = activatedPaths.join(", ");
  const content =
    newly.length > 0
      ? await renderActivatedRules(newly, workspaceRoot, target)
      : `Kiro fileMatch steering activated for ${target}.`;
  const toolName = String(event.toolName ?? event.tool_name ?? "").toLowerCase();
  if (isAntigravity(event) || MUTATING_TOOLS[toolName] === true) {
    const retry = isAntigravity(event)
      ? `Retry this ${toolName} on the next turn.`
      : "Retry this mutation on the next turn.";
    const reason = clip(
      `${content}\n\n${retry}`,
      `Kiro fileMatch steering was added for ${target}. Read the matching files under .kiro/steering before retrying.`,
    );
    if (isAntigravity(event)) return { decision: "deny", reason };
    return {
      decision: "deny",
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }

  return contextOutput("PreToolUse", content);
}

function contextOutput(hookEventName: string, body: string): GrokHookOutput {
  const additionalContext = clip(body, body);
  return {
    additionalContext,
    hookSpecificOutput: { hookEventName, additionalContext },
  };
}

function clip(text: string, fallback: string): string {
  if (text.length <= GROK_CONTEXT_CAP) return text;
  if (fallback.length <= GROK_CONTEXT_CAP) return fallback;
  const suffix = "\n[truncated]";
  return text.slice(0, GROK_CONTEXT_CAP - suffix.length) + suffix;
}

function hookEventName(event: Record<string, unknown>): string {
  if (typeof event.hook_event_name === "string" && event.hook_event_name !== "") return event.hook_event_name;
  const raw = String(event.hookEventName ?? process.env.GROK_HOOK_EVENT ?? "");
  return raw
    .split("_")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function eventPrompt(event: Record<string, unknown>): string {
  for (const key of ["prompt", "user_prompt", "userPrompt", "text"]) {
    if (typeof event[key] === "string") return event[key] as string;
  }
  return "";
}

function isAntigravity(event: Record<string, unknown>): boolean {
  if (event.agy === true) return true;
  if (hookEventName(event) === "PreInvocation") return true;
  return event.toolCall !== undefined && event.tool_name === undefined && event.toolName === undefined;
}

function normalizeAntigravityTool(event: Record<string, unknown>): Record<string, unknown> {
  const call = event.toolCall;
  if (call === null || typeof call !== "object") return event;
  const record = call as Record<string, unknown>;
  const next: Record<string, unknown> = { ...event };
  if (next.toolName === undefined && next.tool_name === undefined && typeof record.name === "string") {
    next.toolName = record.name;
    next.agy = true;
  }
  if (next.toolInput === undefined && next.tool_input === undefined) next.toolInput = record.args;
  return next;
}

async function latestUserRequest(event: Record<string, unknown>, options: GrokHookOptions): Promise<string> {
  const direct = eventPrompt(event);
  if (direct !== "") return direct;
  const rawPath = event.transcriptPath;
  if (typeof rawPath !== "string" || rawPath === "") return "";
  const home = options.homeDir ?? homedir();
  const path = rawPath === "~" ? home : rawPath.startsWith("~/") ? join(home, rawPath.slice(2)) : rawPath;
  try {
    const info = await stat(path);
    const tail = 64 * 1024;
    const start = info.size > tail ? info.size - tail : 0;
    const file = await open(path, "r");
    try {
      const buffer = new Uint8Array(info.size - start);
      await file.read(buffer, 0, buffer.length, start);
      const lines = new TextDecoder().decode(buffer).split("\n");
      if (start > 0) lines.shift();
      let request = "";
      for (const line of lines) {
        if (line === "") continue;
        try {
          const parsed = JSON.parse(line) as { type?: string; content?: string };
          if (parsed.type !== "USER_INPUT" || typeof parsed.content !== "string") continue;
          const match = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(parsed.content);
          request = match?.[1] ?? parsed.content;
        } catch {
          // A partial line from the transcript tail is not a user request.
        }
      }
      return request;
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

function workspaceOf(event: Record<string, unknown>): string {
  for (const key of ["workspaceRoot", "cwd"]) {
    if (typeof event[key] === "string" && event[key] !== "") return event[key] as string;
  }
  const paths = event.workspacePaths;
  if (Array.isArray(paths)) {
    const first = paths.find((item) => typeof item === "string" && item !== "");
    if (typeof first === "string") return first;
  }
  return process.env.GROK_WORKSPACE_ROOT ?? process.cwd();
}

function sessionOf(event: Record<string, unknown>): string {
  for (const key of ["sessionId", "session_id", "conversationId"]) {
    if (typeof event[key] === "string" && event[key] !== "") return event[key] as string;
  }
  return process.env.GROK_SESSION_ID ?? "unknown";
}

async function loadSteering(event: Record<string, unknown>, options: GrokHookOptions) {
  const workspaceRoot = workspaceOf(event);
  const result = await discoverSteering({
    homeDir: options.homeDir ?? homedir(),
    workspaceRoot,
  });
  return {
    files: result.files,
    errors: result.errors,
    workspaceRoot,
    sessionId: sessionOf(event),
    pluginData:
      options.pluginData ??
      process.env.CLAUDE_PLUGIN_DATA ??
      process.env.GROK_PLUGIN_DATA ??
      (isAntigravity(event)
        ? join(options.homeDir ?? homedir(), ".gemini", "antigravity-cli", "plugin-data", "omp-steering")
        : join(homedir(), ".grok", "plugin-data", "omp-steering")),
  };
}

function statePath(pluginData: string, sessionId: string): string {
  return join(pluginData, "sessions", `${sessionId}.json`);
}

async function readState(pluginData: string, sessionId: string): Promise<SessionState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(pluginData, sessionId), "utf8")) as SessionState;
    return {
      activeFileRules: Array.isArray(parsed.activeFileRules)
        ? parsed.activeFileRules.filter((item) => typeof item === "string")
        : [],
      alwaysDelivered: parsed.alwaysDelivered === true,
    };
  } catch {
    return { activeFileRules: [], alwaysDelivered: false };
  }
}

async function writeState(pluginData: string, sessionId: string, state: SessionState): Promise<void> {
  const path = statePath(pluginData, sessionId);
  await mkdir(join(pluginData, "sessions"), { recursive: true });
  await writeFile(path, `${JSON.stringify(state)}\n`);
}

function formatErrors(errors: string[]): string {
  if (errors.length === 0) return "";
  return `Skipped invalid Kiro steering:\n${errors.join("\n")}`;
}

function joinSections(...sections: string[]): string {
  return sections.filter((section) => section !== "").join("\n\n");
}

if (import.meta.main) {
  const event = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  if (process.env.AGY_HOOK_EVENT) {
    if (event.hookEventName === undefined && event.hook_event_name === undefined) {
      event.hookEventName = process.env.AGY_HOOK_EVENT;
    }
    event.agy = true;
  }
  const result = await handleGrokHook(event);
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
}
