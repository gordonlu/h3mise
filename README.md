<p align="center">
  <img src="docs/images/h3mise-readme-banner.png" alt="H3Mise — Local-first AI video director workstation" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f4511e" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/local--first-yes-f4511e" alt="Local-first">
</p>

# H3Mise — 本地 AI 视频导演工作台

> **mise** 来自电影术语 *mise-en-scène*（场面调度）。

把「写 Prompt、反复抽卡」变成「设计 Shot、选择 Take、剪辑成片」。

H3Mise 是一个 **local-first、Shot-first、AI-optional** 的生成式视频导演工作台。故事、资产、镜头设计、Prompt、Take、连续性和时间线都保存在本地；生成可交给本机 ComfyUI、RunningHub AI App 或离线 Mock Provider。

![Good Boy 导演台](docs/screenshots/director-desk.png)

## 从故事到成片

1. **写故事**：整理梗概、正文和总时长，拆成可拍摄的 StoryBeats。
2. **准备资产**：管理人物、生物、场景和角色状态，用参考图固定外观。
3. **设计镜头**：为每个 Shot 设置时长、画幅、生成模式、主角色、场景和像素档位。
4. **生成与选片**：预检后提交渲染，同一 Shot 可生成多个 Take，支持预览、对比、Selected 和 rejected 管理。
5. **保持连续性**：AI 可读取 Selected Take 的尾帧并填写实际状态；下一镜头继承人物、动物、道具和空间关系。
6. **专业时间线剪辑**：进入时间线裁切、添加转场，最后用 FFmpeg 在本地导出。快速剪辑目前为预览入口，剪辑操作仍会进入专业时间线，完整新手流程待完善。

## Good Boy 内置示例

仓库自带约 40 秒的情景喜剧项目 **Good Boy**：Olivia 向 Ben 炫耀边境牧羊犬 Newton 能听懂许多指令，训犬师却发现真正被训练的是 Olivia。示例包含完整故事、人物与生物资产、场景参考、镜头设计和连续性数据，可直接打开、修改和继续生成。

![Good Boy 故事规划](docs/screenshots/story.png)

![人物、生物与场景资产](docs/screenshots/assets.png)

## 主要能力

- **Shot-first**：Shot 保存导演意图，Take 保存生成结果，两者严格分离。
- **多模态 AI**：完善镜头设计和连续性时可读取参考图或尾帧；识图失败会自动回退到文字上下文。
- **人物与生物主角**：人物、动物、机器人和拟人生物均可绑定 CharacterState。
- **可控生成**：支持文生视频、首帧生视频、首尾帧生视频、参考图生视频等模式，以及 `0.6 / 0.8 / 1.0 / 1.2 MP` 输出档位。
- **可选渲染后端**：项目可明确选择 ComfyUI Local、RunningHub AI App 或 Mock；Provider 未配置时不会静默切到另一个真实服务。
- **连续性工作流**：Selected 后明确引导记录尾帧状态，并可将 Actual 状态继承到下一镜头的 Planned 状态。
- **本地时间线**：选中 Take 后可裁切、加转场，并在本地 FFmpeg 导出成片。
- **统一成片响度**：导出时可逐片段执行两遍响度归一化，减少不同 Take 之间忽大忽小的问题。
- **渲染队列**：任务持久化、状态恢复、运行时长和历史耗时展示。
- **防浪费**：付费渲染前执行本地 Preflight，拦截缺失素材或配置错误。
- **项目锁**：同一浏览器的多个标签页不会并发操作不同项目，可明确切换当前项目。
- **AI 可选**：没有内置 AI 也能手工完成全流程；支持 OpenAI 兼容接口。

## 快速开始

需要 Node.js ≥ 22（含 `node:sqlite`）与 FFmpeg。

```bash
pnpm install

# 开发模式
pnpm dev:server   # API：http://127.0.0.1:4789
pnpm dev:web      # UI：http://127.0.0.1:5173

# 生产模式
pnpm --filter @h3mise/web build
pnpm start
```

首次进入“项目”页，可安装内置 Demo。项目会复制到本地数据目录，修改不会影响仓库中的原始示例。

> 不准备真实生成时可使用 Mock Provider，离线体验完整流程；本地生成可按 [ComfyUI 接入指南](ComfyUI.md) 导入自己的 API Format 工作流。

## 配置

大部分配置都可以在 **设置** 页面完成。

| 配置项 | 说明 |
| --- | --- |
| **RunningHub API Key** | 真实渲染所需；也可使用 `RUNNINGHUB_API_KEY` 环境变量 |
| **AI App** | 可粘贴自己的 AI App ID 和节点映射，或自动检测工作流节点 |
| **ComfyUI Local** | 导入 `workflow_api.json`，检查输入映射并检测本地服务；详见 [ComfyUI.md](ComfyUI.md) |
| **内置 AI** | 使用 `AI_BASE_URL / AI_API_KEY / AI_MODEL` 配置 OpenAI 兼容模型 |

其他可选环境变量：`PORT`（默认 `4789`）、`H3MISE_HOME`（默认 `~/.h3mise`）、`H3MISE_PROVIDER=mock|runninghub`、`H3MISE_SERVE_WEB=0`。

如果不熟悉 Provider，可以让编码助手先阅读 [AGENTS.md](AGENTS.md)。RunningHub 的安全配置、自动节点检测与首次低成本验证写在其中；ComfyUI 的 Agent 接入协议、Profile 映射和排错步骤在 [ComfyUI.md](ComfyUI.md)。助手不能未经确认发起真实渲染。

## 页面

- **快速剪辑（待完善）**：目前提供简化入口，但剪辑操作仍跳转到专业时间线，尚未形成独立的新手闭环。
- **故事**：故事事实、正文、总时长与 StoryBeat 管理。
- **镜头**：Shotboard 与 Director Desk；绑定资产、设计镜头、生成 Prompt、预检和渲染。
- **资产**：人物、生物、场景、角色状态、媒体素材与引用绑定。
- **时间线**：裁切、转场与本地导出。
- **设置**：Provider、AI、工作流节点和环境检查。

## 目录结构

```text
shared/   # Server 与 Web 共用的领域类型
server/   # Node + Hono + SQLite + FFmpeg + Provider + RenderQueue
web/      # Vue 3 前端
demo/     # 可安装的示例项目
scripts/  # 运维与验证脚本
```

技术栈：Vue 3 + TypeScript + Vite · Node.js + Hono · SQLite (`node:sqlite`) · FFmpeg · SSE

## License

H3Mise 使用 [MIT License](LICENSE) 开源。Copyright © 2026 Gordon.
