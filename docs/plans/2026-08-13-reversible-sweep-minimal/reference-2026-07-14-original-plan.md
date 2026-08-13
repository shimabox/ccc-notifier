# 可逆な sweep バックフィル実装計画

- 作成日: 2026-07-14
- 対象ブランチ: `plan/reversible-sweep-backfill`
- 状態: **実装前計画**
- 対象: Claude Code / Codex CLI の `sweep`、履歴、カーソル、再走査・再構築
- このファイルは計画専用であり、コミットしない
- 本計画作成時点ではソースコード・テスト・既存PLAN/REPORTを変更しない

## 1. 目的

利用者が次の直感的な手順を安全に実行できるようにする。

```bash
# まず直近7日を確認する
ccc-notifier sweep --dry-run --days 7

# 問題なければ直近7日を実際に取り込む
ccc-notifier sweep --days 7

# 後日、残りの全期間を確認して取り込む
ccc-notifier sweep --dry-run
ccc-notifier sweep
```

確定する利用者向け契約は次のとおり。

1. `sweep --days 7` は直近7日だけを実際に取り込む。
2. 7日より古い履歴は「処理済みとして破棄」せず、未取り込みとして残す。
3. 後から引数なしの `sweep` を実行すると、先に取り込んだ7日分を重複させず、残りだけを取り込む。
4. 同じコマンドを何度実行しても二重計上しない。
5. `history clear` / `history redact` の削除・秘匿意図は通常の `sweep` や安全な再走査で勝手に取り消さない。
6. カーソル破損や過去の取りこぼしを調べる安全な `--rescan` と、利用者が明示的に復元を選ぶ `--rebuild` を分ける。
7. Claude Code と Codex CLI の異なるログ形式を、同じ利用者向け意味論で扱う。

## 2. 現状と根本原因

### 2.1 現在の `--days` は取り込み範囲ではなく破棄範囲を作る

現在の `src/sweep.ts` は、Claude・Codexともログをカーソルから末尾まで読み、期間外のターンを履歴へ書かない一方、カーソルは末尾まで保存する。

- Claude: `processTranscript()` が期間外draftを除外した後、全windowの `newCursor` を保存する。
- Codex: `processCodexRollout()` が期間外draftを除外した後、最後のdraftの `newCursor` を保存する。
- 現在のテストも「`--days 0` 後に無制限sweepしても古い履歴は復活しない」を期待値として固定している。

単一のEOFカーソルは「この位置より前はすべて処理済み」という連続した範囲しか表せない。最近分だけを取り込み、より古いprefixを未処理として残す「穴あき状態」を表現できないことが根本原因である。

### 2.2 カーソルは高速化と二重計上防止を兼務している

現在の `cursors.json` は次を同時に担う。

- 次回の読み始め位置
- hookとsweepの相互排他
- Claudeの直近500件の `message.id + requestId` 去重
- Codexの累積token counter baseline
- transcript切詰め時の再走査下限

このため、単純に `--days` 実行時だけカーソルを進めない案は採用できない。最近分を履歴へ追加した後にhookが古い位置から読み直し、過去分と最近分をまとめて再計上するためである。直近500件のリングだけでは全履歴の重複を保証できない。

### 2.3 Claudeサブエージェントには期間・active判定の穴がある

現行の `collectSubagentUsage()` は、メインtranscriptの兄弟にある `subagents/agent-*.jsonl` を独立カーソルで集計するが、次の制約がある。

- `--days` cutoffが子ファイルのターンへ直接適用されない。
- active-session guardはメインtranscriptのmtimeだけを見ており、子ファイルのmtimeを確認しない。
- 回収した全サブエージェント利用量を「今回の最後の新規親ターン」へ付け、親ターンがなければSA-onlyレコードにする。

そのため、直近7日の親だけを取り込む操作で古いSA利用量が混ざる、またはメインが静止していて子だけ実行中の状態で子カーソルを先に消費する可能性がある。

### 2.4 Codexは累積counterであり、期間位置から直接読み始められない

Codex rolloutは `token_count.total_token_usage` の累積値を持ち、直前値との差分で各ターンを計算する。

- 最近7日の位置へseekするだけでは、その位置のbaselineを復元できない。
- counter reset時は `last_token_usage` fallbackが必要である。
- `task_complete` がターン境界だが、進行中・中断されたopen segmentも存在する。
- 現在のparserは `turn_id` をstable identityとしてdraftへ残していない。

したがって、Codexの期間限定再走査は先頭または検証済みbaselineから逐次読みする必要がある。

### 2.5 Codexの親・子rolloutは現在分類されていない

`listCodexRollouts()` はsessions配下の全 `rollout-*.jsonl` を通常ファイルとして列挙し、親・子を区別せず処理する。現時点のコードだけでは次を確定できない。

- あるrolloutが親かサブエージェントか
- 親の累積counterに子の利用量が含まれるか
- 子rolloutを別レコード化した場合にAPI換算額が重なるか

本計画では分類不能なrolloutを推測で捨てたり親へ統合したりしない。正確な分類は実ログfixtureと公式仕様で根拠を得た範囲だけに限定する。

### 2.6 `history clear` / `redact` はカーソルを残す

現在の履歴操作はdata lock内で `history.jsonl` をatomic rewriteし、canonical dashboardを無効化するが、`cursors.json` は変更しない。

この挙動により、通常sweepは削除済みレコードやredact済みpromptを勝手に復元しない。これはprivacy上維持すべき契約であり、可逆sweepの実装で単純にカーソルを初期化してはならない。

### 2.7 現在のdata lockはクラッシュatomicityを保証しない

data lockはプロセス間の同時更新を直列化するが、現在の1対象のcommitは次の複数操作で構成される。

1. historyへ1件以上append
2. メインカーソルを保存
3. サブエージェントカーソルを保存

履歴append後・カーソル保存前にクラッシュすると、保存前のカーソルから再実行される。コメント上はseen keyで重複防止するとされているが、seen key自体が未保存なら保証にならない。複数レコードappendの途中失敗も同様である。

また、lock timeout以外の対象別例外がサマリーの失敗件数や終了コードへ反映されない経路があり、「一部失敗したがexit 0」を避ける必要がある。

## 3. 確定UXとCLI契約

### 3.1 通常取り込み

| コマンド | 意味 | 永続化 |
|---|---|---|
| `sweep --dry-run --days N` | 直近N日の未取り込み分と、期間外の保留件数を表示 | なし |
| `sweep --days N` | 直近N日の未取り込み分だけ追加。古い分はdeferredとして残す | history / cursor / ingest state |
| `sweep --dry-run` | 全期間でまだ取り込まれていない分を表示 | なし |
| `sweep` | deferredを含む全期間の未取り込み分を追加 | history / cursor / ingest state |

既存の `--include-active`、`--projects` は維持する。既存の不正引数fallbackをこの機能と無関係に変更しない。引数validationの厳格化は別変更とする。

### 3.2 `--rescan`

```bash
ccc-notifier sweep --rescan --dry-run
ccc-notifier sweep --rescan
```

意味:

- **初回releaseの `--rescan` は常にread-onlyの監査コマンド**とし、`--dry-run` の有無にかかわらずhistory / cursor / key / ingest state / journal / dashboardを変更しない。
- 既存cursorだけを信用せず、対象sourceを先頭から再走査する。
- stable keyとingest stateを照合し、未取り込み・payload訂正競合・state不整合・履歴欠損を検出する。
- 欠損を検出しても自動修復せず、修復が必要なら `--rebuild` のdry-runを案内する。
- `history clear` のtombstoneは復元しない。
- `history redact` のpromptは復元しない。
- 既存present/redactedレコードの保存額を現在の価格表・為替で再計算しない。未取り込み候補の参考額を表示する場合だけ「現在単価・現在為替によるpreview」と明記する。
- sourceが消失している既存レコードを削除しない。

