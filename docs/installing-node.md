# Node.js の用意(まだ入っていない方へ)/ Installing Node.js

[← README に戻る](../README.md)

すでに Node.js 20 以上をお使いの方は、この節を読み飛ばして [インストール](../README.md#インストール--install) に進んでください。

## 推奨: mise

このリポジトリには [mise](https://mise.jdx.dev)(プログラミング言語のバージョン管理ツール)用の設定ファイル `mise.toml` が同梱されています。mise を使うとプロジェクトごとのバージョン切り替えが楽になり、`mise install` の1コマンドで本リポジトリが必要とする Node.js 20 が入ります。

1. **mise をインストールする**

   macOS・Linux 共通(公式インストールスクリプト):

   ```bash
   curl https://mise.run | sh
   ```

   macOS で Homebrew を使っている場合はこちらでも構いません。

   ```bash
   brew install mise
   ```

2. **シェルに mise を認識させる(activate)**

   お使いのシェルの設定ファイルに1行追記し、シェルを再読み込みします。

   zsh の場合:

   ```bash
   echo 'eval "$(~/.local/bin/mise activate zsh)"' >> ~/.zshrc && source ~/.zshrc
   ```

   bash の場合:

   ```bash
   echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc && source ~/.bashrc
   ```

3. **Node.js 20 を入れる**

   本リポジトリを clone する前でも実行できるように、まずはグローバルの既定バージョンとして Node.js 20 を入れます。

   ```bash
   mise use -g node@20
   ```

   (この後「インストール」で本リポジトリを clone すると、同梱の `mise.toml` を使って `mise install` を実行する手順が出てきます。リポジトリのディレクトリ内で `mise install` を実行した場合も、`mise.toml` が指定する Node.js 20 が同様に入ります。)

4. **確認する**

   ```bash
   node -v
   ```

   `v20.x.x` のように表示されれば成功です。

補足: Windows での mise は、公式ドキュメントによると現時点では shim 経由の実行のみのサポートで、`mise.toml` の内容が素直に反映されない場合があります。Windows をお使いの方は下の「代替」の方法をおすすめします。

## 代替: 公式インストーラ

mise を使わない場合は、[nodejs.org](https://nodejs.org/en/download) の公式インストーラ(macOS・Windows・Linux 共通)から Node.js 20 以上を入れてください。

- **Windows**: winget が使える場合は次のコマンドでも入ります(LTS版が入ります)。

  ```powershell
  winget install -e --id OpenJS.NodeJS.LTS
  ```

  winget が使えない場合は [nodejs.org](https://nodejs.org/en/download) から公式インストーラをダウンロードしてください。
