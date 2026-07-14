import { promises as fsp } from "node:fs";
import { join, resolve } from "node:path";

const CODEX_MAX_DEPTH = 4;

export interface CodexRolloutDiscovery {
  rollouts: string[];
  unreadableDirs: number;
}

export interface LatestCodexRolloutDiscovery {
  latest: string | null;
  unreadableDirs: number;
  unreadableFiles: number;
}

/** Read-only bounded discovery shared by sweep and doctor. Symlinks are never followed. */
export async function listCodexRollouts(sessionsRoot: string): Promise<CodexRolloutDiscovery> {
  const rollouts: string[] = [];
  let unreadableDirs = 0;
  const root = resolve(sessionsRoot);
  const rootStat = await fsp.lstat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    return { rollouts, unreadableDirs: 1 };
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      unreadableDirs += 1;
      return;
    }
    for (const entry of entries) {
      const full = resolve(join(dir, entry.name));
      if (entry.isFile()) {
        if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) rollouts.push(full);
      } else if (entry.isDirectory() && depth < CODEX_MAX_DEPTH) {
        await walk(full, depth + 1);
      }
    }
  };

  await walk(root, 1);
  return { rollouts, unreadableDirs };
}

/** Latest is mtime-max; ties select the lexicographically smaller normalized absolute path. */
export async function findLatestCodexRollout(sessionsRoot: string): Promise<LatestCodexRolloutDiscovery> {
  const discovery = await listCodexRollouts(sessionsRoot);
  let latest: string | null = null;
  let latestMtime = -Infinity;
  let unreadableFiles = 0;

  for (const path of discovery.rollouts) {
    const stat = await fsp.lstat(path).catch(() => null);
    if (stat === null || !stat.isFile()) {
      unreadableFiles += 1;
      continue;
    }
    if (stat.mtimeMs > latestMtime ||
      (stat.mtimeMs === latestMtime && (latest === null || path < latest))) {
      latest = path;
      latestMtime = stat.mtimeMs;
    }
  }

  return { latest, unreadableDirs: discovery.unreadableDirs, unreadableFiles };
}
