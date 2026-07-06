import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTrack } from "../src/track";
import * as store from "../src/store";
import type { TurnRecord } from "../src/types";

// 読み取り専用のゴールデン fixture。実行のたびに一時 dir へコピーして使う(fixture を汚さない)。
const FIXTURE_TRANSCRIPT = fileURLToPath(new URL("./fixtures/transcript-basic.jsonl", import.meta.url));
const FIXTURE_STDIN = fileURLToPath(new URL("./fixtures/stop-hook-stdin.json", import.meta.url));

let tmpHome: string;
let transcriptPath: string;
let prevHome: string | undefined;
let prevDryRun: string | undefined;

beforeEach(() => {
  prevHome = process.env.ACN_HOME;
  prevDryRun = process.env.ACN_DRY_RUN;

  tmpHome = mkdtempSync(join(tmpdir(), "acn-track-test-"));
  process.env.ACN_HOME = tmpHome;
  process.env.ACN_DRY_RUN = "1"; // 実通知せず last-notify.json に書き出す

  // 誤って実ネットワークに出ない保険。fx はフォールバックで fixed(fallbackRate=150)になる。
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

  transcriptPath = join(tmpHome, "transcript.jsonl");
  copyFileSync(FIXTURE_TRANSCRIPT, transcriptPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });

  if (prevHome === undefined) delete process.env.ACN_HOME;
  else process.env.ACN_HOME = prevHome;
  if (prevDryRun === undefined) delete process.env.ACN_DRY_RUN;
  else process.env.ACN_DRY_RUN = prevDryRun;
});

// ---- helpers --------------------------------------------------------------

/** stop-hook-stdin.json の __TRANSCRIPT_PATH__ を実パスへ置換した stdin 文字列を返す。 */
function stdinFor(path: string): string {
  const raw = readFileSync(FIXTURE_STDIN, "utf8");
  // 関数置換で $ 等の特殊パターン展開を避ける。
  return raw.replace("__TRANSCRIPT_PATH__", () => path);
}

function historyFile(): string {
  return join(tmpHome, "history.jsonl");
}

function lastNotifyFile(): string {
  return join(tmpHome, "last-notify.json");
}

function readHistory(): TurnRecord[] {
  if (!existsSync(historyFile())) return [];
  return readFileSync(historyFile(), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TurnRecord);
}

// ---- suite ----------------------------------------------------------------

