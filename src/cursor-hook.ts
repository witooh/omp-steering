import { homedir } from "node:os";
import { join } from "node:path";
import { handleGrokHook } from "./grok-hook.js";

const MUTATING_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  strreplace: true,
  search_replace: true,
  apply_patch: true,
  ast_edit: true,
  multiedit: true,
};

export interface CursorHookOptions {
  homeDir?: string;
  pluginData?: string;
}

export interface CursorHookOutput {
  additional_context?: string;
  permission?: "deny";
  agent_message?: string;
  user_message?: string;
}

export async function handleCursorHook(
  event: Record<string, unknown>,
  options: CursorHookOptions = {},
): Promise<CursorHookOutput | undefined> {
  const eventName = cursorEventName(event);
  const result = await handleGrokHook(adaptEvent(event, eventName), {
    homeDir: options.homeDir,
    pluginData:
      options.pluginData ?? process.env.CURSOR_PLUGIN_DATA ?? join(homedir(), ".cursor", "plugin-data", "omp-steering"),
  });
  if (result === undefined) return undefined;

  if (result.decision === "deny") {
    const message =
      result.reason ?? "Kiro fileMatch steering blocked this action. Retry after reading the matching steering file.";
    const toolName = String(event.tool_name ?? event.toolName ?? "").toLowerCase();
    if (eventName === "preToolUse" && MUTATING_TOOLS[toolName] === true) {
      return {
        permission: "deny",
        agent_message: message,
        user_message: "Kiro fileMatch steering blocked this edit once. Retry after the steering is in context.",
      };
    }
    return { additional_context: message };
  }

  const body = result.additionalContext ?? result.hookSpecificOutput?.additionalContext;
  if (body === undefined || body === "") return undefined;
  return { additional_context: body };
}

function cursorEventName(event: Record<string, unknown>): string {
  const raw = String(event.hook_event_name ?? event.hookEventName ?? "");
  if (raw === "SessionStart") return "sessionStart";
  if (raw === "UserPromptSubmit") return "beforeSubmitPrompt";
  if (raw === "PreToolUse") return "preToolUse";
  return raw;
}

function adaptEvent(event: Record<string, unknown>, eventName: string): Record<string, unknown> {
  const workspace = workspaceOf(event);
  const sessionId = sessionOf(event);
  if (eventName === "sessionStart") {
    return { ...event, hook_event_name: "SessionStart", cwd: workspace, sessionId };
  }
  if (eventName === "beforeSubmitPrompt") {
    return { ...event, hook_event_name: "UserPromptSubmit", cwd: workspace, sessionId, prompt: event.prompt };
  }
  const filePath = typeof event.file_path === "string" ? { file_path: event.file_path } : {};
  return {
    ...event,
    hook_event_name: "PreToolUse",
    cwd: workspace,
    sessionId,
    toolName: event.tool_name ?? event.toolName,
    toolInput: event.tool_input ?? event.toolInput ?? filePath,
  };
}

function workspaceOf(event: Record<string, unknown>): string {
  if (typeof event.cwd === "string" && event.cwd !== "") return event.cwd;
  if (Array.isArray(event.workspace_roots)) {
    const first = event.workspace_roots.find((item) => typeof item === "string" && item !== "");
    if (typeof first === "string") return first;
  }
  return process.env.CURSOR_PROJECT_DIR ?? process.cwd();
}

function sessionOf(event: Record<string, unknown>): string {
  for (const key of ["conversation_id", "session_id", "sessionId"]) {
    if (typeof event[key] === "string" && event[key] !== "") return event[key] as string;
  }
  return "unknown";
}

if (import.meta.main) {
  const event = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  const result = await handleCursorHook(event);
  if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
}
