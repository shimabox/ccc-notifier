import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claudeTranscriptRoots,
  defaultClaudeDesktopSessionsRoot,
  determineClaudeSurface,
  discoverDesktopProjectRoots,
  surfaceForClaudePath,
} from "../src/claude-roots";

let dir: string;
let prevProjects: string | undefined;
let prevDesktopRoots: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cccn-claude-roots-"));
  prevProjects = process.env.CCCN_CLAUDE_PROJECTS;
  prevDesktopRoots = process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevProjects === undefined) delete process.env.CCCN_CLAUDE_PROJECTS;
  else process.env.CCCN_CLAUDE_PROJECTS = prevProjects;
  if (prevDesktopRoots === undefined) delete process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
  else process.env.CCCN_CLAUDE_DESKTOP_ROOTS = prevDesktopRoots;
});

describe("claudeTranscriptRoots", () => {
  it("1. 既定は cli ルート1件のみ(CCCN_CLAUDE_DESKTOP_ROOTS 未設定・非 macOS 相当は auto-discovery 対象外)", async () => {
    const projects = join(dir, "claude-projects");
    mkdirSync(projects, { recursive: true });
    process.env.CCCN_CLAUDE_PROJECTS = projects;
    // 明示的に不在パスへ倒し、実マシンの macOS デスクトップ auto-discovery を踏まないようにする。
    process.env.CCCN_CLAUDE_DESKTOP_ROOTS = join(dir, "no-desktop-roots");

    const roots = await claudeTranscriptRoots();
    expect(roots).toEqual([
      { path: projects, surface: "cli" },
      { path: join(dir, "no-desktop-roots"), surface: "desktop" },
    ]);
  });

  it("2. CCCN_CLAUDE_DESKTOP_ROOTS(path.delimiter区切り)が desktop ルートを上書きする", async () => {
    const projects = join(dir, "claude-projects");
    const d1 = join(dir, "d1");
    const d2 = join(dir, "d2");
    mkdirSync(projects, { recursive: true });
    process.env.CCCN_CLAUDE_PROJECTS = projects;
    const { delimiter } = await import("node:path");
    process.env.CCCN_CLAUDE_DESKTOP_ROOTS = `${d1}${delimiter}${d2}`;

    const roots = await claudeTranscriptRoots();
    expect(roots).toEqual([
      { path: projects, surface: "cli" },
      { path: d1, surface: "desktop" },
      { path: d2, surface: "desktop" },
    ]);
  });

  it("3. 存在しないデスクトップルートは黙ってスキップする(エラーにしない)", async () => {
    process.env.CCCN_CLAUDE_PROJECTS = join(dir, "does-not-exist-projects");
    process.env.CCCN_CLAUDE_DESKTOP_ROOTS = join(dir, "does-not-exist-desktop");
    await expect(claudeTranscriptRoots()).resolves.toBeDefined();
  });

  it("4. surfaceForClaudePath は最も具体的なルートの surface を返し、未一致は cli", () => {
    const roots = [
      { path: "/a", surface: "cli" as const },
      { path: "/a/desktop", surface: "desktop" as const },
    ];
    expect(surfaceForClaudePath("/a/desktop/proj/x.jsonl", roots)).toBe("desktop");
    expect(surfaceForClaudePath("/a/proj/x.jsonl", roots)).toBe("cli");
    expect(surfaceForClaudePath("/unrelated/x.jsonl", roots)).toBe("cli");
  });

  // デスクトップルートの自動発見(CCCN_CLAUDE_DESKTOP_ROOTS 未設定時の既定動作)。
  // 深さは非公開レイアウトに依存するため、bounded walk が任意の深さで見つけることを確かめる。
  it("5. bounded 再帰探索: sessions root 配下の任意の深さの .claude/projects を desktop ルートとして発見する", async () => {
    const sessionsRoot = join(dir, "local-agent-mode-sessions");
    const deepProjects = join(sessionsRoot, "id1", "id2", "local_abc", ".claude", "projects");
    const shallowProjects = join(sessionsRoot, "local_xyz", ".claude", "projects");
    mkdirSync(deepProjects, { recursive: true });
    mkdirSync(shallowProjects, { recursive: true });
    // .claude 配下の projects 以外は掘らない(誤検出しないこと)。
    mkdirSync(join(sessionsRoot, "id1", ".claude", "other", "projects"), { recursive: true });
    delete process.env.CCCN_CLAUDE_DESKTOP_ROOTS;

    const roots = await claudeTranscriptRoots({
      projectsOverride: join(dir, "cli-root"),
      desktopSessionsRoot: sessionsRoot,
    });

    expect(roots[0]).toEqual({ path: join(dir, "cli-root"), surface: "cli" });
    const desktop = roots.filter((r) => r.surface === "desktop").map((r) => r.path).sort();
    expect(desktop).toEqual([deepProjects, shallowProjects].sort());
    // 発見したルート配下の transcript は desktop として判定される。
    expect(surfaceForClaudePath(join(deepProjects, "proj", "x.jsonl"), roots)).toBe("desktop");
    expect(surfaceForClaudePath(join(dir, "cli-root", "proj", "x.jsonl"), roots)).toBe("cli");
  });

  it("5b. sessions root が存在しなければ desktop ルートは増えない(エラーにしない)", async () => {
    delete process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
    const roots = await claudeTranscriptRoots({
      projectsOverride: join(dir, "cli-root"),
      desktopSessionsRoot: join(dir, "no-such-sessions-root"),
    });
    expect(roots.filter((r) => r.surface === "desktop")).toHaveLength(0);
  });

  it("5c. discoverDesktopProjectRoots は探索深さの上限を超えたところは見に行かない", async () => {
    const sessionsRoot = join(dir, "sessions-deep");
    // depth 0 から数えて 8 を超える位置に置いた .claude/projects は対象外。
    const tooDeep = join(sessionsRoot, "a", "b", "c", "d", "e", "f", "g", "h", "i", ".claude", "projects");
    mkdirSync(tooDeep, { recursive: true });
    expect(await discoverDesktopProjectRoots(sessionsRoot)).toEqual([]);
  });
});

describe("determineClaudeSurface", () => {
  it("6. CCCN_CLAUDE_DESKTOP_ROOTS 未設定時、既定デスクトップルート配下でないパスは高速パスで cli を返す", async () => {
    delete process.env.CCCN_CLAUDE_DESKTOP_ROOTS;
    const surface = await determineClaudeSurface(join(dir, "unrelated", "x.jsonl"));
    expect(surface).toBe("cli");
  });

  it("7. CCCN_CLAUDE_DESKTOP_ROOTS 設定時はそのルートに従って判定する", async () => {
    const desktopRoot = join(dir, "desktop-root");
    mkdirSync(desktopRoot, { recursive: true });
    process.env.CCCN_CLAUDE_DESKTOP_ROOTS = desktopRoot;
    process.env.CCCN_CLAUDE_PROJECTS = join(dir, "cli-root");

    expect(await determineClaudeSurface(join(desktopRoot, "proj", "x.jsonl"))).toBe("desktop");
    expect(await determineClaudeSurface(join(dir, "cli-root", "proj", "x.jsonl"))).toBe("cli");
  });

  it("8. defaultClaudeDesktopSessionsRoot は macOS 固定パスを返す", () => {
    const p = defaultClaudeDesktopSessionsRoot();
    expect(p).toContain("Claude");
    expect(p).toContain("local-agent-mode-sessions");
  });
});
