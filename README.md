<p align="center">
  <img src="docs/images/h3mise-readme-banner.png" alt="H3Mise — Local-first AI video project workspace" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f4511e" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/local--first-yes-f4511e" alt="Local-first">
</p>

<p align="center">
  <strong>中文</strong> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a>
</p>

# H3Mise — 本地 AI 视频项目管理工作台

> **mise** 来自电影术语 *mise-en-scène*（场面调度）。

> 生成工具负责生成画面，H3Mise 负责让这些画面属于同一部作品。

H3Mise 是一个 **local-first、Shot-first、AI-optional** 的 AI 视频项目管理工作台。它不和生成模型比画质，也不试图替代专业剪辑软件；它保存一部作品的故事、资产、Shot、多个 Take、选择结果、连续性、渲染任务和时间线，让创作者更换模型或 Provider 后仍能继续同一个项目。

生成器通常只需要完成一次任务；长视频项目却要记住每一个决定：这个角色使用哪张参考图、某个 Shot 为什么重做、多个 Take 中选了哪个、下一镜要延续什么、失败任务对应哪个服务。缺少项目层，这些信息很容易散落在聊天记录、网页任务、ComfyUI 工作流和本地文件夹里。

H3Mise 管理的正是这一层：

```text
故事 → 叙事骨架 / StoryBeat →（可选 Storyboard）→ Shot 设计 → 渲染任务 → Take 历史
                                                                    ↓
                                                          Selected → 连续性 → 时间线
```

![Good Boy 导演台](docs/screenshots/director-desk.png)

## 它适合什么

- 使用多个生成工具制作同一部 AI 视频，需要统一管理项目状态。
- 一个 Shot 会生成多个版本，需要保留 Take 历史和最终选择，而不是覆盖文件。
- 长视频跨天制作，需要随时恢复“做到哪里、为什么这样选、下一步是什么”。
- 希望项目、素材和导演决策保存在本机，而不是绑定某个在线工作台。
- 想让 ComfyUI、RunningHub 或后续 Provider 各自负责生成，由同一项目承接结果。

## 它不是什么

- **不是视频生成模型**：H3Mise 不承诺生成得更好，也不能减少模型本身的抽卡概率。
- **不是 ComfyUI 的替代品**：ComfyUI 仍负责本地工作流编排，H3Mise 可以把它作为项目的 Render Provider。
- **不是专业非线性编辑器**：裁切、转场、音量统一和导出用于完成基本收尾；复杂剪辑仍可交给专业软件。
- **不是成熟的全能平台**：核心项目链路已经跑通，快速剪辑等体验仍在公开完善中。

## 一部 AI 视频如何被管理

1. **定义作品**：整理梗概、正文和总时长，把故事拆成可拍摄的 StoryBeats；骨架和 AI 默认重整当前正式 Beats，不会在末尾追加另一套。
2. **可选 Storyboard**：先免费检查 3 / 6 / 9 格文字规划，再决定是否调用独立的 RunningHub 生图 App。批准后会接入 Shotboard；长故事自动分页，每页和单格重生都单独确认费用。
3. **建立资产与状态**：管理人物、生物、场景和参考素材，记录角色在不同阶段的状态。
4. **规划 Shot**：为每个镜头保存时长、画幅、生成模式、主角色、场景、Prompt 和像素档位。
5. **跟踪渲染任务**：预检后提交任务，记录 Provider、任务 ID、进度、失败原因和执行时间，避免把重复付费当作重试。
6. **管理 Take 与选择**：同一 Shot 的每次生成都是独立 Take；也可把其他工具已经生成的视频导入为 Candidate Take。保留候选、Selected 与 rejected 状态，不用新文件覆盖旧结果。
7. **传递连续性**：读取 Selected Take 的尾帧和实际状态，将人物、动物、道具与空间关系交给下一镜头。
8. **组装与交付**：把 Selected Takes 放入时间线，完成必要的裁切、转场、响度统一和本地导出。

