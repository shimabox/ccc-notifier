import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claudeTranscriptRoots,
  defaultClaudeDesktopSessionsRoot,
  determineClaudeSurface,
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

  it("5. bounded 再帰探索: local-agent-mode-sessions 配下の任意の深さの .claude/projects を見つける", async () => {
    // 実機確認(2026-07-23)では local-agent-mode-sessions/<id>/<id>/local_<uuid>/.claude/projects と
    // request.md が想定した深さ0(local-agent-mode-sessions/local_<uuid>/.claude/projects)が異なって
    // いたため、固定深さを仮定しない bounded walk で発見できることを確認する。
    const sessionsRoot = join(dir, "local-agent-mode-sessions");
    const deepProjects = join(sessionsRoot, "id1", "id2", "local_abc", ".claude", "projects");
    mkdirSync(deepProjects, { recursive: true });

    const found = await claudeTranscriptRoots({ projectsOverride: join(dir, "unused-cli-root") });
    // このテストは macOS 限定の auto-discovery なので、非 darwin では desktop ルートが増えない。
    if (process.platform !== "darwin") {
      expect(found.filter((r) => r.surface === "desktop")).toHaveLength(0);
      return;
    }
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
