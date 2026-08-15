// src/scan.ts — `cccn scan` サブコマンド。ingest(src/ingest.ts)の手動実行。
//
// hook(Stop)の発火に依存せず、Claude デスクトップのサンドボックス transcript や
// Codex Desktop の未追跡 rollout を含めて増分取り込みを行う。sweep(全リセット再構築)とは別物で、
// 既存の history / cursors を破壊しない追記型。

import { formatJPY, formatTokens, formatUSD } from "./format";
import { runIngest, notifyIngestSummary } from "./ingest";
import { readConfig } from "./store";

interface ScanFlags {
  dryRun: boolean;
  json: boolean;
}

function parseScanFlags(argv: string[]): { flags: ScanFlags } | { error: string } {
  const flags: ScanFlags = { dryRun: false, json: false };
  for (const a of argv) {
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--json") flags.json = true;
    else return { error: `不明なoptionまたは余分な引数です: ${a}` };
  }
  return { flags };
}

export async function runScan(argv: string[]): Promise<number> {
  const parsed = parseScanFlags(argv);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n使い方 / Usage: ccc-notifier scan [--dry-run] [--json]`);
    return 1;
  }
  const { dryRun, json } = parsed.flags;

  const result = await runIngest({ dryRun, offlinePricing: false });
  if (!dryRun && !result.lockAcquired) {
    console.error("scan の data lock を取得できませんでした。後でもう一度お試しください");
    return 1;
  }

  if (!dryRun && result.records.length > 0) {
    const cfg = readConfig();
    await notifyIngestSummary(result, cfg);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          dryRun: result.dryRun,
          records: result.records.length,
          scannedFiles: result.scannedFiles,
          skippedByMtime: result.skippedByMtime,
          failures: result.failures,
          totalUSD: result.totalUSD,
          totalJPY: result.totalJPY,
          totalTokens: result.totalTokens,
          cacheTokens: result.cacheTokens,
          bySurface: result.bySurface,
        },
        null,
        2,
      ),
    );
    return result.failures > 0 ? 1 : 0;
  }

  if (dryRun) console.log("(dry-run: 書き込みは行っていません)");
  console.log(
    `走査: 対象 ${result.scannedFiles}ファイル(mtime変化なしでスキップ ${result.skippedByMtime}件) / 失敗 ${result.failures}件`,
  );
  if (result.records.length === 0) {
    console.log("新規取り込みはありませんでした");
  } else {
    const cachePct = result.totalTokens > 0 ? Math.round((result.cacheTokens / result.totalTokens) * 100) : 0;
    const tokensPart = result.totalTokens > 0 ? `、計 ${formatTokens(result.totalTokens)} tokens(cache ${cachePct}%)` : "";
    console.log(
      `取り込み: ${result.records.length} ターン、合計 ${formatUSD(result.totalUSD)}(${formatJPY(result.totalJPY)})${tokensPart}`,
    );
    const bySurface = Object.entries(result.bySurface).sort((a, b) => (b[1]?.usd ?? 0) - (a[1]?.usd ?? 0));
    for (const [surface, v] of bySurface) {
      if (!v) continue;
      console.log(`  ${surface}: ${v.turns}ターン ${formatUSD(v.usd)}`);
    }
  }

  return result.failures > 0 ? 1 : 0;
}