## Good Boy 内置示例

仓库自带约 40 秒的情景喜剧项目 **Good Boy**：Olivia 向 Ben 炫耀边境牧羊犬 Newton 能听懂许多指令，训犬师却发现真正被训练的是 Olivia。示例包含完整故事、人物与生物资产、场景参考、镜头设计和连续性数据，可直接打开、修改和继续生成。

![Good Boy 故事规划](docs/screenshots/story.png)

![人物、生物与场景资产](docs/screenshots/assets.png)

## 主要能力

- **作品级数据模型**：故事、资产、CharacterState、Shot、Take、连续性和时间线拥有明确关系，而不是一组无关联文件。
- **可选 Storyboard**：按叙事段数生成 3 / 6 / 9 格文字规划，超过 9 段自动分页；文字编辑免费，整页或单格生图均明确确认后才调用 RunningHub。批准后会复用或补齐对应 Shot，并绑定分格参考图；重复批准不会重复建 Shot。
- **叙事骨架**：内置多种 3 / 6 / 9 段节奏结构。套用默认重整当前正式 Beats，而不是在末尾追加另一套；AI 拆解会读取并原子更新当前 Beats，再只补齐缺失 Shots。未配置 AI 时仍可本地匹配。
- **导演风格翻译**：熟悉的作品名、类型和年代只用于匹配通用导演属性，再把媒介、场景设计、光线、表演、镜头、剪辑和声音要求注入 H3Mise AI、Storyboard 与最终 H3 Prompt；不会要求模型照搬原作人物或场景。
- **Shot 与 Take 分离**：Shot 保存导演意图，每次生成创建新的 Take；外部生成的视频也能进入指定 Shot 成为 Take，重做和换工具不会抹掉历史与选择依据。
- **持久化渲染队列**：保存 Provider 任务 ID、状态、执行时长和错误阶段；远端成功、本地状态异常时可对已有任务进行对账，而不是重新付费提交。
- **Provider 可替换**：项目可明确选择 ComfyUI Local、RunningHub AI App 或离线 Mock；更换生成后端不需要重建故事和镜头结构。
- **连续性工作流**：Selected 后引导记录尾帧实际状态，并将人物、生物、道具和空间关系继承到下一 Shot。
- **资产与角色状态**：人物、动物、机器人和拟人生物均可作为主角色并绑定 CharacterState。
- **多模态 AI 辅助**：完善镜头设计和连续性时可读取参考图或尾帧；识图失败会回退到文字上下文，AI 未配置时仍可手工完成。
- **生成参数归档**：记录生成模式、引用素材、时长、画幅和 `0.6 / 0.8 / 1.0 / 1.2 MP` 等参数，便于理解每个 Take 如何产生。
- **付费任务防护**：真实渲染前执行本地 Preflight，并通过活动任务锁与能力检查减少误提交和重复提交。
- **一键制作对账**：预览会把未覆盖 Beat 即将创建的 Shot 计入真实任务数；已有 Candidate Take 或活动任务时先要求选片或对账，不会直接再次付费生成。
- **基本本地收尾**：Selected Takes 可进入时间线进行裁切、转场和响度统一，再通过 FFmpeg 导出；这是一条交付路径，不是产品的主要竞争点。
- **Local-first**：项目数据和媒体保存在 `H3MISE_HOME`，同一浏览器多标签页通过项目锁避免并发操作不同项目。

## 快速开始

需要 Node.js ≥ 22（含 `node:sqlite`）与 FFmpeg。

```bash
pnpm install

# 开发模式
pnpm dev:server   # API：http://127.0.0.1:4789
pnpm dev:web      # UI：http://127.0.0.1:5188

# 生产模式
pnpm --filter @h3mise/web build
pnpm start
```

### Windows（PowerShell）