`--rescan --days N` は許可し、その期間内だけ照合する。`--rescan --dry-run` も後方理解しやすいaliasとして許可するが、どちらもbyte-stableである。doctorと同様にread-onlyだが、doctorへrescanを暗黙実行させない。

### 3.3 `--rebuild`

```bash
ccc-notifier sweep --rebuild --dry-run
ccc-notifier sweep --rebuild
```

意味:

- ローカルに残っているsourceから、明示的に履歴を再構築する。
- `--dry-run` は復元対象、既存維持、source消失、legacy、prompt復元有無を件数で表示する。
- 本実行は対象件数・失われる可能性を表示して確認する。非対話用に `--yes` を追加する。
- `--rebuild` は `--days` と同時指定不可とする。期間限定の再構築は意味が曖昧なためである。
- `--rebuild` は `--include-active` と同時指定不可とする。進行中sourceの再構築は確定結果にならない。
- source-backedレコードだけを対象とし、sourceが既に消えた既存レコードを既定では削除しない。
- promptは既定でredact tombstoneを尊重する。削除済みレコードを復元する場合もpromptは既定で空にする。
- transcriptからpromptも明示的に戻す操作が必要なら `--restore-prompts` を追加し、`--rebuild` と確認付きの場合だけ許可する。
- **present / redactedの既存レコードは保存済みtoken・cost・fxRate・costByModelを維持し、通常rebuildで再価格しない。** sourceとのpayload fingerprint不一致は自動訂正せず競合として報告する。
- **clearedまたは一度も保存されなかったレコードをsourceから復元する場合は、rebuild実行時の価格表・為替で新規計算する。** dry-run・確認文・完了サマリーへ「当時額の復元ではない」ことと使用rate/sourceを明記する。
- 将来の一括 `--reprice` は別機能・別計画とする。

### 3.4 サマリー

通常・dry-runとも少なくとも次をsource別と合計で表示する。

- 新規取り込み件数
- 既に取り込み済み
- 期間外として保留
- clear tombstoneにより非表示を維持
- redact維持
- activeとしてスキップ
- stable identityを作れず保留
- 読取不能・整合性エラー・lock timeout
- Claude main / embedded sidechain / agent file / Codex の内訳

一部対象が失敗した場合は「新規なし」と表示せず、exit 1にする。active guardによる既定スキップは既存互換のためexit 0を維持するが、「未完了ではなく後回し」であることを明記する。

## 4. 非目標

この実装に次を含めない。

- Codexサブエージェントのtoken・料金推定
- 親・子rolloutの推測合算
- 単価表・為替・cost labelの変更
- 過去時点の為替復元
- sourceが削除済みの場合の外部API・クラウドからの復旧
- 通常sweepによるclear済み履歴やredact済みpromptの自動復活
- ダッシュボードのデザイン変更
- 通知金額・通知しきい値・Slack/OS通知形式の変更
- SQLiteなど新しい外部runtime依存の追加
- transcriptの全文やraw hook payloadを新しい台帳へ保存すること
- legacyレコードを曖昧な時刻・金額近接だけで新しいsource identityへ結び付けること
- 別runで検出したusage訂正を自動受諾すること。将来の `--accept-corrections` は別計画とする

## 5. 採用アーキテクチャ

### 5.1 cursorと正しさを分離する

今後の役割を次のように分ける。

- `cursors.json`: 通常hookと増分sweepを高速に再開するhigh-watermark。Codex baselineも保持する。
- stable unit key: source内の一意な課金単位を匿名で識別する。
- ingest state: どのunitがどの履歴レコードに入り、present / redacted / clearedのどの状態かを保持する。
- deferred coverage: `--days` で期間外になったsourceに、過去未走査範囲が残ることを保持する。
- WAL: history / cursor / ingest state / tombstoneの複数ファイルcommitを再実行可能にする。

`--days N` 実行後も通常hookの安全のためcursorはEOFへ進めてよい。ただし、期間外unitが存在したsourceをingest stateでdeferredとして残す。後の無制限sweepはそのsourceだけを先頭から再走査し、stable unit keyで最近分を除外して古い分だけ取り込む。

### 5.2 新しいローカルファイル

`~/.ccc-notifier` または `CCCN_HOME` 配下へ次を追加する。

```text
ingest-key                 # 32-byte secret, mode 0600
ingest-state/manifest.json # schema/keyCheck/sequence/shard generation
ingest-state/sources/      # source coverage shard/segment
ingest-state/turns/        # turn-level privacy shard/segment
ingest-state/records/      # record mapping shard/segment
ingest-state/units/        # unit mapping/payload fingerprint shard/segment
ingest-journal.json        # 未完transactionがある間だけ存在, mode 0600
```

既存Codex activity用 `codex-subagent-key` は再利用しない。用途・回復・ローテーションを分離し、Codex機能を使わないClaude専用ユーザーにも共通ingest identityを提供するためである。

`paths()` には上記pathを追加する。`uninstall --purge` は新ファイルとstagingを削除し、通常uninstallは維持する。doctorは存在・mode・keyCheck・pending journalだけを診断し、raw keyやidentityを表示しない。

### 5.3 ingest state概念schema

実装時に型名は調整してよいが、意味を次に固定する。

```text
manifest:
  schemaVersion: 1
  keyCheck: 64 hex
  sequence: safe integer
  activeSegments[kind][2-hex-prefix]: segment number

sources[sourceKey]:
  kind: claude-main | claude-agent | codex-rollout
  coverage: complete | deferred
  deferredBefore: ISO timestamp | null
  fixedPrefixSpanBytes: integer | null
  fixedPrefixFingerprint: HMAC | null
  legacyCoveredThrough: verified cursor snapshot | null
  anonymousThreadKey: 64 hex | null
  lastCompletedSequence: safe integer

turns[turnKey]:
  disposition: present | redacted | cleared
  promptPolicy: allow | suppress
  updatedSequence: safe integer

records[recordKey]:
  unitKeys: 64-hex[]
  turnKey: 64 hex
  chunkOrdinal: non-negative integer
  disposition: present | redacted | cleared
  source: claude | codex
  historyPresent: boolean
  updatedSequence: safe integer

units[unitKey]:
  recordKey: 64 hex
  turnKey: 64 hex
  disposition: present | redacted | cleared
  payloadFingerprint: 64 hex
```

制約:

- raw path、session ID、turn ID、message ID、request ID、agent ID、prompt、cwdを保存しない。
- object keyと配列長には上限を設ける。1つのshard/segmentが上限へ達したら、同じ2-hex prefixの次segmentを作り、manifestのactive segmentをWALで切り替える。上限超過を理由にsource全体を永久停止させない。
- 初回releaseからprefixごとの複数segment読取・書込を実装する。compactは非目標だが、新segment rolloverは必須とする。
- unknown key、型不一致、非有限数、重複unit、record/unit逆参照不一致をvalidatorで拒否する。
- keyCheck不一致、secret欠損・破損時は既存stateを変更せずfail closedとする。新しいsecretを自動生成して既存identityを無効化しない。
- stateが未作成の場合だけ、owned key lock内でsecretを生成する。

履歴側にはoptionalな匿名 `ingestRecordKey`、`ingestUnitCount`、`ingestTurnKey` だけを保存する。unit key配列はingest stateだけに置き、history/dashboardの肥大化を避ける。readerは未知optional fieldを無視できるためschemaVersion 1を維持する。

`turns` はunitより上位のprivacy stateである。redact/clear後に同じturnへlate sidechainまたはexact-parent agent unitが到着しても、unit初見だからという理由でpromptや履歴を復活させない。unit dispositionは必ずturn dispositionを継承する。

### 5.4 HMAC stable key schema

すべてSHA-256 HMAC、length-prefix付き入力、明示domain separationを使う。

```text
HMAC(secret, "ccc-notifier:<domain>\0", len:value ...)
```

#### source key

