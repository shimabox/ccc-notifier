import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { codexHome } from "./env";

export const CODEX_HOOK_EVENTS = ["Stop", "SubagentStart", "SubagentStop"] as const;
export type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];
export const CODEX_HOOK_TIMEOUT_SECONDS = 20;

export interface CodexHookResult {
  status: "written" | "unchanged" | "manual";
  backupPath: string | null;
  manualSnippet?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function codexHooksFile(): string {
  return join(codexHome(), "hooks.json");
}

function normalizeExecutablePath(value: string): string {
  return process.platform === "win32" ? value.replace(/\\/g, "/") : value;
}

interface ParsedOwnedCommand {
  nodePath: string;
  cliPath: string;
  event: CodexHookEventName;
}

/** A dedicated internal subcommand makes ownership testable without substring matching. */
export function codexHookCommand(
  nodePath: string,
  cliPath: string,
  event: CodexHookEventName = "Stop",
): string {
  const node = normalizeExecutablePath(nodePath);
  const cli = normalizeExecutablePath(cliPath);
  return `"${node}" "${cli}" __ccc-notifier-codex-hook ${event}`;
}

function tokenize(command: string): string[] | null {
  const result: string[] = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gy;
  let offset = 0;
  while (offset < command.length) {
    re.lastIndex = offset;
    const match = re.exec(command);
    if (!match) return null;
    result.push(match[1] ?? match[2] ?? match[3]);
    offset = re.lastIndex;
  }
  return result;
}

function isLegacyOwnedCommand(command: string): boolean {
  const tokens = tokenize(command);
  return tokens !== null && tokens.length === 4 && isCccNotifierExecutablePair(tokens[0], tokens[1]) &&
    tokens[2] === "track" && tokens[3] === "--codex";
}

function isCccNotifierExecutablePair(nodePath: string, cliPath: string): boolean {
  const node = normalizeExecutablePath(nodePath);
  const cli = normalizeExecutablePath(cliPath);
  const nodeAbsolute = node.startsWith("/") || /^[a-z]:\//i.test(node);
  const cliAbsolute = cli.startsWith("/") || /^[a-z]:\//i.test(cli);
  return nodeAbsolute && cliAbsolute && /(^|\/)node(?:\.exe)?$/i.test(node) &&
    /\/(?:ccc-notifier\/dist|ccc-notifier-dist)\/cli\.js$/i.test(cli);
}

export function parseOwnedCodexHookCommand(command: unknown): ParsedOwnedCommand | null {
  if (typeof command !== "string") return null;
  const tokens = tokenize(command);
  if (tokens === null || tokens.length !== 4 || tokens[2] !== "__ccc-notifier-codex-hook") return null;
  if (!CODEX_HOOK_EVENTS.includes(tokens[3] as CodexHookEventName)) return null;
  if (!isCccNotifierExecutablePair(tokens[0], tokens[1])) return null;
  return {
    nodePath: normalizeExecutablePath(tokens[0]),
    cliPath: normalizeExecutablePath(tokens[1]),
    event: tokens[3] as CodexHookEventName,
  };
}

export function isOwnedCodexHookCommand(command: unknown, event?: CodexHookEventName): boolean {
  const parsed = parseOwnedCodexHookCommand(command);
  return parsed !== null && (event === undefined || parsed.event === event);
}

function isOwnedHandler(value: unknown, event: CodexHookEventName): boolean {
  if (!isPlainObject(value) || value.type !== "command") return false;
  if (isOwnedCodexHookCommand(value.command, event)) return true;
  // Only the exact historical command shape is recognized for a one-time Stop upgrade.
  return event === "Stop" && typeof value.command === "string" && isLegacyOwnedCommand(value.command);
}

function canonicalHandler(command: string): Record<string, unknown> {
  return { type: "command", command, timeout: CODEX_HOOK_TIMEOUT_SECONDS };
}

function manualSnippet(nodePath: string, cliPath: string): string {
  const hooks = Object.fromEntries(
    CODEX_HOOK_EVENTS.map((event) => [
      event,
      [{ hooks: [canonicalHandler(codexHookCommand(nodePath, cliPath, event))] }],
    ]),
  );
  return JSON.stringify({ hooks }, null, 2);
}

function backup(path: string): string {
  const backupPath = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function write(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateShape(root: Record<string, unknown>): Record<string, unknown> | null {
  if (root.hooks !== undefined && !isPlainObject(root.hooks)) return null;
  const hooks = (root.hooks ?? {}) as Record<string, unknown>;
  for (const event of CODEX_HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) return null;
    const groups = (hooks[event] ?? []) as unknown[];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return null;
    }
  }
  return hooks;
}

/** Adds/updates only our handler inside each event group; all siblings and unknown keys survive. */
export function registerCodexHook(nodePath: string, cliPath: string): CodexHookResult {
  const path = codexHooksFile();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const hooks: Record<string, unknown> = {};
    for (const event of CODEX_HOOK_EVENTS) {
      hooks[event] = [{ hooks: [canonicalHandler(codexHookCommand(nodePath, cliPath, event))] }];
    }
    write(path, { hooks });
    return { status: "written", backupPath: null };
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "manual", backupPath: null, manualSnippet: manualSnippet(nodePath, cliPath) };
  }
  if (!isPlainObject(parsed)) {
    return { status: "manual", backupPath: null, manualSnippet: manualSnippet(nodePath, cliPath) };
  }
  const hooks = validateShape(parsed);
  if (hooks === null) {
    return { status: "manual", backupPath: null, manualSnippet: manualSnippet(nodePath, cliPath) };
  }

  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = (hooks[event] ?? []) as Array<Record<string, unknown>>;
    const wanted = canonicalHandler(codexHookCommand(nodePath, cliPath, event));
    let found = false;
    const groupsToRemove = new Set<Record<string, unknown>>();
    for (const group of groups) {
      const handlers = group.hooks as unknown[];
      for (let i = 0; i < handlers.length; i++) {
        if (!isOwnedHandler(handlers[i], event)) continue;
        if (!found) {
          found = true;
          const current = handlers[i];
          const needsUpdate = !isPlainObject(current) || current.type !== wanted.type ||
            current.command !== wanted.command || current.timeout !== wanted.timeout;
          if (needsUpdate) {
            handlers[i] = isPlainObject(current) ? { ...current, ...wanted } : wanted;
            changed = true;
          }
        } else {
          handlers.splice(i--, 1);
          changed = true;
          if (handlers.length === 0) groupsToRemove.add(group);
        }
      }
    }
    if (!found) {
      groups.push({ hooks: [wanted] });
      changed = true;
    }
    const retainedGroups = groups.filter((group) => !groupsToRemove.has(group));
    if (retainedGroups.length !== groups.length) changed = true;
    hooks[event] = retainedGroups;
  }

  if (!changed) return { status: "unchanged", backupPath: null };
  const backupPath = backup(path);
  parsed.hooks = hooks;
  write(path, parsed);
  return { status: "written", backupPath };
}

