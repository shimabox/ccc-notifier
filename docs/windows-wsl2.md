# Windows / WSL2 での導入 / Windows & WSL2

[← README に戻る](../README.md)

Windows で使う場合、**Claude Code を Windows で直接使う**か、**WSL2(Windows 上の Linux)の中で使う**かで手順が少し異なります。

## A. ネイティブ Windows で使う場合

1. **Node.js 20+** を入れる(`winget install -e --id OpenJS.NodeJS.LTS` など)
2. **Git for Windows(Git Bash)** を入れる — Claude Code は Windows 上では Stop hook を **Git Bash 経由で実行**するため、これが無いと通知・記録が動きません([Git for Windows](https://git-scm.com/download/win))
3. [インストール](../README.md#インストール--install) の手順どおりに導入して `init` を実行

通知は Windows の**トースト通知**として表示されます。

## B. WSL2(Windows 上の Linux)の中で使う場合

Claude Code を WSL2 の中で動かしている場合は、**WSL2(Linux)側**に導入します。

1. WSL2 の中に **Node.js 20+** を入れる(Git Bash は不要)
2. WSL2 の中で [インストール](../README.md#インストール--install) の手順どおりに導入し、`init` を実行

WSL2 は**自動検出**され、次のように Windows 側へ橋渡しします:

- **通知** → Windows のトースト通知(`powershell.exe` 経由・WSL interop を使用)
- **ダッシュボード** → Windows の既定ブラウザで表示(`report.html` / `report-all.html` は WSL 内に置いたまま Windows パスへ変換して開くため、Windows ユーザー名に全角が含まれていてもパス解決に失敗しません)

前提として `powershell.exe` が WSL interop から使えること(通常は既定で有効)。うまく動かないときは `doctor` で検出結果と通知経路を確認できます:

```bash
ccc-notifier doctor   # 方法B(ソースから)の場合: node dist/cli.js doctor
# → 「WSL2 環境を検出しました。通知は Windows のトースト(powershell.exe)経由で送信します」と表示されます
```