```text
Claude main:
  sourceKey = HMAC("source-claude-main-v1", sessionId, logicalTranscriptIdentity)

Claude agent file:
  sourceKey = HMAC("source-claude-agent-v1", parentSessionId, logicalAgentSourceIdentity)

Codex rollout:
  sourceKey = HMAC("source-codex-rollout-v1", threadId, logicalRolloutIdentity)
```

logical source identityはraw pathを永続化しない。session内で複数sourceを区別する必要がある場合だけ、正規化したpathまたはbasenameをHMAC入力としてメモリ上で使う。Windows/Unixで同じ実ファイルの区切り表現差がkeyを変えないよう、path identity helperを一元化する。可能ならpathではなくログ内IDを優先する。

fallback identityがoffsetへ依存するsourceでは、**初回観測時に一度だけ** `fixedPrefixSpanBytes` を決める。値は `min(fileSize, 64KiB)` 以内にある最後のnewline終端位置で、同じ固定spanのbytesと検証済みsession/thread metadataから `fixedPrefixFingerprint` を作る。小さいfileへ正常appendされてもspanを伸ばさず、以後は常に先頭から同じbytes数だけhashする。

- 初回にnewline終端済みspanが0ならfallback identityを確定せず、そのsourceを保留する。完成行を観測した後に一度だけ初期化する。
- appendでfileSizeがspan以上かつ固定span hash一致ならidentityを維持する。
- truncateでfileSizeがspan未満、または同じ固定spanのhash不一致なら `rewritten` conflictとして通常sweepを止め、cursor/stateを進めない。
- rescanは差分を報告するだけでstateを変更しない。rebuildだけが確認付きで新しいsource generationを開始できる。
- offset fallbackは同じfixed prefix・同じsource generation内でだけ有効とする。

#### Claude課金unit

優先順位:

1. `message.id + requestId + sidechain marker`
2. message IDが欠ける場合はassistant行の `uuid + sidechain marker`
3. それも欠ける場合は `sourceKey + newline終端行offset + raw line digest`

```text
unitKey = HMAC("claude-usage-unit-v1", sessionId, identityParts...)
```

prompt本文、tool input、assistant本文をHMAC入力に使わない。fallbackのraw line digestは内容自体を保存せず、append-only fileが書換えられた場合はsource fingerprint不一致として安全側に倒す。

同じ `message.id + requestId` の重複行は同じunit keyとなる。同じscan window内の訂正行は既存どおりlast-write-winsとする。別runで同じunit keyに異なるmodel / main-sidechain-agent marker / token bucketsを観測した場合は、保存済み `payloadFingerprint` と一致しないため**通常sweep・rescan・rebuildのすべてで自動上書きしない**。履歴金額を黙って変えずcorrection conflictとして報告し、その重複行を既存unitの訂正候補としてskipして後続appendのcursor進行は許す。

訂正を受け入れて既存額を置換する機能は初回releaseへ含めない。将来の `--accept-corrections` 等は、価格・為替・通知・record再計算を含む別計画とする。

```text
payloadFingerprint = HMAC(
  "usage-payload-v1",
  normalized model,
  source marker,
  input/output/cacheWrite5m/cacheWrite1h/cacheRead
)
```

timestamp、prompt、本文、pathはpayload fingerprintへ含めない。mainとembedded sidechainは同じturn draftに含められるが、markerで誤衝突を防ぐ。

#### Claude論理turn

turn grouping用の匿名keyを別domainで作る。

1. 実ユーザープロンプト行のUUID
2. UUID欠損時はそのturnの最初のunit key
3. usageのないpromptは履歴レコードを作らない既存規約を維持

turn keyはgroupingに使い、二重計上の正しさは個々のunit keyで保証する。hookが1回のwindowで複数論理turnを読み取る場合、通知用合計はまとめてもhistory recordはturn別に分け、対象unit keyをすべてingest stateへ登録する。

#### Codex課金unit

```text
threadId = validated session_meta.payload.id
        or validated UUID parsed from rollout filename
unitKey  = HMAC("codex-turn-unit-v1", threadId, turnId)
```

- 表示用 `TurnRecord.sessionId` とingest identity用 `threadId` を分離する。表示sessionIdは従来値を維持し、去重には使わない。
- `session_meta.payload.id` はUUID形式・長さを検証する。欠損時だけ検証済みrollout filename UUIDをfallbackに使う。両方あり不一致ならfail closedとする。
- 増分scanでもthread identityが必要である。cursor/stateに匿名thread keyがあれば検証して使い、無ければファイル先頭を最大64KiB・最大行数付きでbounded header readする。EOF cursorの位置からだけ読んでthread IDを失わない。
- parserは `turn_context.turn_id` と `task_complete.turn_id` を読み、同一segmentで一致を検証する。
- 不一致は推測せず、そのsegmentを未完了として残す。
- turn ID欠損時は `sourceKey + turn_context offset + task_complete offset + segment digest` fallbackを許可するが、source書換え検知時は再利用しない。
- Codex unitにもnormalized model / codex marker / token bucketsから非本文payload fingerprintを保存し、同じthread+turnで別runのbucketが変化した場合は通常sweep・rescan・rebuildすべてで自動訂正せず競合にする。
- open segmentはturn_contextのturn IDがあっても、既定sweepではactive guardに従う。完了境界なしで確定記録にするのは、mtime guard通過後の既存挙動を維持する場合に限り、`open`由来markerをstate内部へ持つ。後からtask_completeが追記された際は同じturn IDへ収束する。

### 5.5 history recordとunitの関係

1履歴レコードが複数unitを含むことを許可するが、単一recordと単一transactionを無制限に大きくしない。

- 通常hookがcursor以降の複数Claude API callを1レコードへ集約するため。
- hook欠落後のStopが複数論理turnを読む場合でも、history永続化はcanonical turnごとに分ける。通知用合計は従来どおり1 Stop単位で別途集約してよい。
- Codex Stopが複数task_complete segmentを読む場合も、historyはCodex turn unitごとに分ける。

初回releaseでは次を固定値として定義し、型・tests・contractsで共有する。

```text
MAX_UNITS_PER_RECORD = 256
MAX_RECORDS_PER_TRANSACTION = 64
```

canonical turn内のunitをscannerの確定source順に並べ、256件ずつ決定的にchunk化する。1つのrecordがturnを跨ぐことは禁止する。`recordKey` は次で作る。

```text
recordKey = HMAC(
  "history-record-v1",
  source,
  turnKey,
  chunkOrdinal,
  ordered unique unitKeys in the chunk
)
```

chunk 0だけがturn promptを持ち、chunk 1以降は同じturnKey/privacyを共有するprompt空のbounded補足recordとする。各recordのtokens / sidechainTokens / apiCalls / costはそのchunkのunitだけを合計するため、全chunk合計が元turnと一致する。

late unitは既存chunkを並べ替え・再分割せず、stateに保存済みの最大chunkOrdinalの次から新しい補足chunkを作る。同じretryではunit→record membershipにより同じchunkへ収束する。source rewrite後の新generationだけが先頭からchunkを再構築できる。

1turnが64recordを超える場合は64recordごとにWAL transactionを分割する。途中transaction成功後もsource cursorはturnの全chunkがcommitするまで進めない。再実行はcommit済みunitをskipして残りから継続する。すべてのchunkは同じturnKeyのclear/redact privacyを継承する。

ingest stateはunit→recordを保持する。sweep再走査時はdraft内の各unitを照合し、未取り込みunitだけでrecordを作る。Claudeではunitごとのbucketをparser結果に残し、turnの一部だけが未取り込みでもその部分だけを計算できるようにする。Codexは原則1turn=1unitのためturn全体をskipまたは追加する。

既存の `seenMessageKeys` と `codexTotals` は即時削除しない。high-watermarkの高速経路と旧version互換のため維持し、正しさの最終保証をstable unit keyへ移す。

### 5.6 初回dry-runのread-only identity

