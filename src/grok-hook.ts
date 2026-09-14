import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** Grok clips PreToolUse deny reasons and additionalContext at 10_000 characters. */
export const GROK_CONTEXT_CAP = 10_000;

const MUTATING_TOOLS = new Set([
  "search_replace",
  "write",
  "edit",
  "apply_patch",
  "ast_edit",
  "multiedit",
  "strreplace",
]);

export interface GrokHookOptions {
  homeDir?: string;
  pluginData?: string;
}

export interface GrokHookOutput {
  decision?: string;
  reason?: string;
  additionalContext?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
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
  if (name === "PreToolUse") return preToolUse(event, options);
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
  if (MUTATING_TOOLS.has(toolName)) {
    const reason = clip(
      `${content}\n\nRetry this mutation on the next turn.`,
      `Kiro fileMatch steering was added for ${target}. Read the matching files under .kiro/steering before retrying this mutation.`,
    );
    return { decision: "deny", reason };
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

function workspaceOf(event: Record<string, unknown>): string {
  for (const key of ["workspaceRoot", "cwd"]) {
    if (typeof event[key] === "string" && event[key] !== "") return event[key] as string;
  }
  return process.env.GROK_WORKSPACE_ROOT ?? process.cwd();
}

function sessionOf(event: Record<string, unknown>): string {
  for (const key of ["sessionId", "session_id"]) {
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
      options.pluginData ?? process.env.GROK_PLUGIN_DATA ?? join(homedir(), ".grok", "plugin-data", "omp-steering"),
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
  const result = await handleGrokHook(event);
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
}
