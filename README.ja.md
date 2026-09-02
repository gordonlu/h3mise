<p align="center">
  <img src="docs/images/h3mise-readme-banner.png" alt="H3Mise — Local-first AI 映像制作ワークスペース" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f4511e" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/local--first-yes-f4511e" alt="Local-first">
</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a> · <strong>日本語</strong>
</p>

# H3Mise — ローカル優先 AI 映像プロジェクトワークスペース

> **mise** は映画用語 *mise-en-scène*（ミザンセーヌ / 画面設計）に由来します。

> 生成ツールは映像を作り、H3Mise はその映像をひとつの「作品」に属させる。

H3Mise は **local-first・Shot-first・AI-optional** の AI 映像プロジェクトワークスペースです。生成モデルに画質で勝負するつもりはなく、プロ用編集ソフトの代わりになるつもりもありません。作品のストーリー、アセット、Shot、複数の Take、選択結果、連続性（コンティニュイティ）、レンダリングタスク、タイムラインをひとつに保ち、クリエイターがモデルや Provider を変えても同じプロジェクトを続けられるようにします。

生成ツールはひとつのタスクを終えればそれでよいものですが、長尺映像プロジェクトはすべての決定を覚えていなければなりません。このキャラクターはどの参考画像を使うのか、その Shot をなぜ作り直したのか、複数の Take のうちどれを選んだのか、次のカットが引き継ぐべき状態は何か、失敗タスクはどのサービスに属していたのか。プロジェクト層がないと、そうした情報はチャット履歴、Web タスク、ComfyUI ワークフロー、ローカルフォルダに散らばってしまいます。

H3Mise が管理するのはまさにその層です:

```text
ストーリー → 物語骨格 / StoryBeat →（任意）Storyboard → Shot 設計 → レンダリングタスク → Take 履歴
                                                                            ↓
                                                              Selected → 連続性 → タイムライン
```

![Good Boy 監督デスク](docs/screenshots/director-desk.png)

## こんな用途に

- 複数の生成ツールでひとつの AI 映像を作り、プロジェクト状態をひとつに管理したい。
- ひとつの Shot に複数のバージョンが生まれるので、ファイルを上書きせず Take の履歴と最終選択を残したい。
- 数日にわたる長尺制作で、「どこまで進んだか、なぜこの選択か、次は何か」をいつでも再現できるようにしたい。
- プロジェクト・素材・監督上の決定をローカルに保ち、特定のオンラインワークスペースに縛られたくない。
- ComfyUI・RunningHub や将来の Provider に生成を任せ、結果の受け皿は同じプロジェクトにしたい。

## これは何ではないか

- **映像生成モデルではありません**: より良い出力を約束せず、モデル本来の抽選性も減らせません。
- **ComfyUI の代替ではありません**: ComfyUI はローカルワークフロー編成を担い続け、H3Mise はそれを作品の Render Provider として使えます。
- **プロ仕様の NLE ではありません**: トリミング・トランジション・音量正規化・書き出しは基本仕上げのためであり、高度な編集はプロ用ソフトに委ねます。
- **万能プラットフォームでもありません**: コアのプロジェクトパイプラインは動きますが、クイック編集などの体験はいまだ公開段階で磨いている最中です。

## AI 映像はどう管理されるか

1. **作品を定義する**: ログライン、本文、総尺を整理し、ストーリーを撮影可能な StoryBeat に分割します。骨格と AI は別セットを末尾追加せず、現在の正式 Beats を標準で再構成します。
2. **任意の Storyboard**: まず無料の 3 / 6 / 9 コマ文字プランを確認し、その後で独立した RunningHub 生図 App を使うか決めます。承認後は Shotboard に接続し、長いストーリーは自動ページ分割、ページ・単コマ再生成の費用は個別確認します。
3. **アセットと状態を作る**: 人物・生物・シーン・参考素材を管理し、キャラクターの各時点の状態を記録します。
4. **Shot を計画する**: 各カットごとに尺、画角、生成モード、メインキャラクター、シーン、Prompt、MP 段階を保存します。
5. **レンダリングタスクを追跡する**: Preflight 後にタスクを送信し、Provider・タスク ID・進捗・失敗理由・実行時間を記録します。有料の再送信を無料のリトライと混同させません。
6. **Take と選択を管理する**: 同じ Shot の生成はすべて独立した Take です。他ツールで生成済みの映像を Candidate Take として取り込むこともできます。candidate / selected / rejected の状態を保ち、ファイルを上書きして古い結果を消したりしません。
7. **連続性を引き継ぐ**: Selected Take の最終フレームと実際の状態を読み取り、人物・動物・小道具・空間関係を次のカットへ渡します。
8. **組み立てて納品する**: Selected Takes をタイムラインに置き、必要なトリミング、トランジション、音量正規化を行い、ローカルで書き出します。