`--dry-run` と `--rescan` は、ingest keyがまだ無い初回実行でもkeyファイルを作ってはならない。

- key/stateが両方存在する場合はkeyCheckをread-only検証し、通常と同じHMAC keyで既存unitを照合する。
- key/stateが両方存在しない場合は、raw identity材料をプロセスメモリ内のSetで比較し、同一run内の重複を除いた候補件数・token・参考額だけを表示する。永続stable key値は表示しない。
- この初回previewは既存cursorが覆う範囲をlegacy coveredとして扱い、cursorより前を「新規候補」と誤表示しない。deferred候補を調べる明示rescanだけは先頭から監査し、「legacy範囲のため自動判定不能」と別件数にする。
- keyかstateの片方だけが存在する場合は整合性エラーとし、temporary keyや固定zero keyで近似しない。
- raw identity材料、prompt、本文をログへ出さず、process終了時に永続化しない。

## 6. source別実装契約

### 6.1 Claude main

`splitIntoTurnDrafts()` と `aggregateNewTurn()` の重複scannerを、共通のcanonical scan resultへ段階的に寄せる。

canonical resultは少なくとも次を返す。

- turn boundary UUID / fallback anchor
- prompt
- cwd / gitBranch / sessionId
- firstTs / lastTs
- 各assistant usage unitのstable identity材料
- unitごとのmodel / main-sidechain / token bucket
- window cursor
- source fingerprint
- 各unitの非本文payload fingerprint

hookは従来どおり通知用のレコード形を維持してよいが、記録した全unitをingest stateへcommitする。sweepは同じcanonical unitをturn単位にgroupingする。hookとsweepが別のgroupingになってもunit coverageが同じなら二重計上しない。

期間判定はturnの `lastTs` を既存どおり使う。timestamp不正・欠損は現在時刻で最近扱いにせず、「期間を判定不能」としてdeferredに残し、無制限sweepまたはrescanでのみ対象にする。

### 6.2 Claude embedded sidechain

メインtranscript内の `isSidechain:true` assistant usageは現在どおり親turnのsidechainとして扱う。

- unit keyにはsidechain markerを含める。
- `--days` は所属する親turnの終了時刻で判断する。
- parent main usageが既に取り込み済みでsidechain unitだけ未取り込みなら、既存親recordを通常sweepで書き換えず、promptなしの補足レコードを作る。
- 補足レコードは `tokens=zeroBuckets`、`sidechainTokens=late sidechain合計`、`apiCalls=late sidechain unit数`、`costUSD=late sidechain cost`、`costByModel=late sidechain内訳`、`costJPY=costUSD*今回fxRate`、`models=sidechain model一覧`、`subagents=undefined`、`prompt=""`、`ingest="sweep"` とする。main cost 0ではなく、sidechain料金を通常合計へ一度だけ含める。
- optionalな内部 `supplementKind: "late-sidechain"` を保存してよいが、dashboardへstable keyを出さない。

turn-level privacyを先に参照する。親turnがredactedならlate sidechain補足は必ずprompt空、親turnがclearedならlate sidechain unitもclearedを継承して履歴・料金へ再出現させない。明示rebuild時だけ復元候補にする。

### 6.3 Claude agent file

`collectSubagentUsage()` を「全file合算」から、canonical agent drafts列挙へ分離する。

- 各 `agent-*.jsonl` に個別active guardを適用する。
- 各agent turnの `lastTs` へ `--days` cutoffを適用する。
- main transcriptが静止していてもagent fileが直近5分以内なら、そのagentだけ後回しにする。
- 1runの処理上限 `MAX_AGENT_FILES=200` は維持してよいが、列挙全体を「新しい200件」で毎回切り捨てない。directory iteratorでbounded pageを作り、ingest state上の未処理・deferred sourceを最優先、次にlast scanned sequenceの古い順で最大200件を処理する。201件以上でも複数runで必ず全件へ到達する。
- page cursor/segmentをstateへ保存し、新規agent fileが追加されても毎run再列挙して発見する。main cursorがEOF・main draft 0件でもagent directoryの再列挙を省略しない。
- 上限超過時は残件数または「200件超・次回継続」をサマリーへ出し、exit 0のままでも新規なしとは表示しない。
- agent sourceごとにstable unit keyとcursorを持つ。
- mainとagent cursorのcommitを同一WAL transactionへ含める必要がある場合は、対象session単位でcommitする。

親turnへの関連がログ内の明示IDで証明できる場合だけ、その親turnのprivacy stateを継承する。明示的な親identityが無い場合、今回の最後の親turnへ推測で付けない。独立したSA-only補足レコードとして記録し、後から同じunitを重複させない。agent補足レコードは常にprompt空とし、親promptをコピーしない。

exact parent turnがredactedならagent補足はprompt空、clearedならlate agent unitもclearedとして履歴・料金へ再出現させない。親不明agentは独立turnとしてcostを記録できるが、promptは常に空なのでclear/redact済み親promptを復活させない。

この変更で履歴上の配置が変わりうるため、fixtureで次を固定する。

- 親に明示関連できるSA
- 親不明のSA-only
- 親期間外・SA期間内
- 親期間内・SA期間外
- agentだけactive
- late agent completion

### 6.4 Codex rollout

`scanWindow()` / `splitIntoCodexTurnDrafts()` を拡張し、segmentごとに次を保持する。

- ingest用thread ID / anonymous thread key
- turn_context turn ID
- task_complete turn ID
- segment開始・終了offset
- segment前後の累積counter baseline
- counter reset有無
- model / prompt / cwd / timestamps
- open / completed状態
- stable unit key材料

通常のEOF増分scanは、検証済みcursorの `codexTotals` を直前baselineとして使う。一方、**deferred回収・rescan・rebuildのfull scanは必ず `cursor=null / prev={0,0,0}` から先頭を逐次再構築する。EOF cursorの `codexTotals` を先頭scanのbaselineへ絶対に流用しない。** 期間外segmentもcounter baseline計算には使うが、unit dispositionを `present` にせずdeferred coverageとして残す。

upgrade時に既存Codex cursorがあるsourceは、そのsnapshotを `legacyCoveredThrough` としてingest stateへ記録する。full rescanは先頭からcounterを再構築するが、legacyCoveredThroughの検証済みoffset以前で完結したsegmentを新規unitとしてemitしない。境界を跨ぐsegment、cursorのlastTs/codexTotalsと先頭再計算が一致しない場合はlegacy conflictとして自動取り込みを止める。履歴を空にした明示rebuildだけがlegacy coverageを無視できる。

completed segment Aの後にopen segment Bがある場合、AとBを別segment・別turn unitとして返す。現在の「open usageを最後のcompleted draftへ加算する」挙動は廃止し、Bのtoken・prompt・endTsをAへ合算しない。Bに検証済みturn IDがなければBだけをdeferred/conflictにし、Aの確定取り込みを妨げない。

同じturn IDを複数rolloutで観測した場合:

- token bucketとthread identityが同一なら同一unitとしてskipする。
- 同じunit keyでtoken bucketが異なる場合は競合としてfail closedし、どちらかをlast-write-winsにしない。
- raw turn IDやpathをerror.logへ出さず、HMAC key prefixと固定contextだけを記録する。

history recordをatomic upsert・rebuildで置換する場合、既存Codex recordの `activityProjectionKey` を保持する。exact same persisted record/turnとの対応が証明できる場合だけコピーし、別turnから推測しない。activityは引き続き「利用あり・料金未集計」であり、token/costへ合算しない。

### 6.5 Codex親・子rollout

最初の実装waveでは全rolloutを独立sourceとして走査する既存挙動を維持する。その上で、session_metaなど実ログに存在する分類材料をread-only metadataとして収集する。fixtureは単純な手書き例だけでなく、秘密情報を除去した実親rollout・実子rollout・親子同時実行の構造を最低1組ずつ用意し、thread ID、turn ID、originator/source、累積counter包含関係を明記する。