describe("runTrack", () => {
  // 1. 正常系: GOLDEN 値どおりに1行記録し、通知タイトルに費用が入る。
  it("1. records one golden turn and writes a notification title with the cost", async () => {
    await runTrack(stdinFor(transcriptPath));

    const rows = readHistory();
    expect(rows).toHaveLength(1);
    const rec = rows[0];

    expect(rec.costUSD).toBeCloseTo(0.267, 10);
    expect(rec.costJPY).toBeCloseTo(40.05, 8);
    expect(rec.apiCalls).toBe(2);
    expect(rec.models).toEqual(["claude-fable-5", "claude-haiku-4-5"]);
    expect(rec.prompt).toBe("テスト用プロンプトです");
    expect(rec.fxSource).toBe("fixed");
    expect(rec.fxRate).toBe(150);
    expect(rec.sessionId).toBe("sess-1");
    expect(rec.project).toBe("/tmp/proj");
    expect(rec.gitBranch).toBe("main");
    expect(rec.tokens).toEqual({
      input: 100,
      output: 200,
      cacheWrite5m: 0,
      cacheWrite1h: 10000,
      cacheRead: 50000,
    });
    expect(rec.sidechainTokens).toEqual({
      input: 1000,
      output: 500,
      cacheWrite5m: 2000,
      cacheWrite1h: 0,
      cacheRead: 0,
    });

    const notify = JSON.parse(readFileSync(lastNotifyFile(), "utf8"));
    expect(notify.os.title).toContain("$0.267");
    expect(notify.os.title).toContain("¥40");
    expect(notify.os.title).toContain("API換算");
  });

  // 2. 冪等性: 同一入力の2回目は history も通知も増えない。
  it("2. is idempotent: a second run with the same input adds no row and no notification", async () => {
    const stdin = stdinFor(transcriptPath);

    await runTrack(stdin);
    const notifyAfterFirst = readFileSync(lastNotifyFile(), "utf8");

    await runTrack(stdin);

    expect(readHistory()).toHaveLength(1);
    // 2回目は新規ターンが無く通知が発火しないため、last-notify.json は byte 単位で不変(ts も変わらない)。
    expect(readFileSync(lastNotifyFile(), "utf8")).toBe(notifyAfterFirst);
  });

  // 3. 追記継続: 新しい assistant 行を追記した2回目は新規分のみを記録する。
  it("3. continues from the cursor and records only the newly-appended assistant row", async () => {
    const stdin = stdinFor(transcriptPath);

    await runTrack(stdin);
    expect(readHistory()).toHaveLength(1);

    const newLine = {
      parentUuid: "u3",
      isSidechain: false,
      cwd: "/tmp/proj",
      sessionId: "sess-1",
      gitBranch: "main",
      type: "assistant",
      requestId: "req_C",
      message: {
        id: "msg_C",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: "追記応答" }],
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
      uuid: "c1",
      timestamp: "2026-07-06T10:05:00.000Z",
    };
    // fixture 末尾は改行終端。先頭にも改行を足しておくと、末尾が未終端でも安全(空行はスキップされる)。
    appendFileSync(transcriptPath, "\n" + JSON.stringify(newLine) + "\n", "utf8");

    await runTrack(stdin);

    const rows = readHistory();
    expect(rows).toHaveLength(2);
    const added = rows[1];
    expect(added.costUSD).toBeCloseTo(0.05, 10); // 1000 × 50 / 1e6
    expect(added.models).toEqual(["claude-fable-5"]);
    expect(added.sidechainTokens).toBeNull();
    expect(added.apiCalls).toBe(1);
    expect(added.tokens).toEqual({
      input: 0,
      output: 1000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
    });
  });

  // 4. 不正入力で無害: not json / {} / 存在しないパス でも throw せず history 不変・通知なし。
  it("4. is harmless on invalid input (not-json / {} / missing path)", async () => {
    await expect(runTrack("not json")).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(0);

    await expect(runTrack("{}")).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(0);

    const missing = stdinFor(join(tmpHome, "does-not-exist.jsonl"));
    await expect(runTrack(missing)).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(0);

    expect(existsSync(lastNotifyFile())).toBe(false);
  });

  // 5a. 壊れた cursors.json(不正 JSON): throw せず正常に1行記録。
  it("5a. survives a corrupt (invalid-JSON) cursors.json and still records one row", async () => {
    writeFileSync(join(tmpHome, "cursors.json"), "not valid json {{{", "utf8");

    await expect(runTrack(stdinFor(transcriptPath))).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(1);
  });

  // 5b. カーソル形状破壊: サニタイズで null に落ち、throw せず二重計上なし(1行のまま)。
  it("5b. drops a shape-corrupt cursor via sanitization without double-counting", async () => {
    const broken = { [transcriptPath]: { offset: "abc", seenMessageKeys: 42 } };
    writeFileSync(join(tmpHome, "cursors.json"), JSON.stringify(broken), "utf8");

    await expect(runTrack(stdinFor(transcriptPath))).resolves.toBeUndefined();
    expect(readHistory()).toHaveLength(1);
  });

  // 6. しきい値: minNotifyUSD=1 なら history には記録するが last-notify.json は作られない。
  it("6. records but does not notify when the cost is below minNotifyUSD", async () => {
    writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ minNotifyUSD: 1 }), "utf8");

    await runTrack(stdinFor(transcriptPath));

    expect(readHistory()).toHaveLength(1);
    expect(existsSync(lastNotifyFile())).toBe(false);
  });

  // 7. 順序の検証: appendTurn の後に saveCursor が呼ばれる(通り抜けスパイで呼び出し順を観察)。
  it("7. calls appendTurn before saveCursor", async () => {
    const appendSpy = vi.spyOn(store, "appendTurn");
    const saveSpy = vi.spyOn(store, "saveCursor");

    await runTrack(stdinFor(transcriptPath));

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.invocationCallOrder[0]).toBeLessThan(saveSpy.mock.invocationCallOrder[0]);

    // 通り抜けスパイなので副作用も本物: 実際に1行記録されている。
    expect(readHistory()).toHaveLength(1);
  });
});
