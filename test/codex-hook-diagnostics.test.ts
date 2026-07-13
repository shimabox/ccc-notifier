import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  diagnoseCodexHookSources,
  discoverCodexHookSources,
  findRepoRootCandidate,
} from "../src/codex/hook-diagnostics";
import { codexHookCommand } from "../src/codex/setup";

describe("Codex hook source diagnostics", () => {
  let root: string;
  let userHome: string;
  let repo: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cccn-hook-sources-"));
    userHome = join(root, "user-codex");
    repo = join(root, "repo");
    cwd = join(repo, "nested", "dir");
    mkdirSync(userHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function owned(event: "Stop" | "SubagentStart" | "SubagentStop" = "Stop") {
    return { type: "command", command: codexHookCommand("/usr/bin/node", "/opt/ccc-notifier/dist/cli.js", event), timeout: 20 };
  }

  it("envなしでuser標準JSON/TOMLとnested repoのproject標準JSON/TOMLを発見する", () => {
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".codex"));
    writeFileSync(join(userHome, "hooks.json"), "{}");
    writeFileSync(join(userHome, "config.toml"), "# opaque");
    writeFileSync(join(repo, ".codex", "hooks.json"), "{}");
    writeFileSync(join(repo, ".codex", "config.toml"), "# opaque");
    const sources = discoverCodexHookSources({ codexHome: userHome, cwd });
    expect(sources.map((s) => [s.scope, s.format, s.discovery])).toEqual([
      ["user", "json", "standard"], ["user", "toml", "standard"],
      ["project", "json", "standard"], ["project", "toml", "standard"],
    ]);
  });

  it(".git fileをworktree rootとして扱い、.git無しならcwdへfallbackする", () => {
    writeFileSync(join(repo, ".git"), "gitdir: elsewhere");
    expect(findRepoRootCandidate(cwd)).toBe(repo);
    rmSync(join(repo, ".git"));
    expect(findRepoRootCandidate(cwd)).toBe(cwd);
  });

  it("env-extraはpath.delimiterで加算し、標準sourceと同じ実体pathを重複させない", () => {
    const standard = join(userHome, "hooks.json");
    const extra = join(root, "extra.toml");
    writeFileSync(standard, "{}");
    writeFileSync(extra, "# opaque");
    const sources = discoverCodexHookSources({
      codexHome: userHome,
      cwd,
      envSources: `${standard}${delimiter}${extra}`,
    });
    expect(sources).toHaveLength(2);
    expect(sources[0].scope).toBe("user");
    expect(sources[1]).toMatchObject({ scope: "env-extra", format: "toml", discovery: "supplemental" });
  });

  it("JSON owned handlerだけをexact検査しsource間duplicateを集計する", () => {
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, ".codex"));
    const json = JSON.stringify({ hooks: { Stop: [{ hooks: [owned(), { type: "command", command: "SECRET-UNKNOWN" }] }] } });
    writeFileSync(join(userHome, "hooks.json"), json);
    writeFileSync(join(repo, ".codex", "hooks.json"), json);
    const result = diagnoseCodexHookSources({ codexHome: userHome, cwd, expectedNodePath: "/usr/bin/node", expectedCliPath: "/opt/ccc-notifier/dist/cli.js" });
    expect(result.handlers).toHaveLength(2);
    expect(result.exactDuplicates).toEqual([{ event: "Stop", count: 2, sources: [join(userHome, "hooks.json"), join(repo, ".codex", "hooks.json")] }]);
    expect(JSON.stringify(result)).not.toContain("SECRET-UNKNOWN");
  });

  it("同一layerのJSON/TOML併存はpotentialだけでTOML内容を解釈しない", () => {
    writeFileSync(join(userHome, "hooks.json"), "{}");
    writeFileSync(join(userHome, "config.toml"), '# [hooks]\ntext = "hooks=false SECRET-TOML"');
    const result = diagnoseCodexHookSources({ codexHome: userHome, cwd, expectedNodePath: "/usr/bin/node", expectedCliPath: "/opt/ccc-notifier/dist/cli.js" });
    expect(result.handlers).toEqual([]);
    expect(result.opaqueSources).toEqual([join(userHome, "config.toml")]);
    expect(result.sameLayerMixedRepresentation).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET-TOML");
  });

  it("malformed/巨大/directory JSONをsource単位で警告し他sourceを止めない", () => {
    const malformed = join(userHome, "hooks.json");
    const huge = join(root, "huge.json");
    const directory = join(root, "directory.json");
    const good = join(root, "good.json");
    writeFileSync(malformed, "{ SECRET-BROKEN");
    writeFileSync(huge, "x".repeat(1024 * 1024 + 1));
    mkdirSync(directory);
    writeFileSync(good, JSON.stringify({ hooks: { Stop: [{ hooks: [owned()] }] } }));
    const result = diagnoseCodexHookSources({
      codexHome: userHome, cwd, expectedNodePath: "/usr/bin/node", expectedCliPath: "/opt/ccc-notifier/dist/cli.js",
      envSources: [huge, directory, good].join(delimiter),
    });
    expect(result.handlers).toHaveLength(1);
    expect(result.warnings).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("SECRET-BROKEN");
  });
});