分類enum:

```text
root | subagent | unknown
```

規則:

- 公式仕様または実fixtureで明示されたfieldだけで分類する。
- unknownをroot扱い・subagent扱いに推測変換しない。
- rootとsubagentのunitを同じrecordへ合算しない。
- 同一stable unit keyだけはsourceを跨いで去重する。
- 親counterに子利用量が含まれるか判別不能な場合は、現行と同様に各rolloutのAPI換算額として扱うが、docsに制約を明記する。
- Codex hook activity ledgerの「利用あり・料金未集計」をsweepの料金へ変換しない。

親子の二重料金を実証できるfixtureが得られた場合は、本計画の実装PRへ混ぜず、別設計レビューで集計契約を決める。

## 7. clear / redact tombstone契約

### 7.1 `history clear`

- source-backed history行を削除し、その `recordKey` に属する全unitを `cleared` にする。
- ingest stateのunitは残す。
- recordが属する全turnをturn-level `cleared / promptPolicy:suppress` にする。
- 通常sweepと `--rescan` はcleared unitを再追加しない。
- clear後に同じturnへlate sidechainまたはexact-parent agent unitが到着した場合、そのunitも即座にclearedを継承し、history・月予算・料金合計へ再出現させない。これは利用者がturn全体を削除した意図を優先する。親不明agentは独立turnとしてpromptなしで扱う。
- cleared turnのlate costを再び見たい場合は明示 `--rebuild` の対象とし、現在価格・現在為替で計算されることを確認文へ出す。
- canonical dashboard無効化の既存順序を厳密に維持する。
- legacyでrecordKeyがない行は従来どおり削除し、cursorは残す。

### 7.2 `history redact`

source-backedレコードのpromptを空にし、unit dispositionを `redacted` にする。

- cost/token/modelは保持する。
- recordが属する全turnをturn-level `redacted / promptPolicy:suppress` にする。
- 通常sweep、rescan、rebuildの既定動作はpromptを空のまま維持する。
- `--rebuild --restore-prompts` だけがprompt復元を許す。
- sourceが消失していてもredacted historyはそのまま保持する。
- 同じturnのlate sidechain・exact-parent agent補足はprompt空を継承する。late unitを追加してもturn-level promptPolicyを `allow` へ戻さない。

### 7.3 crash consistency

history rewriteとtombstone更新を同一WAL transactionにする。履歴だけ消えてstateがpresentのまま、またはstateだけclearedで履歴が残る中間状態は、次回の**mutating command**（history / sweep本実行 / track）開始時にjournal recoveryでroll-forwardする。

clear/redact WALは通常ingest WALと適用順を分ける。

1. 確認完了後、journalをfsync + canonical renameしてcommit intentを確定する。
2. **history mutationより前に** `report.html` / `report-all.html` / 日次stateをinvalidateする。
3. invalidate失敗時はhistoryへ触れずjournalを残しexit 1にする。
4. history rewriteとturn/record/unit tombstoneを適用する。
5. cursorは変更しない。
6. **完了後にも再度canonical dashboardをinvalidate**し、hash/stateを検証する。
7. journalを削除する。

通常ingestはhistory/state/cursorをWALで適用した後にdashboard再生成またはinvalidateを行う。clear/redactのprivacy先行invalidate順を通常ingestへ一般化しない。確認待ち中に履歴が変わった場合のfingerprint再確認、cancel時無変更の既存契約も維持する。

## 8. legacy移行

### 8.1 自動移行で行うこと

- 新しいoptional fieldがない既存TurnRecordはそのまま読める。
- 既存 `cursors.json` は変更せず読み込む。
- 初回の新規hook/sweep transactionからingest key/stateを作る。
- 既存cursorより後の新規unitだけをstable stateへ登録する。
- 既存履歴へ時刻・金額・prompt近接による推測key付与をしない。
- ingest state未作成時だけsecretを生成する。

### 8.2 legacy履歴と通常sweep

legacy履歴は既存cursorが覆う範囲について処理済みとみなす。通常sweepは過去をフルscanしてlegacy行と推測照合しないため、アップグレードだけで二重計上しない。

新機能導入後に初めて `--days N` を使ったsourceは、stable stateでdeferred範囲を管理する。導入前に旧versionの `--days` で既に捨てた履歴は、通常sweepでは自動復元しない。これは明示的なrebuild対象である。

### 8.3 legacyがある状態のrebuild

stable keyのないlegacy行がある場合、`--rebuild` は既定で本実行を拒否し、dry-runで件数と理由を表示する。曖昧な重複を作らないためである。

初回releaseでは `--replace-legacy` を実装しない。時刻・金額・prompt・session近接による自動matchingもしない。

全legacyをsourceから作り直す明示手順は次に統一する。

```bash
# 1. 自動表示されたbackup先を確認して全履歴を削除
ccc-notifier history clear

# 2. 履歴が空であることを確認して再構築候補を確認
ccc-notifier sweep --rebuild --dry-run

# 3. ローカルsourceに残る範囲を再構築
ccc-notifier sweep --rebuild
```

この手順を成立させる契約:

- `history clear` は実行前に `history.jsonl` のtimestamp付きmode 0600 backupを作り、そのpathを表示する。既存の「元に戻せない」文言は「通常操作では戻せない。backupとsourceの保存状況を確認」に更新する。
- legacy行にはstable turn/unit keyがないため個別tombstoneを作れない。履歴が全件空になった状態だけ、`--rebuild` はlegacyCoveredThroughを無視して `cursor=null` から再構築できる。
- 一部legacy行が残る `history clear --days N` 後はrebuildを拒否する。全削除か、将来の明示migrationが必要である。
- source消失分は再構築できない。dry-runと確認文に、backupにしか残らない件数は正確に算出不能であることを明記する。
- clear前のstable-keyed turn tombstoneは維持する。全履歴clear後のrebuildはcleared turnの復元を明示した操作なので対象にできるが、promptは `--restore-prompts` なしでは空にする。
- cursorファイルを手動削除・復元させない。rebuildがcursorを無視して先頭scanし、成功transactionで新cursorへ置換する。

## 9. WALとatomicity

### 9.1 transaction単位

通常sweepは現在と同様、対象sourceまたは関連するClaude session単位で部分commitを許す。全sourceを1巨大transactionにしない。

1 transactionは少なくとも次を含む。

- transaction ID / schemaVersion / keyCheck
- 追加または置換するhistory record
- history record keyとunit disposition変更
- source coverage変更
- 保存するmain / agent / Codex cursor snapshot
- canonical dashboard無効化要否
- operation kind: ingest / clear / redact / rebuild（read-onlyのrescanはjournalを作らない）

### 9.2 roll-forward WAL

data lock内で次の順に行う。

1. 最新history / cursor / ingest stateを再読込・validate
2. transactionをメモリ上で構築
3. `ingest-journal.json.tmp` をmode 0600でwriteしfsync
4. journalをcanonical名へatomic renameし、可能なOSではdirectory fsync
5. operation kindがclear/redactなら、history mutation前にcanonical dashboardを先行invalidateする。通常ingest/rebuildではこの先行手順を使わない
6. history変更をstable record keyでidempotentに適用
7. ingest state shard変更をatomic write
8. cursor変更をatomic write
9. clear/redactならcanonical dashboardを再invalidateする。通常ingest/rebuildならcommit後のdashboard再生成またはinvalidateを行う
10. 全出力hash・stateを再検証
11. journalを削除

次回のtrack / sweep本実行 / historyの永続化操作前にpending journalを検出し、同じdata lock内で5以降を再実行する。historyへ一部append済みでもrecord keyで二重追加しない。journal破損・keyCheck不一致時は自動削除せず、mutating commandをfail closedにする。

doctorはpending/破損状態と復旧案内をread-only表示するだけで、journal適用・lock reclaim・staging削除を行わない。

