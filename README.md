# H3Mise — 本地 AI 视频导演工作台

> **mise** 来自电影术语 *mise-en-scène*（场面调度 / 镜头内导演）—— 与产品的
> Shot、Blocking、Camera、Performance、Continuity 概念完全同构。

把「写 Prompt → 抽卡」变成「**导演 Shot → 选择 Take**」。

H3Mise 是一个 **local-first、Shot-first、AI-optional** 的生成式视频导演工作台：
本地负责故事、镜头（Shot）、资产、导演计划、连续性、Prompt、Take、时间线与项目状态；
**RunningHub 仅作为视频渲染 Provider**（接入你自己的 H3 AI App，可在设置页配置与检测节点映射）。

## 核心流程

1. **写故事** — 录入故事事实与节拍（StoryBeat）
2. **拆镜头** — 在 Shotboard 上规划每个 Shot（画幅 / 时长 / 模式 / 意图）
3. **准备资产** — 素材库管理实体、角色状态、首尾帧、参考图/参考视频/音频，并绑定到 Shot
4. **导演拍摄** — Director Desk 编排导演计划（内容 / 表演 / 机位 / 光影），AI 可辅助建议，也可粘贴外部 AI 结果或直接写 Raw Prompt
5. **渲染拿 Take** — 预检通过后提交渲染（付费前本地确定性检查），RunningHub 异步生成
6. **选片** — 每个 Shot 可以多次渲染多个 Take：预览、A/B 对比、选片或拒片
7. **连续性** — 以实际选中的 Take 为准提交视觉 / 叙事连续性
8. **剪辑成片** — Timeline 用选中的 Take 拼接、打点裁剪、加转场，ffmpeg 本地导出

## 功能特性

- **Shot-first**：一次生成 = 一个连续短镜头事件；Shot 意图与 Take 结果严格分离
- **AI-optional**：无内置 AI 时产品完整可用；可手工编辑、从外部 AI 粘贴、或可选配置内置 LLM（OpenAI 兼容：OpenAI / DeepSeek / MiniMax / Ollama 等）
- **本地优先**：项目、资产、Prompt、Take、连续性、Timeline 全部保存在本地（SQLite + 文件系统），渲染队列持久化，重启自动恢复
- **防浪费**：渲染前 Preflight 本地确定性检查，拦截明显错误再付费
- **双模式渲染**：真实 RunningHub 渲染（需要 API Key 与积分）或离线 Mock 渲染（无网开发体验）
- **多项目**：每个项目独立目录（`<项目>.h3studio/`），顶栏一键切换
- **Story Bible 导入**：`POST /api/import/bible` 支持 `h3mise-bible@1`，格式见 `docs/bible-import-format.md`
- **中文界面**，内置英文界面切换

## 快速开始

需要：Node.js ≥ 22（含 `node:sqlite`）、FFmpeg（视频抽帧 / 导出用）。

```bash
# 安装依赖
pnpm install

# 开发模式（两个终端，或任选其一）
pnpm dev:server   # Node 本地服务 :4789
pnpm dev:web      # Vite 前端 :5173（代理 /api → :4789）

# 生产模式（server 直接托管构建后的前端）
pnpm --filter @h3mise/web build
pnpm start        # 打开 http://127.0.0.1:4789
```

## 配置

大部分配置在 **Settings 页** 完成，无需改文件：

| 配置项 | 说明 |
| --- | --- |
| **RunningHub API Key** | 渲染必需。可在设置页填写（RunningHub 控制台 → 设置 → API Token），或设置环境变量 `RUNNINGHUB_API_KEY`；设置页的值优先 |
| **AI App** | 默认接入官方 H3 工作流；可在设置页粘贴自己的 AI App ID 与节点映射，或点「检测并获取节点映射」自动适配 |
| **内置 AI（可选）** | 设置环境变量 `AI_BASE_URL / AI_API_KEY / AI_MODEL`（OpenAI 兼容） |

环境变量一览（均为可选）：`PORT`（默认 4789）、`H3MISE_HOME`（数据目录，默认 `~/.h3mise`）、`H3MISE_PROVIDER=mock|runninghub`、`RUNNINGHUB_API_KEY`、`AI_BASE_URL / AI_API_KEY / AI_MODEL`、`H3MISE_SERVE_WEB=0`（禁用 :4789 托管已构建 UI，纯 API 模式）。

> 未配置 API Key 时渲染走内置 Mock Provider（离线合成），可完整体验全流程。

## 页面

- **Projects** — 项目创建 / 打开
- **Story** — 故事事实层 + StoryBeat 管理，AI 一键拆解节拍
- **Shots** — Shotboard：封面、状态、Take 数、风险标识
- **Shot 详情 = Director Desk** — 三栏：资产需求 / 舞台预览 / 导演台
  （导演计划分区编辑 · AI 建议 · 外部 AI 粘贴 · 引用 · Prompt · 预检 · 渲染），
  下方 Takes（选片 / 拒片 / A-B 对比 / 失败标签 / 帧桥接）
- **Assets** — 实体 / 角色状态 / 素材 / 引用绑定
- **Timeline** — 选中 Take 拼接、裁剪、转场、ffmpeg 后台导出
- **Settings** — 项目配置 / Provider（API Key、AI App、节点检测）/ 环境检查

## 目录结构

```text
shared/   # 领域类型（server / web 共享的唯一真相）
server/   # Node + Hono + SQLite + FFmpeg + Providers + RenderQueue
web/      # Vue 3 前端
scripts/  # 运维与验证脚本
```

## 技术栈

Vue 3 + TypeScript + Vite · Node.js + Hono · SQLite（`node:sqlite`）· FFmpeg · SSE
