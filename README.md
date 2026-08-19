# H3Mise — A local director workstation for MiniMax H3

> **mise** 来自电影术语 *mise-en-scène*（场面调度 / 镜头内导演）—— 与产品的
> Shot、Blocking、Camera、Performance、Continuity 概念完全同构。

把「写 Prompt → 抽卡」变成「**导演 Shot → 选择 Take**」。

面向 MiniMax H3 的 **local-first、Shot-first、AI-optional** 生成式视频导演工作台。
本地负责故事、Shot、资产、导演计划、连续性、Prompt、Take、时间线与项目状态；
**RunningHub 仅作为视频渲染 Provider**（v0.1 固定接入用户自己的 H3 AI App）。

## 快速开始

```bash
pnpm install
# 可选：配置 RunningHub API Key（渲染必需）
cp .env.example .env.local   # 填入 RUNNINGHUB_API_KEY

# 开发模式（两个终端或 --parallel）
pnpm dev:server   # Node 本地服务 :4789
pnpm dev:web      # Vite 前端 :5173（代理 /api → :4789）

# 或生产模式（server 直接托管构建后的前端）
pnpm --filter @h3mise/web build
pnpm start        # http://127.0.0.1:4789
```

> 环境变量：`RUNNINGHUB_API_KEY`、`PORT`（默认 4789）、`H3MISE_HOME`（默认
> `~/.h3mise`）、`H3MISE_PROVIDER=mock|runninghub`（离线合成渲染，用于开发/验收）、
> 可选 AI：`AI_BASE_URL / AI_API_KEY / AI_MODEL`（OpenAI-compatible）。
> API Key 只从环境变量读取，绝不写入项目文件。

## 产品原则（PRD v0.4 §0，开发不可回退）

1. **Shot 是第一等公民** — Project/Story/Sequence 都服务于 Shot；一次 H3 生成 = 一个连续短镜头事件。
2. **AI-Optional by Design** — 无内置 AI 时产品完整可用；可手工编辑、从外部 AI 粘贴、粘贴 Raw Prompt，或可选配置内置 LLM。
3. **Local-first** — 项目、资产、Prompt、Take、连续性、Timeline、历史全部本地保存。
4. **先导演，再生成** — 核心中间表示是 `DirectorPlan`；Prompt 是其编译产物之一，也允许 Raw Prompt 绕过。
5. **Preflight 在付费渲染之前** — 本地确定性检查（可选 AI 语义检查）拦截明显错误，杜绝浪费。
6. **Take 才是生成结果** — Shot 是意图，Take 是一次实际生成；一 Shot 多 Take / 多 PromptVersion / 多 Reference。
7. **连续性以实际选中的 Take 为准** — `Planned ≠ Actual`；只有 Take 被选中后才可 Commit Actual Continuity。
8. **资产由 Shot 需求驱动** — 先拆 Shot，再算缺什么资产；Asset Library 按需生长。
9. **RunningHub 只接用户自己的 AI App**（`2089265538441764866`），保留 `VideoProvider` 抽象但 v0.1 不做复杂扩展。
10. **H3 理论能力 ≠ Provider 可执行能力** — Director/Prompt 层理解 T2VA/I2VA/FL2VA/L2VA/Ref2VA；UI/Render 只开放当前 AI App Profile 实际支持的。

## 架构

```text
Browser (Vue 3 + TypeScript + Vite + Pinia + Vue Router)
        ↓ localhost HTTP / SSE（127.0.0.1:4789，Origin/Host 校验 + Session CSRF）
Node.js + TypeScript (Hono)
├─ SQLite (node:sqlite) — 元数据；媒体走 filesystem
├─ FFmpeg (child_process) — 抽帧/poster/trim/concat/导出
├─ RenderQueue（持久化，重启恢复轮询）
├─ RunningHubAiAppProvider（v2 API：upload → nodeInfoList → submit → taskId → query → download）
├─ MockProvider（离线合成渲染，任务持久化，可完整验收全流程）
└─ Optional AI（OpenAI-compatible；Skills 本地加载）
```

项目目录（`<项目>.h3studio/`）：

```text
project.db / project.json
assets/            # MediaAsset 文件
shots/<shot>/      # frames/ prompts/ takes/ exports/
cache/ timeline/ exports/
```

## 页面

- **Projects** — 项目创建/打开（Single Shot / Sequence / Story）
- **Shots** — Shotboard（封面、状态、Take 数、风险标识）
- **Shot 详情 = Director Desk** — 三栏：Assets 需求 / Stage 预览 / Inspector
  （DirectorPlan 分区编辑 · AI Suggest · Paste External · References · Prompt
  · Preflight · Render），下方 Takes（选片/拒片/A-B Compare/失败标签/Frame Bridge）
- **Story** — 故事事实层 + StoryBeat 管理
- **Assets** — Entity / CharacterState / MediaAsset / ReferenceBinding
- **Timeline** — Selected Takes 拼接、trim、转场、ffmpeg 导出（后台任务）
- **Settings** — 项目 / Provider（检测并获取 AI App 节点映射）/ AI 配置

## 验证脚本

```bash
scripts/e2e-mock.sh           # 完整离线闭环：导入→绑定→预检→渲染→Take→选片→连续性→时间线→导出
scripts/verify-standards.sh   # PRD §52：安全守卫/遍历防护/SSE/可追溯/强杀恢复
scripts/verify-scenarios-bc.sh# 验收场景 B（外部 AI 粘贴）与 C（Raw Prompt）
scripts/restart-server.sh     # 干净重启本地服务（mock 模式）
```

## 核心不变量（PRD §54）

Shot ≠ Take · DirectorPlan ≠ Prompt · Planned ≠ Actual（Visual ≠ Narrative）
· AI suggestion ≠ program state · RunningHub state ≠ project truth
· Asset identity ≠ CharacterState · Provider capability ≠ H3 theoretical
capability · Prompt 编译 ≠ 付费渲染 · Select Take ≠ 自动 Commit Continuity
· Timeline 只用 Selected Take，不用最新 Take。

## 目录

```text
shared/   # 领域类型（server/web 共享的唯一真相）
server/   # Node + Hono + SQLite + FFmpeg + Providers + RenderQueue
web/      # Vue 3 SPA
scripts/  # 验收与运维脚本
.doc/     # PRD（MiniMax-H3-Director-Workstation-PRD-v0.4）
```

> 完整规格见 `.doc/MiniMax-H3-Director-Workstation-PRD-v0.4.md`。