canonical journalへrenameする前の `.tmp` はcommit intentではない。staging名を `ingest-journal.<hostTag>.<pid>.<random>.tmp` にし、mutating commandがdata lockを取得した後だけ次を行う。

- canonical journalが無く、strict命名・same-host dead PID・十分な経過時間・regular fileをすべて満たすtmpはorphanとして削除する。history/state mutationはまだ始まっていないためroll-forwardしない。
- canonical journalがある場合はcanonical recoveryを先に完了し、そのtransactionに属さない検証済みstale tmpだけを削除する。
- 生存PID、別host、symlink、命名不一致、年齢不足、検証不能tmpは触らず、doctorへ件数だけ表示する。
- doctorとdry-run/rescanはtmpを削除しない。

journalには新規TurnRecordが含まれるため、一時的にpromptを含みうる。次を必須とする。

- mode 0600
- stdout / error.logへ内容を出さない
- crash recovery以外で読まない
- 正常commit後に削除
- `uninstall --purge` 対象
- redact/clear transactionはraw promptをjournalへ複製せずrecord keyとactionだけを持つ

### 9.3 書込失敗

- journal永続化前の失敗: 何もcommitしない。
- journal永続化後の失敗: journalを残しexit 1。次回roll-forwardする。
- clear/redactの先行dashboard invalidate後・history mutation前の失敗: 古いcanonicalは消え、historyは旧状態、journal recoveryがmutationを続行する。
- history適用後の失敗: cursorを進めずに単に戻らず、journal recovery必須状態としてexit 1。
- cursor適用後・journal削除前の失敗: recoveryが全hash一致を確認してjournalだけ削除する。
- 1source失敗でも他sourceの正常commitは保持する。summaryへfailed targetを出しrun全体はexit 1。

### 9.4 Windows互換

atomic replace helperはWindowsで既存destinationへのrename挙動が異なることを前提にする。製品コードでpath区切り文字列を直接比較せず、同一helperをUnix/Windowsテストで使う。staging名は同一directory内、固定prefix + PID + random suffix、長さ上限付きとする。

## 10. active-session guard

### 10.1 共通規則

- 既定5分mtime guardを維持する。
- mainだけでなく実際に読む各source fileへ適用する。
- stat失敗を従来どおり処理継続へ倒すか、未完了へ倒すかをsource別に統一する。
- 可逆再走査では誤消費より後回しを優先するため、推奨はstat失敗を未完了扱いに変更する。ただし互換変更として独立commit・docs記載を必須とする。
- active skipしたsourceのcursor・coverage・unit dispositionを変えない。
- `--include-active` は通常sweep / rescanだけで許可し、警告を表示する。
- rebuildではactiveを常に拒否する。

### 10.2 Claude session

- main activeならmainを後回しにする。
- agentだけactiveならそのagentだけ後回しにし、mainの確定turnは取り込んでよい。
- main transactionへactive agentを推測添付しない。
- exact parent relationが必要な場合は関連対象をまとめて後回しにする。

### 10.3 Codex

- rollout fileごとに判定する。
- task_complete未到着のopen segmentはactiveでなくても「中断済み候補」と表示する。
- `--include-active` でopen segmentを取り込んだ場合もturn ID stable keyへ紐付け、後のtask_complete再走査で二重化しない。

## 11. privacy・security不変条件

- ingest key/stateへraw session / turn / message / request / agent ID、path、cwd、prompt、本文を保存しない。
- HMAC入力はメモリ内だけで扱う。
- key、state、journal、stagingはmode 0600。directoryは既存home権限方針に従う。
- keyCheckをconstant-time比較する。
- key欠損・同長置換・1bit破損・state keyCheck破損は自動ローテーションせずfail closed。
- stable key、source key、record keyをdashboard embed、Slack、OS通知へ出さない。
- diagnosticは固定context、件数、source kindだけを出す。raw identityとpromptをerror.logへ出さない。
- `history redact` 後のrescan/rebuildでpromptを無断復元しない。
- `--restore-prompts` は確認文で「ローカルtranscriptからpromptを再保存する」と明示する。
- source fingerprintはHMACであり、生file digestを公開しない。
- 現在historyが保存しているsessionId/project/promptの既存契約はこのPRで拡張しない。

## 12. 実装の依存順と段階的コミット

オーケストレーターは実装せず、各waveを別担当へ委譲し、実装者とは別の高推論レビュー担当が確認する。永続化・Codex・privacyは最上位能力のモデル、局所的CLI/docsは実装能力の高い標準モデルを使う。

### Wave 0: 契約とRED fixture

コミット例: `test(sweep): reversible backfill contractsを追加`

- `src/contracts.md` に本計画の確定契約を要約する。
- Claude main/sidechain/agent、Codex累積/reset/open/親子候補fixtureを追加する。
- `7日実取込 → 無制限で残り → 再実行0件` をClaude/Codex双方でREDにする。
- clear/redact、legacy、crash pointのRED test skeletonを追加する。
- 製品挙動をこのcommitでは変えない。

レビューゲート: fixtureが実フォーマットを表し、旧挙動に対して意図した理由でREDになること。

### Wave 1: 匿名identityとcanonical scanner

コミット例: `refactor(ingest): source unit identityを導入`

- dedicated secret / HMAC helper / strict validatorを追加する。
- Claude scannerがunit材料、unitごとのbucket、payload fingerprint、prefix fingerprintを返す。
- Codex scannerがthread ID、turn ID、segment baseline、完成状態を返す。completed Aとopen Bを別segmentにする。
- 既存aggregate/splitのGOLDEN値を変えないadapterを維持する。
- まだhistory/stateへ書かない。

レビューゲート: promptやraw identityがkey/state候補へ混ざらず、hook/sweepが同じ入力から同じunit keyを作ること。

### Wave 2: ingest stateとWAL基盤

コミット例: `feat(store): ingest stateと回復可能transactionを追加`

- path / sharded schema / segment rollover / validator / keyCheck / atomic helper / journal recovery / orphan tmp回収を実装する。
- history record optional fieldを追加する。
- fault injection APIはテスト限定dependency injectionで用意する。
- この段階では既存sweepを切り替えない。

レビューゲート: 各crash pointでroll-forwardし、重複・消失・prompt漏えいがないこと。Windows replace testがGREENであること。

### Wave 3: Claude main / sidechain移行

コミット例: `feat(sweep): Claude限定取り込みを可逆化`

- mainとembedded sidechainをstable unit + deferred coverageへ移行する。
- hook writerも同じunitをstateへcommitする。
- 7日→全件のClaude REDをGREENにする。
- 通知・金額・通常hookの1ターン挙動を維持する。

レビューゲート: hook→sweep、sweep→hook、同時実行、cursor破損で二重計上しないこと。

### Wave 4: Claude agent file移行

コミット例: `feat(sweep): Claude agent履歴を個別に保護する`

- agentごとの期間filter / active guard / stable unit / SA-only fallbackを実装する。
- 推測による最後の親turn付与を廃止またはexact relation時だけに限定する。
- MAX_AGENT_FILESの未処理優先pagination、複数run回収、新規file再発見、main EOF後の再列挙を追加する。

レビューゲート: agent active/late/親期間差のmatrixがGREENで、既存SA cost合計GOLDENが維持されること。

### Wave 5: Codex移行

コミット例: `feat(sweep): Codex限定取り込みを可逆化`

- thread identityと表示session IDを分離し、bounded header read / anonymous state lookupを実装する。
- full/deferred scanを `cursor=null / prev=0` から再構築し、legacyCoveredThroughを適用する。
- turn ID stable unit、reset、completed/open分離、rollout重複競合を実装する。
- record置換時にactivityProjectionKeyを保持し、activity料金非合算を確認する。
- 親子classificationはread-only metadataまでに限定する。
- Codex activity「利用あり・料金未集計」と混ぜない。

レビューゲート: 7日→全件、counter reset、hook相互運用、open完了追記、同一turn競合がGREENであること。

