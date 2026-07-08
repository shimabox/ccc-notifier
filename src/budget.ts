// src/budget.ts — 月予算(monthlyBudgetUSD)の表示・設定 CLI。
//
//   ccc-notifier budget            … 現在の月予算と今月の使用率を表示
//   ccc-notifier budget 400        … 月予算を $400 に設定
//   ccc-notifier budget 0          … 月予算を解除(未設定に戻す)
//
// 予算は USD。ダッシュボードでは当月(暦月)の使用額 / 予算 / 使用率(%)を表示する。init からも設定できる。

import { writeFileSync } from "node:fs";
import { formatJPY, formatUSD } from "./format";
import { currentMonthTotals, paths, readConfig } from "./store";

/** "$400" / "400" / "1,000" などを数値に。0 以上の有限数のみ。不正は null。 */
export function parseBudgetAmount(s: string): number | null {
  const cleaned = s.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function showBudget(): void {
  const cfg = readConfig();
  const budget = cfg.monthlyBudgetUSD;
  const { usd, jpy } = currentMonthTotals();

  if (!(budget > 0)) {
    console.log("月予算 / Monthly budget: 未設定 / not set");
    console.log(`今月の使用 / This month: ${formatUSD(usd)}(${formatJPY(jpy)})`);
    console.log("設定するには / to set: ccc-notifier budget <USD>(例: ccc-notifier budget 400)");
    return;
  }

  const pct = (usd / budget) * 100;
  const budgetJpy = budget * cfg.fx.fallbackRate;
  console.log(`月予算 / Monthly budget: ${formatUSD(budget)}(${formatJPY(budgetJpy)})`);
  console.log(
    `今月の使用 / This month: ${formatUSD(usd)} / ${formatUSD(budget)}(${pct.toFixed(1)}% used)`,
  );
  console.log(`  ¥換算 / in JPY: ${formatJPY(jpy)} / ${formatJPY(budgetJpy)}`);
  console.log("解除するには / to clear: ccc-notifier budget 0");
}

export function runBudget(argv: string[]): number {
  const args = argv.filter((a) => a !== "--yes" && a !== "-y");
  const arg = args[0];

  if (arg === undefined || arg === "show" || arg === "--show") {
    showBudget();
    return 0;
  }

  const amount =
    arg === "off" || arg === "none" || arg === "clear" || arg === "--unset"
      ? 0
      : parseBudgetAmount(arg);

  if (amount === null) {
    console.error(
      `金額は 0 以上の数値で指定してください(受領: ${arg})。例: ccc-notifier budget 400 / 解除: ccc-notifier budget 0`,
    );
    return 1;
  }

  const cfg = readConfig();
  cfg.monthlyBudgetUSD = amount;
  writeFileSync(paths().configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  if (amount === 0) {
    console.log("月予算を解除しました(未設定に戻しました)。");
  } else {
    const { usd } = currentMonthTotals();
    const pct = (usd / amount) * 100;
    console.log(
      `月予算を ${formatUSD(amount)} に設定しました。今月の使用: ${formatUSD(usd)}(${pct.toFixed(1)}% used)`,
    );
  }
  return 0;
}