先安装 [Node.js 22+](https://nodejs.org/)；然后在 PowerShell 中安装 pnpm 和 FFmpeg：

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

没有 Chocolatey 时，也可以自行安装 FFmpeg，但必须确保 `ffmpeg.exe` 和 `ffprobe.exe` 都在 `PATH` 中。默认项目目录是 `%USERPROFILE%\.h3mise`；素材既支持盘符绝对路径，也支持 `\\server\share\file.mp4` 形式的局域网共享路径。

首次进入“项目”页，可安装内置 Demo。项目会复制到本地数据目录，修改不会影响仓库中的原始示例。

> 不准备真实生成时可使用 Mock Provider，离线体验完整流程；本地生成可按 [ComfyUI 接入指南](ComfyUI.md) 导入自己的 API Format 工作流。

## 配置

大部分配置都可以在 **设置** 页面完成。

RunningHub 分为两个站点：

- 中国大陆：[runninghub.cn](https://www.runninghub.cn/) · [API 文档](https://www.runninghub.cn/runninghub-api-doc-cn/)
- 海外 / Global：[runninghub.ai](https://www.runninghub.ai/) · [API Documentation](https://www.runninghub.ai/runninghub-api-doc-en/)

请先在 **设置 → Provider — RunningHub AI App → RunningHub 站点** 选择区域，再使用该站点创建的账号、API Key、视频 AI App ID 和 Storyboard AI App ID，不要跨站混用。切换站点会清除旧节点验证状态，必须重新检测映射；不会因此自动提交付费任务。

| 配置项 | 说明 |
| --- | --- |
| **RunningHub 站点** | 选择中国大陆 `runninghub.cn` 或海外 `runninghub.ai`；视频、Storyboard、上传、查询统一使用该区域 |
| **RunningHub API Key** | 真实渲染所需，必须来自所选站点；也可使用 `RUNNINGHUB_API_KEY` 环境变量 |
| **AI App** | 可粘贴自己的 AI App ID 和节点映射，或自动检测工作流节点 |
| **Storyboard 生图** | 可选的独立 RunningHub AI App；复用同一 API Key，但单独保存 App ID、Prompt / Size / Layout Image 节点映射、尺寸与费用预估 |
| **ComfyUI Local** | 导入 `workflow_api.json`，检查输入映射并检测本地服务；详见 [ComfyUI.md](ComfyUI.md) |
| **内置 AI** | 使用 `AI_BASE_URL / AI_API_KEY / AI_MODEL` 配置 OpenAI 兼容模型 |

其他可选环境变量：`PORT`（默认 `4789`）、`H3MISE_HOME`（默认 `~/.h3mise`）、`H3MISE_PROVIDER=mock|runninghub`、`H3MISE_SERVE_WEB=0`。

如果不熟悉 Provider，可以让编码助手先阅读 [AGENTS.md](AGENTS.md)。RunningHub 的安全配置、自动节点检测与首次低成本验证写在其中；ComfyUI 的 Agent 接入协议、Profile 映射和排错步骤在 [ComfyUI.md](ComfyUI.md)。助手不能未经确认发起真实渲染。

## 页面

- **快速剪辑（待完善）**：目前提供简化入口，但剪辑操作仍跳转到专业时间线，尚未形成独立的新手闭环。
- **故事**：故事事实、正文、总时长与 StoryBeat 管理；骨架和 AI 默认重整当前 Beats，可一键为未覆盖 Beat 补齐 Shot 与最小导演计划。
- **Storyboard（可选）**：免费编辑文字分格；按页确认付费生图、单格重生和版本保留。批准后接入 Shotboard，也可以完全跳过。
- **镜头**：Shotboard 与 Director Desk；绑定资产、设计镜头、生成 Prompt、预检和渲染。
- **资产**：人物、生物、场景、角色状态、媒体素材与引用绑定。
- **时间线**：裁切、转场与本地导出。
- **设置**：视频 Provider、可选 Storyboard 生图 Provider、导演风格、内置 AI、工作流节点和环境检查。

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