### Wave 6: history tombstone / rescan

コミット例: `feat(history): sweep tombstoneとrescanを追加`

- clear/redactをWAL + dispositionへ移行する。
- 常にread-onlyの `--rescan` とsummaryを追加する。
- canonical dashboard invalidation契約を維持する。
- legacy recordの挙動を固定する。

レビューゲート: clear/redact後に通常sweep/rescanしても削除・秘匿が復活しないこと。

### Wave 7: rebuild

コミット例: `feat(sweep): 明示的な履歴rebuildを追加`

- dry-run / confirmation / `--yes` / `--restore-prompts` を追加する。
- active拒否、source消失維持、backupを実装する。
- 初回releaseではlegacy自動置換flagを追加しない。全履歴backup + clear後の明示rebuild手順だけを実装・文書化する。

レビューゲート: rebuild対象外レコードを消さず、redact promptを既定で復元せず、途中クラッシュから回復すること。

### Wave 8: CLI・doctor・docs

コミット例: `docs(sweep): 可逆backfillの運用手順を追加`

- README、`docs/sweep.md`、`docs/dashboard.md`、`docs/codex.md`、CLI help、contractsを同期する。
- doctorへkey/state/journal/orphan tmp/deferred件数の安全なread-only診断を追加する。doctorからrecovery・cleanupを呼ばない。
- 旧説明「`--days` で捨てたターンは復活しない」を削除する。
- Slack案内に使える「まず7日→問題なければ全件」の例を載せる。
- migration / rollback / privacy / prompt復元警告を載せる。

レビューゲート: docsのコマンドをpack済みCLIでsmokeし、実装と文言が一致すること。

## 13. RED / GREENテストmatrix

### 13.1 共通機能

| ケース | RED期待 | GREEN期待 |
|---|---|---|
| 3ターン: 30日前/10日前/1日前、`--days 7` | 1日前だけ入りcursorで古い2件が永久消費 | 1日前だけpresent、古い2件deferred |
| 続けて無制限sweep | 新規0件 | 古い2件だけ追加 |
| 3回目無制限sweep | 新規0件 | 同じく0件、history byte-stable |
| `--dry-run --days 7` | 書込なし | history/cursor/state/key/journalすべてbyte-stable。初回keyも作らない |
| 初回key/state無しdry-run | identityを永続化しない | memory内去重だけで正確な候補件数、終了後もhome byte-stable |
| rescan欠損検出 | 修復と価格契約が曖昧 | read-onlyで欠損/競合を報告し、全ファイルbyte-stable |
| partial failure | exit 0になり得る | 正常source保持、failed件数、exit 1 |
| cursor破損 | full再計上リスク | state/keyで既存unit skip、破損は診断 |
| state破損/keyCheck不一致 | 未定義 | history/cursor/state無変更、exit 1 |
| state shard上限 | 永久停止の恐れ | 次segmentへrolloverし継続、全unit lookup可能 |

### 13.2 Claude main / sidechain

- mainのみ、sidechainのみ、main+sidechain混在。
- 同一 `message.id + requestId` 重複行。
- 同一runのsame ID usage correctionはlast-write-wins。別run訂正は通常sweep/rescan/rebuildすべてでpayload fingerprint conflict・既存額維持。
- message ID欠損、uuid fallback、offset+digest fallback。
- 改行未終端tail。
- 初回small fileのfixedPrefixSpanを保存し、正常append後もspan不変。span未満truncate / fixed span rewrite / 同offset別内容でconflict、rebuildだけnew generation。
- hook→partial sweep→full sweep。
- partial sweep→hook→full sweep。
- hookが複数論理turnを1recordへ集約するケース。
- 1turn 256unitは1record、257unitは2record。chunk 0だけprompt有りで全chunk合計が元turnと一致。
- 1turnが64recordを超えてtransaction分割し、途中crash後も残りだけ再開。late unitは既存chunkを再分割しない。
- 期間境界ちょうど、invalid timestamp、timestamp逆順。
- unknown model / zero costでもunitを二重化しない。
- late sidechain補足の `tokens=0 / sidechainTokens / apiCalls / costUSD / prompt=""` exact shape。
- redacted/cleared turnへlate sidechainが到着してもprompt・cleared costを復活させない。

### 13.3 Claude agent

- 親と同期間のagent。
- 親が期間内、agentが期間外。
- 親が期間外、agentが期間内。
- main mtime古い、agent mtime新しい。
- agentだけ後から完了。
- exact parent relation有り/無し。
- agent fileちょうど200件、201件、複数page。未処理優先で複数run後に全件回収。
- main完了・main cursor EOF後に新規agent fileを追加し、次runで発見。
- same ID usage correctionの同一runlast-write-winsと、別runで通常/rescan/rebuildすべて既存額維持。
- agent fallback identityのappend / truncate / prefix rewrite。
- redacted/cleared exact parentへのlate agentと、親不明agentのpromptなし独立記録。
- 1 agent読取失敗時に他agentはcommit、runはexit 1。
- SA-only補足レコードの再実行去重。

### 13.4 Codex

- 3turn rolloutの1件だけ期間内→後から残り2件。
- 累積counterの通常差分。
- deferred/full scanが `cursor=null / prev=0` であり、EOF `codexTotals` をbaselineへ使わない。
- counter reset + `last_token_usage` fallback。
- info null / duplicate step=0。
- task_complete turn ID一致/不一致/欠損。
- completed A + open Bが別record/unitで、BをAへ合算しない。
- open segmentを既定skip、mtime経過後、`--include-active`、後からtask_complete追記。
- hook cursorが先に全消費、sweepが先、同時実行。
- upgrade時のlegacyCoveredThrough以前をrescanで新規化しない。境界不一致はconflict。
- session_meta thread IDと表示session IDが異なるfixture、filename UUID fallback、両者不一致。
- 同一turn IDのrolloutコピー。
- 同一turn IDでtoken bucket競合。
- 同一thread+turnの別runpayload訂正は通常/rescan/rebuildすべて既存額維持し、将来flagなしでは解消しない。
- 匿名化した実親/実子/親子同時rolloutによるroot/subagent/unknown metadata fixture。
- rebuild/upsert後もactivityProjectionKey保持、activity cost非合算。
- Claude root不在のCodex-only環境。

### 13.5 clear / redact / rebuild

- clear→通常sweepで復活しない。
- clear→rescanで復活しない。
- clear済みturnへのlate sidechain/exact-parent agentはcostも再出現せず、redacted turnへのlate unitはprompt空を維持。
- clear→rebuild dry-runで復元候補表示。
- clear→rebuildで現在価格・現在為替のcost record復元、promptは既定空。
- present/redacted既存recordはrebuildでも保存済みcost/fxRateを維持。
- redact→通常/rescan/rebuildでprompt空。
- redact→`--rebuild --restore-prompts` だけprompt復元。
- source消失後rebuildで既存history維持。
- legacy混在時rebuild拒否。
- 全legacy履歴backup + clear後はcursorを手動変更せずrebuild可能。一部legacy残存なら拒否。
- confirm待ち中にtrack追記した場合はfingerprint不一致で中止。
- cancelは全ファイルbyte-stable。

### 13.6 WAL crash injection

各点で子プロセスを強制終了し、次回コマンドでroll-forwardする。

1. journal tmp write前
2. journal fsync後・rename前、およびstale orphan tmp回収
3. journal canonical rename後
4. clear/redactの先行dashboard invalidate前後（history mutationはまだ前）
5. history 1件適用後 / 全件適用後
6. ingest state shard置換後
7. main cursor置換後
8. agent cursorの一部置換後
9. clear/redactの完了後dashboard再invalidate前後
10. 通常ingestのcommit後dashboard処理前後
11. journal削除直前

全点で最終状態が「全commit」または「commit前」のどちらかへ収束し、history重複、unit orphan、cursorだけ先行、promptの古いcanonical残存がないこと。

