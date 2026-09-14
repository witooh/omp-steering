import { expandFileReferences, type SteeringFile } from "./steering.js";

/** `edit` hashline targets live in `[path#TAG]` headers; apply_patch uses `*** Update File:` envelopes. */
const HASHLINE_HEADER = /^\s*\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/gm;
const APPLY_PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const PATH_FIELDS = [
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "filePath",
  "target_file",
  "targetFile",
  "target_directory",
  "targetDirectory",
];

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
      "Before working with a matching file, load and follow its steering file. File tools that expose a matching path also activate these rules.",
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

export async function renderSteeringFile(file: SteeringFile, workspaceRoot: string): Promise<string> {
  const body = await expandFileReferences(file.body, workspaceRoot);
  return `<kiro-steering scope=${JSON.stringify(file.scope)} file=${JSON.stringify(file.displayPath)}>\n${body}\n</kiro-steering>`;
}

export async function renderActivatedRules(
  files: SteeringFile[],
  workspaceRoot: string,
  targetPath: string,
): Promise<string> {
  const rendered = await Promise.all(files.map((file) => renderSteeringFile(file, workspaceRoot)));
  return `Kiro fileMatch steering activated for ${targetPath}:\n\n${rendered.join("\n\n")}`;
}

export function namedSteeringByName(files: SteeringFile[]): Map<string, SteeringFile> {
  const byName = new Map<string, SteeringFile>();
  for (const file of files) {
    if (file.inclusion === "manual" || file.inclusion === "auto") byName.set(file.name, file);
  }
  return byName;
}

/**
 * Every filesystem target the call touches: path-like tool fields (omp `path`/`paths`,
 * Grok `target_file`/`file_path`/`target_directory`), hashline `[path#TAG]` headers, and
 * apply_patch file envelopes. A `read` path may carry a selector suffix (`file.ts:50-200`),
 * so its bare path is offered as well.
 */
export function toolPaths(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const paths = new Set<string>();

  for (const key of PATH_FIELDS) {
    addPathValues(record[key], paths);
  }

  for (const key of ["input", "_input"]) {
    const patch = record[key];
    if (typeof patch !== "string") continue;
    for (const match of patch.matchAll(HASHLINE_HEADER)) paths.add(match[1].trim());
    for (const match of patch.matchAll(APPLY_PATCH_FILE)) paths.add(match[1].trim());
  }

  return [...paths];
}

function addPathValues(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    addPathCandidate(value, paths);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") addPathCandidate(item, paths);
    else if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of PATH_FIELDS) addPathValues(record[key], paths);
    }
  }
}

function addPathCandidate(candidate: string, paths: Set<string>): void {
  if (candidate === "") return;
  const header = /^\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]$/.exec(candidate.trim());
  const path = header ? header[1].trim() : candidate.replace(/^@/, "");
  paths.add(path);
  const selector = path.lastIndexOf(":");
  if (selector > path.lastIndexOf("/")) paths.add(path.slice(0, selector));
}
