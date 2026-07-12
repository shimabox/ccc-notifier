import path from "node:path";
import type { Config, TurnRecord } from "./types";

// ============ 数値フォーマット ============

/**
 * USD 表示。
 * n < 0.01 → 小数4桁 / n < 1 → 小数3桁 / それ以上 → 小数2桁
 * 例: "$0.0009" "$0.267" "$1.23"
 */
export function formatUSD(n: number): string {
  const digits = n < 0.01 ? 4 : n < 1 ? 3 : 2;
  return `$${n.toFixed(digits)}`;
}

/**
 * JPY 表示。
 * n < 1 → 小数1桁 / それ以上 → 四捨五入した整数をカンマ区切り
 * 例: "¥0.4" "¥40" "¥1,234"
 */
export function formatJPY(n: number): string {
  if (n < 1) {
    return `¥${n.toFixed(1)}`;
  }
  return `¥${groupThousands(Math.round(n))}`;
}

/**
 * トークン数表示。
 * n < 1000 → そのまま / n < 1e6 → 小数1桁 + "k" / それ以上 → 小数1桁 + "M"
 * 例: "999" "12.3k" "1.2M"
 */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function groupThousands(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(n));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function capitalize(token: string): string {
  if (token.length === 0) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

const ALPHA_ONLY = /^[A-Za-z]+$/;
const NUMERIC_ONLY = /^\d+$/;

/**
 * モデル ID から表示名を組み立てる。
 * - "claude-" プレフィックス / 日付サフィックス(-20\d{6}) / "[1m]" を除去
 * - "-" 区切りの先頭トークンが英字ならそれを名前(Capitalize)とし、
 *   残る数値トークンを "." で結合したバージョンを付与する
 *   (例: fable-5 → "Fable 5" / haiku-4-5 → "Haiku 4.5")
 * - 旧形式 "3-5-haiku" のように数値トークンが先に来る場合は、
 *   唯一の英字トークンを名前、数値トークン群(出現順)をバージョンとする
 *   (例: 3-5-haiku → "Haiku 3.5")
 * - 解釈できない場合は入力をそのまま返す
 */
export function modelDisplayName(id: string): string {
  // OpenAI Codex CLI 対応: "gpt-" プレフィックスは "GPT-" に、末尾の "-codex" サフィックスは
  // " Codex" に変換する(バージョン部はそのまま)。例: gpt-5.5 → "GPT-5.5" / gpt-5-codex → "GPT-5 Codex"。
  // o3 系はここに該当せず、以降の claude 系ロジックにも一致しないため末尾のフォールバック(id をそのまま
  // 返す)で "o3" が維持される。既存の claude 系ロジックは無変更。
  if (id.startsWith("gpt-")) {
    return `GPT-${id.slice(4)}`.replace(/-codex$/, " Codex");
  }

  let s = id;
  s = s.replace(/^claude-/, "");
  s = s.replace(/-20\d{6}/, "");
  s = s.replace(/\[1m\]/gi, "");

  const tokens = s.split("-").filter((t) => t.length > 0);
  if (tokens.length === 0) return id;

  if (ALPHA_ONLY.test(tokens[0])) {
    const name = capitalize(tokens[0]);
    const versionTokens = tokens.slice(1).filter((t) => NUMERIC_ONLY.test(t));
    return versionTokens.length > 0 ? `${name} ${versionTokens.join(".")}` : name;
  }

  // 旧形式: 数値トークンが先。唯一の英字トークンを名前として採用する。
  const alphaTokens = tokens.filter((t) => ALPHA_ONLY.test(t));
  const numericTokens = tokens.filter((t) => NUMERIC_ONLY.test(t));
  if (alphaTokens.length === 1 && numericTokens.length > 0) {
    const name = capitalize(alphaTokens[0]);
    return `${name} ${numericTokens.join(".")}`;
  }

  return id;
}

// ============ サマリー整形 ============

export interface FormattedSummary {
  title: string;
  body: string;
}

/**
 * 通知用のタイトル・本文を組み立てる。
 */
export function formatSummary(record: TurnRecord, cfg: Config, todayUSD?: number): FormattedSummary {
  const label = cfg.costLabel === "api_equivalent" ? "API換算 " : "";
  const models = record.models;
  const primaryModel = models[0] ?? "unknown";
  const modelDisp = modelDisplayName(primaryModel) + (models.length > 1 ? ` +${models.length - 1}` : "");

  const title = `💰 ${label}${formatUSD(record.costUSD)}(${formatJPY(record.costJPY)})| ${modelDisp}`;

  const main = record.tokens;
  const side = record.sidechainTokens;

  const effIn =
    main.input +
    main.cacheRead +
    main.cacheWrite5m +
    main.cacheWrite1h +
    (side ? side.input + side.cacheRead + side.cacheWrite5m + side.cacheWrite1h : 0);

  const out = main.output + (side ? side.output : 0);

  const cacheTokens =
    main.cacheRead +
    main.cacheWrite5m +
    main.cacheWrite1h +
    (side ? side.cacheRead + side.cacheWrite5m + side.cacheWrite1h : 0);

  const cachePct = effIn > 0 ? Math.round((cacheTokens / effIn) * 100) : 0;

  const projectLabel = path.basename(record.project) || record.project;

  let line1 = `in ${formatTokens(effIn)}(cache ${cachePct}%)/ out ${formatTokens(out)} · 📁 ${projectLabel}`;

  if (cfg.includeDailyTotal && typeof todayUSD === "number") {
    line1 += ` · 今日: ${formatUSD(todayUSD)}`;
  }

  const flattened = (record.prompt ?? "").replace(/\r?\n/g, " ");
  let line2: string;
  if (flattened.length === 0) {
    line2 = "(プロンプトなし)";
  } else if (flattened.length > 50) {
    line2 = `${flattened.slice(0, 50)}…`;
  } else {
    line2 = flattened;
  }

  return { title, body: `${line1}\n${line2}` };
}