### 13.7 OS・timezone・E2E

必須matrix:

- Ubuntu / macOS / Windows、Node 20。
- 通常timezoneと `TZ=UTC`。
- Windows path separator、drive letter、rename-over-existing、長いstaging名。
- CLI child-process E2Eでdry-run byte stability、exit code、confirmation、stdout summary。
- pending journal/orphan tmpがあるdoctorは全ファイルbyte-stableで、回復・削除しない。
- packed tarballから `npx` 相当のclean install smoke。
- 実homeを読まないよう `CCCN_HOME` / `CCCN_CLAUDE_PROJECTS` / `CCCN_CODEX_HOME` を全テストで隔離。
- 並行 `track + sweep`、`history clear + sweep`、`rescan + hook`。

## 14. docs・CLI互換

維持するもの:

- `sweep`, `--dry-run`, `--days`, `--include-active`, `--projects` の既存表記。
- Claude root不在でもCodexだけ走査できる挙動。
- active skip時の再実行案内。
- sweep時点の価格表・為替を新規取り込みへ使う挙動。
- `ingest: "sweep"`、`source: "codex"` の既存reader互換。
- history schemaVersion 1と未知optional field許容。
- 通常hookの通知・dashboard自動生成。

変更する説明:

- `--days` は「古い履歴を捨てる」ではなく「今回は直近N日だけ取り込み、古い分を保留」に変わる。
- 「カーソルだけで二重計上なし」という説明を、stable unit identity + state + cursorへ更新する。
- clear/redact、rescan、rebuildの違いを例付きで説明する。
- rebuildのprompt privacy、source消失、legacy制限を明示する。
- Codex親子rolloutとCodexサブエージェント料金未集計の制約を明示する。

CLI helpは1行を長くしすぎず、詳細を `docs/sweep.md` へ誘導する。新flagを未知flagとして旧versionへ渡した場合は旧versionが黙って無視しうるため、version確認例もmigration docsに載せる。

## 15. ロールバック

### 15.1 release前

- 各waveを独立commitにする。
- behavior切替前のWave 1/2はadapterで既存挙動を維持する。
- Claude / agent / Codex切替を別commitにし、問題sourceだけrevertできるようにする。
- state schema migrationは一方向に破壊変換せず、旧cursor/historyを保持する。

### 15.2 release後

旧versionは新しいhistory optional fieldを無視できるが、ingest stateとdeferred coverageを理解しない。ロールバック時の注意:

- pending journalがないことを新versionのdoctorで確認してからdowngradeする。
- `ingest-key` / `ingest-state/` は削除しない。再upgrade時に必要である。
- 旧versionでは新機能でdeferredになった古い分を取り込めない。source自体は失われないため、再upgrade後にsweepする。
- cursor backupを単独で戻すと既に取り込んだ最近分を重複させるため、手動復元しない。
- history/state/cursorを戻す必要がある場合は、同一timestampのtransaction backup一式をdata lock外で一緒に戻す手順だけをdocsに載せる。

初回安定releaseではstate schemaVersionを1に固定し、自動schema upgradeを追加しない。

## 16. 完了条件

次をすべて満たしたときだけ実装完了とする。

1. Claude mainで `--days 7` 実取り込み後、無制限sweepが残りだけを取り込む。
2. Claude embedded sidechainとagent fileでも同じ期間・去重契約が成立する。
3. Codex累積counter/reset/open segmentで同じUXが成立する。
4. hook→sweep、sweep→hook、並行実行で二重計上しない。
5. clear/redact後の通常sweep/rescanで削除・promptが復活しない。
6. rebuildが確認付きでのみ明示復元し、redact promptを既定で復元しない。
7. pending WALが全fault pointからroll-forwardする。
8. key/state破損時に自動key再生成・無検証再計上をしない。
9. state/journal/dashboard/通知にraw identityや新しい秘密情報を漏らさない。
10. legacyユーザーがアップグレードだけで履歴重複しない。
11. source別失敗がサマリーとexit codeへ正しく反映される。
12. 巨大turnがbounded deterministic record/transactionへ分割され、late unitで既存chunkが変わらない。
13. Unix / Windows / UTC / E2E / crash matrixがすべてGREEN。
14. typecheck、build、全test、`git diff --check`、pack smokeがGREEN。
15. docs、CLI help、contracts、実装が一致する。
16. 実装者と別コンテキストの独立レビューが未解決P0/P1なしと判定する。
17. 計画ファイルはコミットされていない。

## 17. 未決事項と推奨判断

### 17.1 legacy full rebuildを初回releaseへ含めるか

未決: stable keyのない既存履歴をsourceへ安全に対応付けられない。

推奨: 初回releaseでは自動legacy置換を実装しない。通常アップグレードと新規deferredだけを安全にし、legacy rebuildはbackup + 全履歴clear後の明示手順に限定する。時刻・金額近接による自動matchingは禁止する。

### 17.2 Claude agentを親recordへupsertするか

未決: exact parent relationがある場合、既存親recordを書き換えるかSA-only補足recordにするか。

推奨: 初回は常にSA-only補足recordとし、unit keyで正しさを優先する。親への見た目上の統合は別UI改善にする。現在の「最後の新規親へ推測付与」は廃止する。

### 17.3 Codex open segmentを確定扱いするか

未決: mtimeが古いがtask_completeのない中断turn。

推奨: 無制限通常sweepでは「中断済み候補」として取り込み可能にし、turn_context turn IDをstable keyにする。`--days` 限定実行ではdeferredへ残す。後からtask_completeが来ても同じunitへ収束させる。

### 17.4 親・子Codex rolloutの料金重複

未決: 親累積counterが子利用を含むかを現コードとfixtureだけでは証明できない。

推奨: 今回は全rollout独立走査を維持し、exact same turn unitだけを去重する。推測で子を除外しない。実データを匿名fixture化して別レビューを行う。

### 17.5 stat失敗時のactive guard

未決: 現在はstat失敗時に処理へ進む。

推奨: rescan/rebuildではfail closed、通常増分sweepでは既存互換を維持して読取処理へ進む。ただしread後にsource fingerprintを検証できない場合はcursorをcommitしない。

### 17.6 stateサイズ

決定: 全unitを永続化すると長期利用でstateが増えるため、単一JSONのhard上限では運用しない。

初回releaseから2-hex prefix shard + 複数segment rolloverを実装し、上限到達時は次segmentへ進む。doctorは総件数・segment数・異常増加を警告するが、警告閾値だけで書込停止しない。compactはhistory/tombstone/deferredの意味を壊さない別設計とし、直近500件へ切り詰める方式へ戻さない。

### 17.7 rebuild時の価格と為替

決定: sourceから再計算する対象と既存額を維持する対象を分ける。

既存present/redacted recordは保存金額を保持する。clearedまたはnever-present recordはrebuild実行時の価格・為替で計算し、「現在条件による復元」であることをdry-run・確認・完了表示へ明記する。完全な当時額再現や `--reprice` は別機能とする。

## 18. オーケストレーションと最終確認

各waveの担当は次をhandoffする。

- 変更ファイル一覧
- 変更前REDと変更後GREENのテスト名・結果
- 永続化schemaとmigration差分
- fault injection結果
- privacy確認結果
- OS/timezone matrix結果
- 未解決リスク
- docs/contracts更新箇所
- revert方法

独立レビュー担当は最低限次を敵対的に確認する。

- 7日→全件で取りこぼし・二重計上がないか
- clear/redact意図を再走査が破っていないか
- history/state/cursorの中間クラッシュ状態
- Claude agent active競合
- Codex累積baselineとturn ID競合
- secret欠損・破損時のfail-closed
- Windows rename/pathとUTC cutoff
- legacyデータに対する暗黙の推測移行がないか

オーケストレーターは実装を行わず、全差分、RED/GREEN証跡、独立レビュー、最終matrixを自分で確認してからmerge可否を判断する。
