import type { Config, TurnRecord } from "../types";
import { formatSummary } from "../format";
import { appendNotifyError, writeDryRun } from "./util";

const SEND_TIMEOUT_MS = 3000;

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: { type: string; text: string }[];
}

interface SlackPayload {
  blocks: SlackBlock[];
}

/**
 * Slack Incoming Webhook へ通知を送る。通知はベストエフォートであり、
 * どのような失敗が起きても reject しない(本体 Claude Code の処理を妨げない)。
 */
export async function notifySlack(record: TurnRecord, cfg: Config, todayUSD?: number): Promise<void> {
  try {
    const slackCfg = cfg?.notify?.slack;
    const webhookUrl = slackCfg?.webhookUrl;
    if (!webhookUrl) return;

    const { title, body } = formatSummary(record, cfg, todayUSD);
    const line1 = body.split("\n")[0] ?? "";

    const rawPrompt = record.prompt ?? "";
    let promptText: string;
    if (rawPrompt.length === 0) {
      promptText = "(プロンプトなし)";
    } else if (slackCfg.sendFullPrompt) {
      promptText = rawPrompt;
    } else {
      const limit = slackCfg.promptChars;
      promptText = rawPrompt.length > limit ? rawPrompt.slice(0, limit) : rawPrompt;
    }

    const payload: SlackPayload = {
      blocks: [
        { type: "header", text: { type: "plain_text", text: title } },
        { type: "section", text: { type: "mrkdwn", text: line1 } },
        { type: "context", elements: [{ type: "mrkdwn", text: promptText }] },
      ],
    };

    if (process.env.CCCN_DRY_RUN === "1") {
      writeDryRun("slack", { payload });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        appendNotifyError("notifySlack", new Error(`Slack webhook responded with status ${res.status}`));
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    appendNotifyError("notifySlack", err);
  }
}