/** Removes only handlers we own; an empty matcher group/event is removed, siblings are untouched. */
export function removeCodexHook(): CodexHookResult {
  const path = codexHooksFile();
  if (!existsSync(path)) return { status: "unchanged", backupPath: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { status: "unchanged", backupPath: null };
  }
  if (!isPlainObject(parsed)) return { status: "unchanged", backupPath: null };
  const hooks = validateShape(parsed);
  if (hooks === null) return { status: "unchanged", backupPath: null };

  let changed = false;
  for (const event of CODEX_HOOK_EVENTS) {
    const original = (hooks[event] ?? []) as Array<Record<string, unknown>>;
    const groups: Array<Record<string, unknown>> = [];
    for (const group of original) {
      const handlers = group.hooks as unknown[];
      const filtered = handlers.filter((handler) => !isOwnedHandler(handler, event));
      const removedOwned = filtered.length !== handlers.length;
      if (removedOwned) changed = true;
      if (!removedOwned) groups.push(group);
      else if (filtered.length > 0) groups.push({ ...group, hooks: filtered });
    }
    if (groups.length === 0) {
      if (event in hooks) delete hooks[event];
    } else {
      hooks[event] = groups;
    }
  }
  if (!changed) return { status: "unchanged", backupPath: null };
  const backupPath = backup(path);
  write(path, parsed);
  return { status: "written", backupPath };
}
