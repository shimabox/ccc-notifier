// ============ 環境変数(テスト・サンドボックス用) ============
// ACN_HOME            : データディレクトリ上書き(既定 ~/.agent-cost-notifier)
// ACN_CLAUDE_SETTINGS : Claude settings.json パス上書き(既定 ~/.claude/settings.json)
// ACN_DRY_RUN=1       : 通知を実送信せず、送信ペイロードを ACN_HOME/last-notify.json に書く

export interface TokenBuckets {
  input: number;        // usage.input_tokens
  output: number;       // usage.output_tokens
  cacheWrite5m: number; // usage.cache_creation.ephemeral_5m_input_tokens
  cacheWrite1h: number; // usage.cache_creation.ephemeral_1h_input_tokens
  cacheRead: number;    // usage.cache_read_input_tokens
}

export type UsageByModel = Record<string, TokenBuckets>; // key: message.model (例 "claude-fable-5")

export interface Cursor {
  offset: number;             // 処理済みバイトオフセット
  lastUuid: string | null;    // 整合性検証用
  lastTs: string | null;      // フルリスキャン時の下限(これ以前の行はスキップ)
  seenMessageKeys: string[];  // 直近の "messageId:requestId"(最大500・リングバッファ)
}

export interface TurnAggregate {
  sessionId: string;
  main: UsageByModel;         // isSidechain !== true の集計
  sidechain: UsageByModel;    // isSidechain === true の集計
  apiCalls: number;           // 重複排除後の assistant メッセージ数
  prompt: string | null;      // 期間内の最後の「実ユーザープロンプト」全文
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  newCursor: Cursor;
}

export interface ModelPrice {  // 単位: USD / 100万トークン
  input: number; output: number;
  cacheWrite5m: number; cacheWrite1h: number; cacheRead: number;
  source: 'builtin' | 'litellm';
}
export type PriceTable = Record<string, ModelPrice>; // key: モデルIDプレフィックス(最長一致)

export interface CostBreakdown {
  usd: number;
  byModel: Record<string, number>;
  unknownModels: string[];   // 単価が見つからずコスト0扱いにしたモデル
}

export interface FxResult { rate: number; source: 'live' | 'cache' | 'fixed'; fetchedAt: string; }

export interface TurnRecord {
  schemaVersion: 1;
  ts: string;                // ターン終了時刻(ISO8601)
  sessionId: string;
  project: string;           // cwd
  gitBranch: string | null;
  models: string[];
  tokens: TokenBuckets;      // main 合算
  sidechainTokens: TokenBuckets | null; // sidechain 合算(無ければ null)
  apiCalls: number;
  costUSD: number;           // 丸めず保存(表示時に丸める)
  costByModel?: Record<string, number>; // モデルID → そのターンの USD(main+sidechain 合算、丸めない)
  costJPY: number;
  fxRate: number;
  fxSource: 'live' | 'cache' | 'fixed';
  prompt: string;            // 全文(ローカルのみ)。null 時は ""
  unknownModels?: string[];
  subagents?: {              // サブエージェント枠(旧レコード後方互換のため optional)
    costUSD: number;                     // サブエージェント合計(丸めない)
    costByModel: Record<string, number>; // モデルID → USD
    tokens: TokenBuckets;                // 全エージェント合算
    apiCalls: number;                    // 重複排除後メッセージ数
    agentFiles: number;                  // 今回集計対象になったファイル数
  };
}

export interface SlackConfig { webhookUrl: string; promptChars: number; sendFullPrompt: boolean; }

export interface Config {
  notify: { os: boolean; slack: SlackConfig | null };
  minNotifyUSD: number;                    // 既定 0
  costLabel: 'api_equivalent' | 'actual';  // 既定 'api_equivalent'
  fx: { fallbackRate: number; cacheHours: number }; // 既定 150 / 12
  includeDailyTotal: boolean;              // 既定 true
  dashboard: {
    autoRegenerate: boolean;  // track 実行のたびに report.html を再生成する(既定 true)
    autoReloadSec: number;    // 生成 HTML の自動リロード間隔秒。0 で無効(既定 30)
    days: number;             // 自動再生成時の対象期間(既定 30)
  };
}

export const DEFAULT_CONFIG: Config = {
  notify: { os: true, slack: null },
  minNotifyUSD: 0,
  costLabel: 'api_equivalent',
  fx: { fallbackRate: 150, cacheHours: 12 },
  includeDailyTotal: true,
  dashboard: { autoRegenerate: true, autoReloadSec: 30, days: 30 },
};

export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  [k: string]: unknown;      // 未知フィールドは無視(将来互換)
}
