# Release Guard

CloudFrontを経由して配信するWebアプリについて、デプロイ前から開いていた画面と、デプロイ後に開いた画面の両方が動くかを検証するCLIです。

ローカルで実行できる初期実装です。CLI、ブラウザ検証、設定診断、HTML／JSONレポート、CloudFrontの任意の設定参照を実装しています。npmへの公開と実AWS環境での動作確認は未実施です。

## 解決する問題

デプロイ後、旧版の画面からページ遷移するとJavaScriptが取得できず、画面が壊れることがあります。新しく開いた画面だけを確認するテストでは、この問題を見逃します。

Release Guardは、旧版のブラウザを起動したまま既存のデプロイコマンドを実行し、更新前後の操作と通信を記録します。失敗したURL、返された形式、ビルド成果物、CloudFrontの設定から、観測した不具合と原因候補をレポートします。

## 初期版の範囲

- React／Viteの静的SPA、S3＋標準CloudFrontディストリビューション。
- Linux／WSLまたはLinuxのCIランナーで動く、単一プロセスのCLI。
- Chromiumを使用した旧版タブと新版タブの検証。
- JSON設定、JSON／HTMLレポート、CI向け終了コード。
- CloudFront設定を参照する任意の読み取り機能。

## ローカルで試す

Node.js 24以降、Linux／WSLが対象です。

```bash
npm ci --ignore-scripts
npm run browser:install
npm run build
npm run demo
```

デモはループバックアドレスで短時間だけ配信し、3ケースを実行後にサーバーを停止します。AWS認証とAWSリソースは不要です。Vite形式のmanifestを持つ小さなJavaScriptアプリを使用し、CloudFrontやReactの忠実なエミュレーターではありません。

| ケース | 期待する結果 |
|---|---|
| `keep` | 旧版のファイルを保持し、旧版と新版がともに成功 |
| `missing` | 旧版の遅延ロードJSが404になり、不具合を検出 |
| `html` | JSの要求に200＋HTMLが返り、不具合を検出 |

`demo-results/<ケース>/<実行ID>/report.html`をブラウザで開いて結果を確認できます。デモは想定どおりに故障を検出できた場合もコマンド全体を成功終了します。CLI本体は不具合検出時に終了コード1を返します。

ChromiumのOS依存がない環境では、Playwright公式の`npx --no-install playwright install-deps chromium`でセットアップします。管理者権限を使わず、Ubuntu 24.04 x64で`libnspr4`／`libnss3`だけが不足する場合は、次の補助手段もあります。

```bash
npm run browser:deps-local
```

この補助手段はUbuntuの設定済みAPTリポジトリからパッケージをダウンロードし、`.browser-deps/`へ展開します。OSのパッケージ設定は変更しません。`npm test`、`npm start`、`npm run demo`はこのフォルダを認識します。ビルド済みCLIを直接実行する場合は、必要に応じて`LD_LIBRARY_PATH`へ`.browser-deps/usr/lib/x86_64-linux-gnu`の絶対パスを指定してください。

## 自分のアプリに組み込む

1. HTMLへ`<meta name="release-guard-build" content="ビルド固有ID">`を埋め込みます。ViteのHTML環境変数置換を使う場合は`%VITE_RELEASE_ID%`を指定し、ビルド時に設定します。
2. Vite設定の`build.manifest`を有効にし、新版をローカルでビルドします。対象ステージング環境には旧版が公開されている状態にします。
3. [設定例](examples/release-guard.json)をコピーし、URL、ビルド成果物のパス、`data-testid`、遅延ロード対象JSのパターンを変更します。パスは設定ファイルの位置が基準です。
4. `RELEASE_ID`に新版のHTMLへ埋め込んだIDを設定します。
5. CLIで既存のデプロイコマンドを囲みます。

```bash
node dist/cli.js validate --config /path/to/app/release-guard.json
node dist/cli.js run --config /path/to/app/release-guard.json -- node /path/to/app/scripts/deploy-staging.mjs
```

`/path/to/app`以下は利用者のプロジェクトの例です。Release Guardは指定したデプロイコマンドを実際に1回実行するため、ステージング用のコマンドを指定してください。`--`以降は実行ファイルと引数です。シェルの`&&`やリダイレクトは解釈しません。デプロイの作業ディレクトリはCLIを起動したディレクトリです。

検証する操作は、旧版・新版で共通の`data-testid`を使い、旧版では未取得のチャンクを読み込むものを選びます。先読み済みの場合、旧版の継続利用を検証したとは扱わず、終了コード2を返します。

CIではビルド、CLIを介したデプロイ、レポート保存を同じジョブに置きます。同じ配信先への同時デプロイはCIのconcurrencyで直列化し、`cancel-in-progress: false`にします。レポートは`always()`条件で保存します。外部コントリビューターの変更へAWS認証を渡すワークフローにしないでください。本リポジトリの[CI](.github/workflows/ci.yml)はAWSを使わないローカルテスト専用です。

## CloudFrontの設定参照

ブラウザ検証だけなら`cloudfront.mode`を`disabled`にします。設定診断を有効にする場合は、`mode`を`optional`または`required`にし、`distributionIdFromEnv`でIDを入れた環境変数名を指定します。認証にはAWS SDKの標準認証チェーンを利用します。

必要なAPI権限は`cloudfront:GetDistributionConfig`と`cloudfront:GetCachePolicy`です。参照できない場合、`optional`はブラウザの検証を続けて診断不可を表示し、`required`は実行エラーにします。事前の必須参照に失敗した場合はデプロイを始めません。

設定参照機能はCloudFrontを変更しません。利用者のデプロイコマンドには別途その操作に必要な権限が必要です。現時点では通常のAWS商用パーティションを対象とします。

## 結果と制約

| 終了コード | 意味 |
|---|---|
| 0 | 要求した検証が完了し、違反を検出していない |
| 1 | 操作失敗や配信不整合を検出 |
| 2 | 設定不備、事前確認失敗、デプロイ失敗、検証不成立 |
| 130／143 | SIGINT／SIGTERMによる中断 |

1実行拠点・実行時点での検証です。事前確認でエッジキャッシュが温まる場合があり、全POPや将来のキャッシュミスでの成功は保証しません。Service Worker、SSR、APIバージョン互換性、自動ロールバックは未対応です。URL書き換え後の無効化パスの自動診断も今後の対象です。

レスポンス本文、Cookie、認証ヘッダー、画面画像、トレースは保存しません。URLのクエリと不明な動的パスもレポートに残しません。デプロイ子プロセスの出力は元のCIログへ流れるため、そのスクリプト側でも秘密情報を出力しない運用が必要です。

## 開発と検証

```bash
npm run schema:check
npm run typecheck
npm run build
npm run test:coverage
```

公開する[JSON Schema](schemas/release-guard.schema.json)は`src/schema.ts`から`npm run schema`で生成します。Ajvによる実行時検証と同じ定義を使用します。カバレッジ基準は行・分岐・関数それぞれ80%以上です。

## 設計書

[詳細設計と実装計画](.claude/docs/DESIGN.md)に、利用フロー、構成、判定ルール、設定例、権限、受け入れ条件を記載しています。

実AWS環境への接続・リソース作成・デプロイは行っていません。CloudFront APIの取得・権限不足は模擬応答で検証しています。次の検証段階は、所有するステージング環境への導入です。

設計日: 2026-10-31