## Good Boy 同梱サンプル

リポジトリには約 40 秒のシチュエーションコメディ **Good Boy** が同梱されています。Olivia はボーダーコリーの Newton が多くの指示を理解できると自慢しますが、調教師は「本当にトレーニングされているのは Olivia の方だ」と気づきます。サンプルには完全なストーリー、人物・生物アセット、シーン参考、Shot 設計、連続性データが含まれており、そのまま開いて変更し、生成を続けられます。

![Good Boy ストーリー計画](docs/screenshots/story.png)

![人物・生物・シーンのアセット](docs/screenshots/assets.png)

## 主な機能

- **作品レベルのデータモデル**: ストーリー、アセット、CharacterState、Shot、Take、連続性、タイムラインが、ばらばらなファイル群ではなく明示的な関係を持ちます。
- **任意の Storyboard**: 無料の 3 / 6 / 9 コマ文字プランと、明示確認された生図。承認後は対応 Shot を再利用または補完し、コマ画像を参照として結びます。再承認しても Shot は重複しません。
- **物語骨格**: 3 / 6 / 9 セグメントの内蔵構造は、別セットを末尾追加せず現在の正式 Beat を標準で再構成します。AI も現在の Beats を読み、サーバーで原子的に更新して不足 Shot だけを作成します。AI なしでもローカルマッチング可能です。
- **監督スタイル翻訳**: 馴染みのある作品名・ジャンル・年代は、汎用の監督属性の引き当てにのみ使い、メディア、美術、ライティング、演技、カメラ、編集、サウンドの指示を H3Mise AI・Storyboard・最終 H3 Prompt に注入します。原作の人物やシーンをそのままモデルに再現させることはありません。
- **Shot と Take の分離**: Shot は監督意図を保持し、生成のたびに新しい Take が作られます。外部生成の映像も指定 Shot に Take として入り、やり直しやツール変更でも履歴と選択根拠は残ります。
- **永続化されたレンダリングキュー**: Provider タスク ID、状態、実行時間、失敗段階を保存。遠端成功・ローカル状態異常の際は、再課金ではなく既存タスクを突き合わせます。
- **差し替え可能な Provider**: ComfyUI Local、RunningHub AI App、オフライン Mock をプロジェクトごとに明示できます。バックエンドの変更でストーリーやカット構成を立て直す必要はありません。
- **連続性ワークフロー**: Selected 後に最終フレームの実際の状態記録を促し、人物・生物・小道具・空間関係を次 Shot へ継承します。
- **アセットとキャラクター状態**: 動物、ロボット、擬人化クリーチャーもメインキャラクターとして CharacterState にバインドできます。
- **マルチモーダル AI 支援**: Shot 設計や連続性のブラッシュアップ時に参考画像や最終フレームを読み取ります。視覚認識の失敗はテキストコンテキストへフォールバックし、AI 未設定でもすべて手動作業が可能です。
- **生成パラメータの記録**: 生成モード、参照素材、尺、画角、`0.6 / 0.8 / 1.0 / 1.2 MP` などのパラメータを保存し、各 Take がどう生まれたかを後から追えます。
- **有料タスクの保護**: 実レンダリング前にローカル Preflight を実行し、アクティブタスクロックと能力チェックで誤送信・重複送信を減らします。
- **ワンクリック照合**: 未カバー Beat から作る Shot も事前の実タスク数に含めます。Candidate Take や実行中タスクがあれば、選択・拒否・照合まで再送信しません。
- **基本のローカル仕上げ**: Selected Takes をタイムラインに入れてトリミング・トランジション・音量統一を行い、FFmpeg で書き出します。これは納品経路であって、製品の主な競争点ではありません。
- **Local-first**: プロジェクトデータとメディアは `H3MISE_HOME` に保存。同じブラウザの複数タブはプロジェクトロックにより、別プロジェクトへの同時操作を防ぎます。

## クイックスタート

Node.js ≥ 22（`node:sqlite` 同梱）と FFmpeg が必要です。

