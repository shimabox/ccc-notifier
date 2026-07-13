import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";

import {
  CODEX_HOOK_EVENTS,
  CODEX_HOOK_TIMEOUT_SECONDS,
  type CodexHookEventName,
  isOwnedCodexHookCommand,
  parseOwnedCodexHookCommand,
} from "./setup";

export type HookSourceScope = "user" | "project" | "env-extra";
export type HookSourceFormat = "json" | "toml" | "opaque";

export interface HookSourceCandidate {
  path: string;
  scope: HookSourceScope;
  format: HookSourceFormat;
  discovery: "standard" | "supplemental";
  activeState: "unknown";
}

export interface InspectedOwnedHandler {
  sourcePath: string;
  scope: HookSourceScope;
  event: CodexHookEventName;
  nodePath: string;
  cliPath: string;
  timeout: unknown;
  pathMatches: boolean;
  timeoutMatches: boolean;
}

export interface HookDiagnosticWarning {
  sourcePath: string;
  kind: "not-regular" | "too-large" | "read-failed" | "invalid-json" | "invalid-shape" | "nonstandard-feature-field";
}

export interface CodexHookDiagnostics {
  candidates: HookSourceCandidate[];
  inspectedJsonSources: string[];
  opaqueSources: string[];
  handlers: InspectedOwnedHandler[];
  exactDuplicates: Array<{ event: CodexHookEventName; count: number; sources: string[] }>;
  sameLayerMixedRepresentation: Array<{ scope: "user" | "project"; json: string; toml: string }>;
  effectiveState: "unknown";
  warnings: HookDiagnosticWarning[];
}

const MAX_JSON_BYTES = 1024 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAbsolute(path: string): string {
  return normalize(isAbsolute(path) ? path : resolve(path));
}

function normalizedCommandPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function identityPath(path: string): string {
  const absolute = normalizedAbsolute(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function existing(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function findRepoRootCandidate(cwd: string): string {
  const fallback = normalizedAbsolute(cwd);
  let current = fallback;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

function formatFor(path: string): HookSourceFormat {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".toml") return "toml";
  return "opaque";
}

export function discoverCodexHookSources(options: {
  codexHome: string;
  cwd: string;
  envSources?: string;
}): HookSourceCandidate[] {
  const repoRoot = findRepoRootCandidate(options.cwd);
  const candidates: HookSourceCandidate[] = [
    { path: join(options.codexHome, "hooks.json"), scope: "user", format: "json", discovery: "standard", activeState: "unknown" },
    { path: join(options.codexHome, "config.toml"), scope: "user", format: "toml", discovery: "standard", activeState: "unknown" },
    { path: join(repoRoot, ".codex", "hooks.json"), scope: "project", format: "json", discovery: "standard", activeState: "unknown" },
    { path: join(repoRoot, ".codex", "config.toml"), scope: "project", format: "toml", discovery: "standard", activeState: "unknown" },
  ];
  for (const path of (options.envSources ?? "").split(delimiter).filter(Boolean)) {
    candidates.push({
      path: normalizedAbsolute(path),
      scope: "env-extra",
      format: formatFor(path),
      discovery: "supplemental",
      activeState: "unknown",
    });
  }

  const seen = new Set<string>();
  const result: HookSourceCandidate[] = [];
  for (const candidate of candidates) {
    const path = normalizedAbsolute(candidate.path);
    if (!existing(path)) continue;
    const identity = identityPath(path);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({ ...candidate, path });
  }
  return result;
}

function inspectJson(
  source: HookSourceCandidate,
  expectedNodePath: string,
  expectedCliPath: string,
): { handlers: InspectedOwnedHandler[]; warning?: HookDiagnosticWarning; nonstandardFeature: boolean } {
  let stat;
  try {
    stat = statSync(source.path);
  } catch {
    return { handlers: [], warning: { sourcePath: source.path, kind: "read-failed" }, nonstandardFeature: false };
  }
  if (!stat.isFile()) return { handlers: [], warning: { sourcePath: source.path, kind: "not-regular" }, nonstandardFeature: false };
  if (stat.size > MAX_JSON_BYTES) return { handlers: [], warning: { sourcePath: source.path, kind: "too-large" }, nonstandardFeature: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source.path, "utf8"));
  } catch {
    return { handlers: [], warning: { sourcePath: source.path, kind: "invalid-json" }, nonstandardFeature: false };
  }
  if (!isObject(parsed)) return { handlers: [], warning: { sourcePath: source.path, kind: "invalid-shape" }, nonstandardFeature: false };
  if (parsed.hooks !== undefined && !isObject(parsed.hooks)) {
    return { handlers: [], warning: { sourcePath: source.path, kind: "invalid-shape" }, nonstandardFeature: false };
  }
  const hooks = isObject(parsed.hooks) ? parsed.hooks : {};
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups) || groups.some((group) => !isObject(group) || !Array.isArray(group.hooks))) {
      return { handlers: [], warning: { sourcePath: source.path, kind: "invalid-shape" }, nonstandardFeature: false };
    }
  }
  const handlers: InspectedOwnedHandler[] = [];
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (!isObject(handler) || handler.type !== "command" || !isOwnedCodexHookCommand(handler.command, event)) continue;
        const command = parseOwnedCodexHookCommand(handler.command);
        if (command === null) continue;
        handlers.push({
          sourcePath: source.path,
          scope: source.scope,
          event,
          nodePath: command.nodePath,
          cliPath: command.cliPath,
          timeout: handler.timeout,
          pathMatches: command.nodePath === normalizedCommandPath(expectedNodePath) &&
            command.cliPath === normalizedCommandPath(expectedCliPath),
          timeoutMatches: handler.timeout === CODEX_HOOK_TIMEOUT_SECONDS,
        });
      }
    }
  }
  return {
    handlers,
    nonstandardFeature: isObject(parsed.features) && "hooks" in parsed.features,
  };
}

