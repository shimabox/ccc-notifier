import { describe, expect, it } from "vitest";
import { normalizeCodexOriginator } from "../src/codex/originator";

describe("normalizeCodexOriginator", () => {
  it("1. 実機で確認された originator 分布(2026-07-23調査)をすべて正規化する", () => {
    expect(normalizeCodexOriginator("codex-tui")).toBe("cli");
    expect(normalizeCodexOriginator("codex_cli_rs")).toBe("cli");
    expect(normalizeCodexOriginator("codex_exec")).toBe("cli");
    expect(normalizeCodexOriginator("Codex Desktop")).toBe("desktop");
    expect(normalizeCodexOriginator("codex_desktop")).toBe("desktop");
    expect(normalizeCodexOriginator("codex_work_desktop")).toBe("desktop");
    expect(normalizeCodexOriginator("codex_vscode")).toBe("vscode");
    expect(normalizeCodexOriginator("Claude Code")).toBe("claude-code");
    expect(normalizeCodexOriginator("codex-chrome-extension-sidepanel")).toBe("chrome-extension");
  });

  it("2. 未知の originator は other へフォールバックする", () => {
    expect(normalizeCodexOriginator("some-future-client")).toBe("other");
  });

  it("3. 欠損(null/undefined/空文字)も other へフォールバックする", () => {
    expect(normalizeCodexOriginator(null)).toBe("other");
    expect(normalizeCodexOriginator(undefined)).toBe("other");
    expect(normalizeCodexOriginator("")).toBe("other");
  });
});