```bash
pnpm install

# 開発モード
pnpm dev:server   # API: http://127.0.0.1:4789
pnpm dev:web      # UI: http://127.0.0.1:5188

# 本番モード
pnpm --filter @h3mise/web build
pnpm start
```

### Windows（PowerShell）

まず [Node.js 22+](https://nodejs.org/) をインストールし、PowerShell で pnpm と FFmpeg を用意します:

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
choco install ffmpeg -y

node --version
pnpm --version
ffmpeg -version
ffprobe -version
pnpm install
pnpm build
pnpm start
```

Chocolatey がなくても FFmpeg を自分でインストールして構いませんが、`ffmpeg.exe` と `ffprobe.exe` の両方が `PATH` に入っていることを確認してください。デフォルトのプロジェクトディレクトリは `%USERPROFILE%\.h3mise` です。素材はドライブ文字の絶対パスにも、`\\server\share\file.mp4` 形式の LAN 共有パスにも対応します。

最初に「プロジェクト」ページを開き、同梱デモをインストールできます。プロジェクトはローカルデータディレクトリへコピーされるため、編集してもリポジトリ内の元サンプルは影響を受けません。

> まだ実生成は不要なら Mock Provider で全フローをオフライン体験できます。ローカル生成には [ComfyUI 接続ガイド](ComfyUI.md) に沿って自分の API Format ワークフローを読み込みます。

## 設定

設定の大半は **設定** ページで完結します。

| 設定項目 | 説明 |
| --- | --- |
| **RunningHub API Key** | 実レンダリングに必須。`RUNNINGHUB_API_KEY` 環境変数でも設定可 |
| **AI App** | 自分の AI App ID とノードマッピングを貼り付け、またはワークフローノードを自動検出 |
| **Storyboard 生図** | 任意の独立 RunningHub AI App。同じ API Key を使用しつつ、App ID、Prompt / Size / Layout Image のノードマッピング、サイズ、費用見積を個別に保持 |
| **ComfyUI Local** | `workflow_api.json` を読み込み、入力マッピングを検査してローカルサービスを検出。詳細は [ComfyUI.md](ComfyUI.md) |
| **内蔵 AI** | `AI_BASE_URL / AI_API_KEY / AI_MODEL` で OpenAI 互換モデルを設定 |

その他の任意環境変数: `PORT`（既定 `4789`）、`H3MISE_HOME`（既定 `~/.h3mise`）、`H3MISE_PROVIDER=mock|runninghub`、`H3MISE_SERVE_WEB=0`。

Provider に不慣れなら、まずコーディングアシスタントに [AGENTS.md](AGENTS.md) を読ませてください。RunningHub の安全な設定、自動ノード検出、初回低コスト検証が書かれています。ComfyUI の Agent 接続プロトコル、Profile マッピング、トラブルシューティングは [ComfyUI.md](ComfyUI.md) にあります。アシスタントは確認なしで実レンダリングを開始してはいけません。

## ページ

- **クイック編集（準備中）**: 簡易入口はありますが、編集操作はプロ用タイムラインへ飛ぶため、まだ初心者向けの完結ループには至っていません。
- **ストーリー**: 事実、本文、総尺、正式 StoryBeat。骨格と AI は現在の Beats を再構成し、未カバー Beat から不足 Shot と最小 DirectorPlan を補えます。
- **Storyboard（任意）**: 無料の文字コマ編集と明示確認された生図。承認後は Shotboard に接続し、不要なら丸ごとスキップできます。
- **Shot**: Shotboard と Director Desk。アセットバインド、Shot 設計、Prompt 生成、Preflight、レンダリング。
- **アセット**: 人物、生物、シーン、キャラクター状態、メディア素材、参照バインド。
- **タイムライン**: トリミング、トランジション、ローカル書き出し。
- **設定**: 動画 Provider、任意の Storyboard 生図 Provider、監督スタイル、内蔵 AI、ワークフローノード、環境チェック。

## リポジトリ構成

```text
shared/   # Server と Web が共有するドメイン型
server/   # Node + Hono + SQLite + FFmpeg + Provider + RenderQueue
web/      # Vue 3 フロントエンド
demo/     # インストール可能なサンプルプロジェクト
scripts/  # 運用・検証スクリプト
```

技術スタック: Vue 3 + TypeScript + Vite · Node.js + Hono · SQLite (`node:sqlite`) · FFmpeg · SSE

## License

H3Mise は [MIT License](LICENSE) でオープンソース公開されています。Copyright © 2026 Gordon.