export function diagnoseCodexHookSources(options: {
  codexHome: string;
  cwd: string;
  expectedNodePath: string;
  expectedCliPath: string;
  envSources?: string;
}): CodexHookDiagnostics {
  const candidates = discoverCodexHookSources(options);
  const handlers: InspectedOwnedHandler[] = [];
  const inspectedJsonSources: string[] = [];
  const opaqueSources: string[] = [];
  const warnings: HookDiagnosticWarning[] = [];

  for (const source of candidates) {
    if (source.format !== "json") {
      opaqueSources.push(source.path);
      continue;
    }
    const inspected = inspectJson(source, options.expectedNodePath, options.expectedCliPath);
    if (inspected.warning) warnings.push(inspected.warning);
    else inspectedJsonSources.push(source.path);
    if (inspected.nonstandardFeature) warnings.push({ sourcePath: source.path, kind: "nonstandard-feature-field" });
    handlers.push(...inspected.handlers);
  }

  const exactDuplicates: CodexHookDiagnostics["exactDuplicates"] = [];
  for (const event of CODEX_HOOK_EVENTS) {
    const matches = handlers.filter((handler) => handler.event === event);
    if (matches.length > 1) {
      exactDuplicates.push({ event, count: matches.length, sources: [...new Set(matches.map((handler) => handler.sourcePath))] });
    }
  }

  const sameLayerMixedRepresentation: CodexHookDiagnostics["sameLayerMixedRepresentation"] = [];
  for (const scope of ["user", "project"] as const) {
    const json = candidates.find((source) => source.scope === scope && source.format === "json");
    const toml = candidates.find((source) => source.scope === scope && source.format === "toml");
    if (json && toml) sameLayerMixedRepresentation.push({ scope, json: json.path, toml: toml.path });
  }

  return {
    candidates,
    inspectedJsonSources,
    opaqueSources,
    handlers,
    exactDuplicates,
    sameLayerMixedRepresentation,
    effectiveState: "unknown",
    warnings,
  };
}
