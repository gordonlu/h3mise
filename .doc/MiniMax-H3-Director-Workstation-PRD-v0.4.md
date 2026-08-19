# MiniMax H3 本地导演工作台 PRD v0.4

> 工作名称：**H3 Director Workstation**  
> 日期：2026-08-19  
> 定位：面向 MiniMax H3 的 **local-first、Shot-first、AI-optional** 生成式视频导演工作台。  
> 本地负责故事、Shot、资产、导演计划、连续性、Prompt、Take、时间线与项目状态；RunningHub 仅作为视频渲染 Provider。

---

## 0. 最终 Review 结论

以下原则视为已确认，开发时不要退回传统“AI 自动短剧生成器”模式。

1. **Shot 是第一等公民**
   - Project / Story / Sequence 最终都服务于 Shot。
   - 每次 H3 生成默认对应一个连续的短镜头事件。
   - Director、Render、Take Review 都属于 Shot 生命周期。

2. **AI-Optional by Design**
   - 无内置 AI 时整个产品仍可完整使用。
   - 用户可以完全手工编辑、从外部 AI 复制结果、直接粘贴 H3 Prompt，或可选配置内置 LLM。
   - AI 是加速器，不是运行时依赖。

3. **Local-first**
   - 项目、资产、Prompt、Take、连续性、Timeline、历史记录全部保存在本地。
   - RunningHub 只承担远程渲染。

4. **先导演，再生成**
   - 不把一个大 Prompt 文本框当核心交互。
   - 核心中间表示是 `DirectorPlan`。
   - Prompt 是 DirectorPlan 的编译产物之一，也允许绕过 DirectorPlan 直接使用 Raw Prompt。

5. **Preflight 在付费渲染之前**
   - 先跑本地确定性检查，再可选运行 AI 语义/物理/复杂度检查。
   - 目标是减少因为明显错误浪费生成费用。

6. **Take 才是生成结果**
   - Shot 是导演意图，Take 是一次实际生成。
   - 一个 Shot 支持多 Take、多 Prompt Version、多 Reference Variant。

7. **连续性以实际选中的 Take 为准**
   - 区分 `Planned Continuity` 与 `Actual Continuity`。
   - 只有 Take 被选中后，其实际结束状态才能提交到 Continuity Ledger。

8. **资产由 Shot 需求驱动**
   - 先拆 Shot，再分析每个 Shot 缺什么资产。
   - Asset Library 按需生长。

9. **RunningHub v0.1 只接用户自己的 AI App**
   - 当前实际渲染入口固定为用户已发布的 RunningHub AI 应用：
     `https://www.runninghub.cn/openapi/v2/run/ai-app/2089265538441764866`
   - 使用用户个人账户 API Key，通过环境变量 `RUNNINGHUB_API_KEY` 注入。
   - v0.1 不要求接 RunningHub Model API，也不要求重新上传/发布一套 Workflow。
   - 代码仍保留 `VideoProvider` 抽象，方便未来增加 Local ComfyUI / RunningHub Model API / 其他 Provider，但不要为了未来扩展把首版做复杂。

10. **H3 理论能力与当前 AI App 输入能力分层**
   - Director / Prompt 层仍理解 T2VA / I2VA / FL2VA / L2VA / Ref2VA 等 H3 逻辑模式。
   - 真正能否渲染、需要哪些字段、允许哪些素材，由当前 RunningHub AI App 的参数映射决定。
   - v0.1 不需要维护 420+ 模型端点目录，也不需要动态选择 RunningHub 标准模型。

---

# 1. 产品目标

## 1.1 一句话定位

> **把“写 Prompt → 抽卡”变成“导演 Shot → 选择 Take”。**

## 1.2 用户问题

普通 AI 视频工具常见问题：

- 剧本、角色、场景、Prompt、视频彼此割裂；
- 用户在大文本框里反复修改 Prompt；
- 生成失败后无法知道是哪一层出了问题；
- 一个镜头多次生成后缺少 Take 管理；
- 上一个镜头的实际结束状态无法可靠传递到下一个镜头；
- 生成前缺少物理、连续性、引用素材与复杂度检查；
- AI 被做成强制入口，没有 API Key 时产品不可用；
- 远程生成平台成为项目状态中心，迁移困难；
- 长片工作流仍以“分集”为中心，不适合 H3 的短 Shot 生成单元。

---

# 2. 目标用户

- **H3 单镜头创作者**：输入一张图 / 一句话，制作电影感 Shot。
- **AI 短片创作者**：制作多个连续镜头，重视人物、场景、服装、方向与事件连续性。
- **Prompt / Skill 研究者**：保存 DirectorPlan、PromptVersion、Reference、Take 与失败原因。
- **不使用内置 LLM 的用户**：依赖 ChatGPT 网页版、Claude、Codex 或其他外部 AI。

---

# 3. 非目标

v0.1 不以以下方向为核心：

- 不做完整 NLE / AE / Resolve 替代品；
- 不做通用多模型 AI 视频 SaaS；
- 不强制自动生成完整剧集；
- 不要求内置图片生成模型；
- 不要求项目上传云端；
- 不让 LLM 直接拥有数据库状态；
- 不依赖聊天界面完成主要编辑；
- 不把复杂 Workflow Editor 暴露给普通用户。

---

# 4. 顶层信息架构

顶层页面只保留：

```text
1. Story
2. Shots
3. Assets
4. Timeline
```

附加：

- Project Settings
- Provider Settings
- AI Settings（可选）
- Render Queue（全局抽屉/面板）

Director Desk 是 Shot 详情页，不是一级导航。

---

# 5. 核心数据层级

```text
Project
├─ Story
│  ├─ StoryBeat
│  └─ Sequence
├─ Assets
│  ├─ Entities
│  │  ├─ Character
│  │  ├─ Scene
│  │  ├─ Prop
│  │  ├─ Vehicle
│  │  └─ Creature
│  ├─ CharacterState
│  ├─ MediaAsset
│  └─ ReferenceBinding
├─ Shots
│  └─ Shot
│     ├─ DirectorPlan versions
│     ├─ Prompt versions
│     ├─ Reference bindings
│     ├─ Preflight reports
│     ├─ Render jobs
│     └─ Takes
├─ ContinuityLedger
└─ Timeline
   └─ TimelineClip → Selected Take
```

---

# 6. Project Setup

新建项目支持：

```text
Single Shot
Short Sequence
Story / Episode
```

基础配置：

```yaml
project:
  title:
  format: single_shot | sequence | story
  default_aspect_ratio: "16:9"
  visual_style:
  default_provider: runninghub
  default_video_model: minimax_h3
  default_duration_seconds:
```

`Single Shot` 不要求 Story。

---

# 7. Story

## 7.1 输入

支持：

- 一句话创意；
- 一段剧情；
- 完整剧本；
- 小说片段；
- 已有分镜文字；
- 手工 StoryBeat；
- 外部 AI 生成的结构化 Story JSON/YAML。

## 7.2 Story 保存事实层

Story 阶段主要形成：

- Character
- Location
- Prop
- StoryBeat
- State Change
- Time / Weather
- Knowledge / Relationship State

不得在 Story 阶段直接把整部作品编译成 H3 Prompt。

---

# 8. Shot Planning

把 StoryBeat 转换成 H3 可执行的连续生成单元。

> **默认：一个 Shot = 一个连续电影事件。**

禁止默认把多个不同场景、反打、插入镜头或大量硬切塞进同一次生成。

最小结构：

```yaml
shot:
  id:
  sequence_id:
  order:
  title:
  story_beat_id:
  purpose:
  duration_seconds:
  status:
```

支持：

- 手工新增 Shot；
- 内置 AI 拆 Shot（可选）；
- 复制外部 AI 模板；
- 粘贴结构化 Shot List。

---

# 9. Shots / Shotboard

Shot Card 显示：

- 缩略图 / Selected Take 封面；
- Shot 编号；
- 标题；
- 时长；
- H3 Mode；
- Shot Function；
- 主角色；
- 场景；
- 状态；
- Take 数量；
- Selected Take；
- 风险标识；
- 缺失资产提示。

用户可见状态：

```text
待导演
准备生成
生成中
待选片
已完成
```

---

# 10. Shot 状态机

内部：

```text
DRAFT
→ PLANNED
→ ASSETS_READY
→ DIRECTED
→ PREFLIGHT_READY
→ RENDERING
→ HAS_TAKES
→ SELECTED
→ CONTINUITY_COMMITTED
→ LOCKED
```

允许有限回退。

---

# 11. Asset Library

资产层分成三类，不混为一张表：

```text
Entity
├─ Character
├─ Scene
├─ Prop
├─ Vehicle
└─ Creature

State
└─ CharacterState

MediaAsset
├─ image
├─ video
└─ audio
```

`First Frame / Last Frame / Motion Reference / Style Reference / Audio Reference`
都不是独立实体类型，而是 **MediaAsset 通过 ReferenceBinding 承担的用途**。

例如：

```text
MediaAsset(image) + role=first_frame
MediaAsset(image) + role=last_frame
MediaAsset(video) + role=motion
MediaAsset(image) + role=identity
MediaAsset(audio) + role=audio
```

## Character 与 CharacterState 必须拆开

```text
Character = “这个人是谁”
CharacterState = “这个人在当前剧情状态是什么样”
```

例如：

```yaml
character_state:
  character_id: lin_yu
  costume: wet_white_shirt
  hair: wet
  injury: forehead_cut
  held_items: []
```

## Shot-driven Asset Requirements

Shot 形成后计算：

```text
Required
✓ Character
✓ Scene
⚠ CharacterState missing
⚠ First Frame missing

Optional
○ Motion Reference
○ Audio Reference
```

资产来源 v0.1 支持：

- 本地导入；
- 拖拽；
- 文件夹导入；
- 从 Selected Take 抽帧；
- 外部软件生成后导入。

图片生成 Provider 只做扩展点，不是 v0.1 强依赖。

---

# 12. Director Desk

布局：

```text
┌──────── Assets ────────┬──────── Stage / Preview ───────┬──── Shot Inspector ────┐
│ Character              │                                 │ Intent                  │
│ Scene                  │ Current frame / take / compare │ Blocking                │
│ Props                  │                                 │ Camera                  │
│ References             │                                 │ Performance             │
│                        │                                 │ Reality                 │
│                        │                                 │ References              │
│                        │                                 │ Prompt                  │
└────────────────────────┴─────────────────────────────────┴─────────────────────────┘

Takes / Render Variants
```

核心编辑对象是 DirectorPlan，而不是大 Prompt 文本框。

---

# 13. DirectorPlan

```yaml
director_plan:
  version:

  intent:
    shot_function:
    visual_thesis:
    dramatic_goal:
    peak:
    end_state:

  subject:
    primary_subject:
    action:
    primary_motion_owner:

  blocking:
    start_position:
    end_position:
    facing:
    movement_axis:
    travel_path:
    spatial_relationships:

  camera:
    shot_size_start:
    shot_size_peak:
    shot_size_end:
    geometry:
    lens_intent:
    dominant_behavior:
    trigger:
    speed_relation:
    stop_condition:

  performance:
    objective:
    obstacle:
    tactic:
    performance_turn:
    movement_quality:
      weight:
      time:
      space:
      flow:
    anticipation:
    primary_action:
    follow_through:
    recovery:
    gaze:
    end_pose:

  environment:
    location:
    weather:
    medium:
    wind:
    lighting:
    foreground:
    midground:
    background:

  reality:
    mode: strict_realism | plausible_stylized | deliberate_fantasy
    constraints: []

  continuity:
    planned_start_state:
    planned_end_state:

  generation:
    requested_mode:
    duration_seconds:
    aspect_ratio:
    audio_intent:
```

---

# 14. Reality / Physics

默认：

- 现实环境 / 生物 / 车辆 / 飞机 / 物体 → `strict_realism`
- 风格化但保留基本因果 → `plausible_stylized`
- 用户明确超现实 → `deliberate_fantasy`

原则：

> **Break one law intentionally, not every law accidentally.**

Rule Set 至少覆盖：

1. Geometry / structure
2. Gravity / support / contact
3. Inertia / momentum
4. Cause → effect
5. Medium rules
6. Biology / anatomy / locomotion
7. Vehicle / aircraft mechanics
8. Light / shadow / reflection
9. Temporal continuity
10. Known-fact contradiction

优先级：

```text
Reality / factual correctness
>
Identity / structural consistency
>
Subject motion correctness
>
Spatial readability
>
Camera design
>
Effects / spectacle
```

---

# 15. H3 Generation Mode Resolver

逻辑层支持：

```text
T2VA
I2VA
FL2VA
L2VA
Ref2VA
```

建议规则：

```text
无关键帧 / 空间自由 → T2VA
有首帧，希望继续 → I2VA
首尾都明确 → FL2VA
只有目标尾帧 → L2VA
需要身份/动作/视频/音频参考 → Ref2VA
```

用户可 override。

Provider 必须暴露：

```ts
interface ProviderCapabilities {
  supportedModes: H3Mode[];
  minDuration?: number;
  maxDuration?: number;
  supportedAspectRatios?: string[];
  supportedResolutions?: string[];
  maxImageRefs?: number;
  maxVideoRefs?: number;
  maxAudioRefs?: number;
  audioSupported?: boolean;
}
```

核心层不硬编码平台限制。Director / Prompt 层可以理解 H3 的完整理论模式，
但 UI 与 Render 层只开放当前 Provider Profile 实际声明可执行的模式。

---

# 16. H3 官方能力映射原则

截至 2026-08-19，MiniMax H3 官方公开资料显示：

- H3 支持文本、图像、视频、音频多模态上下文；
- 输出可带原生立体声音频；
- 输出最长 15 秒；
- Prompt Skill 明确定义 T2VA / I2VA / FL2VA / L2VA / Ref2VA；
- FL2VA checkpoint 可以无图、单首帧、单尾帧或首尾帧；
- Ref2VA 支持混合多模态参考；
- 复杂 Ref2VA 需要清晰 reference mapping。

RunningHub 当前公开 H3 模型目录展示：

- 文生视频；
- 首帧 / 尾帧 / 首尾帧图生视频；
- 多模态参考生视频；
- 5–15 秒；
- 2K 输出选项。

因此不能把 “H3 理论能力” 与 “当前 RunningHub 某 endpoint 能力” 混成同一层。

---

# 17. Reference Assignment

Reference 必须有职责：

```yaml
reference_binding:
  id:
  asset_id:
  type: image | video | audio
  role:
    - identity
    - costume
    - environment
    - motion
    - timing
    - camera_motion
    - lighting
    - style
    - audio
  preserve: []
  ignore: []
  label:
```

例如 Motion Reference：

```yaml
role:
  - body_motion
  - timing
preserve:
  - motion rhythm
ignore:
  - actor identity
  - costume
  - scene
```

---

# 18. Prompt System

## PromptVersion

```yaml
prompt_version:
  id:
  shot_id:
  source:
    type: deterministic_compiler | ai_compiler | external_ai | manual
  director_plan_version:
  text:
  h3_mode:
  created_at:
```

支持两条路径：

### Structured

```text
DirectorPlan → Compiler → H3 Prompt
```

### Raw Prompt

```text
用户粘贴 H3 Prompt → PromptVersion → Preflight → Render
```

Raw Prompt 不要求 DirectorPlan。

---

# 19. Deterministic Prompt Compiler

必须存在，不依赖 AI。

职责：

- 根据 H3 Mode 输出稳定结构；
- 按固定顺序编译 Subject / Action / Space / Camera / Performance / Environment / Reality / Sound；
- 加入 Reference labels；
- 不做事实猜测；
- 不发明缺失剧情。

Base Modes 优先兼容：

```text
integrated_multimodal_description
overall_soundscape
non_diegetic_music
```

Ref2VA 使用独立模板：

```text
subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music
```

模板外部配置化。

---

# 20. AI Enhanced Compiler

可选。

输入：

```text
DirectorPlan + deterministic draft + H3 rules
```

输出：

- 更自然；
- 更紧凑；
- 消除重复；
- 明确时间顺序；
- 保留 DirectorPlan 事实；
- 不擅自增加新事件。

结果保存为新的 PromptVersion，不能覆盖旧版本。

---

# 21. External AI Workflow

每个 Shot 提供：

```text
Copy for External AI
```

生成上下文包：

```yaml
project:
story_context:
previous_selected_take:
continuity:
assets:
shot:
director_plan:
provider_constraints:
task:
output_schema:
```

支持粘贴：

- YAML DirectorPlan；
- JSON DirectorPlan；
- Shot List；
- H3 Prompt；
- 普通 Markdown / Text。

解析成功：

```text
Preview Diff → Apply
```

解析失败：

```text
Save as Note → 手工搬字段
```

首次启动默认：

```text
Built-in AI: Not configured
```

核心功能仍全部可用。

---

# 22. Built-in AI

Provider 抽象：

```ts
interface DirectorModel {
  complete(input: DirectorInput): Promise<string>;
  structured<T>(input: DirectorInput, schema: unknown): Promise<T>;
}
```

v0.1 最低实现：

- `OpenAI-compatible` 通用适配器。

可扩展：

- OpenAI
- DeepSeek
- MiniMax
- Local Ollama
- Other

AI 可做：

- Story → StoryBeat
- StoryBeat → Shots
- DirectorPlan
- Camera 优化
- Performance 优化
- Reality semantic check
- Continuity semantic check
- AI Prompt 编译
- Take 失败诊断
- Prompt Repair

AI 不得拥有：

- Selected Take
- Render status
- asset path
- taskId
- timeline order
- prompt version truth
- continuity committed state
- billing record
- file hash

这些都是程序事实。

---

# 23. H3 Director Skills Integration

内置 AI Director 第一版加载：

```text
h3-micro-cinematic-director
├─ h3-shot-pattern-library
└─ h3-performance-director
```

职责：

```text
h3-micro-cinematic-director
  总入口 / 协调者
  决定镜头目的、表达与最终导演计划

h3-shot-pattern-library
  提供摄影机与主体空间模式

h3-performance-director
  提供主体表演、动作、重量、物理与运动语法
```

Prompt Compiler 是主导演内部步骤，不是第四个独立 Skill。

Reality Rules 先作为工作台内建 Rule Set。

---

# 24. Preflight

Generate 必须经过：

```text
Basic Preflight
→ Optional AI Semantic Preflight
→ User confirms Render
```

## Basic Preflight（无 AI）

检查：

- Prompt 非空；
- duration 合法；
- Provider 支持当前 mode；
- aspect ratio 合法；
- reference 文件存在；
- reference 类型合法；
- first/last frame 格式正确；
- required asset 未失效；
- external file path 可读取；
- Shot / PromptVersion / DirectorPlan 引用完整；
- RunningHub credential 可用；
- 当前 Render 不重复提交。

## AI Semantic Preflight（可选）

检查：

- 物理动作合理；
- 镜头与主体运动冲突；
- 短时长动作是否过载；
- 首尾状态是否物理可达；
- 多主体动作是否过载；
- Continuity 语义冲突；
- Reference 角色是否冲突；
- 事实性明显错误。

输出：

```text
H3 PREFLIGHT

Reality        ✓
Continuity     ✓
References     ✓
Complexity     ⚠ Medium
Provider       ✓
Duration       ✓

Risk: LOW / MEDIUM / HIGH

[Generate]
```

无 AI：

```text
AI semantic checks: Not run
```

不阻止生成。

---

# 25. RunningHub Render Provider

## 25.1 v0.1 的唯一实际渲染后端

v0.1 直接调用用户自己的 RunningHub AI App：

```text
https://www.runninghub.cn/openapi/v2/run/ai-app/2089265538441764866
```

它对应用户已经在 RunningHub 中配置好的 H3 工作流 / AI 应用。

工作台不需要重新实现 ComfyUI 图、不需要让用户选择 RunningHub 标准模型，也不需要要求 Enterprise-Shared Key。

认证：

```text
RUNNINGHUB_API_KEY
```

从本机环境变量读取。UI 可以提供“检测连接”与“打开配置说明”，但 API Key 不进入 Project 文件。

## 25.2 为什么仍然保留 Provider 抽象

虽然 v0.1 只实现一个实际后端，但业务层仍使用：

```text
VideoProvider
└─ RunningHubAiAppProvider      v0.1

Future:
├─ LocalComfyUIProvider
├─ RunningHubModelProvider
└─ OtherProvider
```

接口保持最小：

```ts
interface VideoProvider {
  capabilities(): Promise<ProviderCapabilities>;
  uploadAsset(asset: MediaAsset): Promise<UploadedAsset>;
  submit(request: RenderRequest): Promise<RenderJobHandle>;
  status(handle: RenderJobHandle): Promise<RenderStatus>;
  result(handle: RenderJobHandle): Promise<RenderResult>;
  cancel(handle: RenderJobHandle): Promise<void>;
}
```

不要在 v0.1 实现未使用的 Provider。

## 25.3 AI App 参数映射

固定 AI App 的**实际 Invoke Example / 当前可调用请求与响应 schema 是唯一真相**。

不得同时拼接两套不同 RunningHub AI App 协议，也不得根据示例仓库自行猜测当前 AI App 的字段。
首次接入时先记录该 AI App 实际可调用的：

- invoke URL；
- HTTP method；
- auth/header 形式；
- request body；
- 文件上传方式；
- taskId 字段；
- task query / result 字段；
- 可修改输入字段；
- 输出文件字段。

然后建立本地 `AiAppProfile`：

```yaml
ai_app_profile:
  provider: runninghub
  app_id: "2089265538441764866"
  invoke_url: "https://www.runninghub.cn/openapi/v2/run/ai-app/2089265538441764866"
  protocol_version: "observed"

  capabilities:
    supported_modes: []
    min_duration:
    max_duration:
    supported_resolutions: []

  inputs:
    prompt:
      provider_field:
    first_frame:
      provider_field:
    last_frame:
      provider_field:
    duration:
      provider_field:
    resolution:
      provider_field:
```

如果实际接口使用 `nodeInfoList / nodeId / fieldName`，仅在 Provider Profile 内表达；
如果实际接口使用普通 JSON 字段，同样只在 Provider Profile 内表达。

**UI、Shot、DirectorPlan、RenderRequest 不得直接依赖 RunningHub 节点 ID。**

如果 RunningHub AI App 更新导致字段或节点变化，只更新 Profile / Provider Adapter。

## 25.4 调用流程

```text
Local Asset
↓
RunningHub Upload（需要时）
↓
将返回的 fileName 写入 AI App 输入
↓
POST AI App
↓
taskId
↓
后台轮询
↓
Success / Failed
↓
下载结果到项目 takes/
↓
创建 Take
```

Render Queue 必须持久化 `taskId`，应用关闭再启动后可继续恢复查询。

## 25.5 与 HM-RunningHub/OpenClaw_RH_Skills 对齐

RunningHub 官方 Skill 已经验证了以下模式：

- `RUNNINGHUB_API_KEY` 环境变量；
- 本地文件上传；
- AI App nodeInfo 获取 / 修改；
- 提交任务；
- `taskId` 轮询；
- 下载结果。

实现时优先参考该仓库的 AI App 客户端行为，但在本项目中使用 Node/TypeScript 原生 HTTP 实现，不需要把 Python 脚本作为运行时依赖。

---

# 26. RenderRequest

```yaml
render_request:
  provider: runninghub_ai_app
  ai_app_id: "2089265538441764866"
  mode:
  prompt_version_id:
  duration_seconds:
  aspect_ratio:
  resolution:
  references:
  provider_params:
```

`RenderRequest` 只保存业务层需要表达的渲染意图。

`node_bindings / nodeId / fieldName / provider_field` 等 RunningHub 细节由
`RunningHubAiAppProvider + AiAppProfile` 在提交前内部生成，不进入核心 domain schema。

`provider_params` 只允许保存无法抽象但确实需要持久化的 Provider 特有参数。

---

# 27. RenderJob

```yaml
render_job:
  id:
  shot_id:
  prompt_version_id:
  director_plan_version:
  provider:
  provider_task_id:
  status:
  submitted_at:
  started_at:
  finished_at:
  request_snapshot:
  provider_response_snapshot:
  cost:
  error:
```

状态：

```text
UPLOADING
SUBMITTING
QUEUED
RUNNING
SUCCEEDED
DOWNLOADING
LOCAL_READY

FAILED
CANCELLED
EXPIRED
```

---

# 28. Render Queue

全局队列支持：

- 当前排队数；
- 运行中；
- 成功；
- 失败；
- retry；
- cancel；
- 打开所属 Shot；
- 消耗记录；
- Provider taskId；
- 错误详情。

不得依赖 UI 页面保持打开才能继续轮询。

---

# 29. Take

生成成功创建 Take：

```yaml
take:
  id:
  shot_id:
  render_job_id:
  prompt_version_id:
  director_plan_version:
  local_video_path:
  poster_path:
  first_frame_path:
  last_frame_path:
  duration:
  status: candidate | selected | rejected
  rating:
  failure_tags: []
  notes:
```

---

# 30. Take Review

操作：

```text
Keep / Candidate
Reject
Select
Compare A/B
```

Failure Tags：

```text
identity_drift
bad_anatomy
physics
camera
motion
continuity
composition
lighting
reference_mismatch
text
audio
other
```

有内置 AI 时可：

```text
Analyze Failure
```

输入 DirectorPlan / Prompt / References / Take / Failure Tags，输出修改建议，但不自动再次付费生成。

---

# 31. Continuity Ledger

连续性拆成两层：

```yaml
continuity:
  visual:
    planned:
      start:
      end:
    actual:
      source_take_id:
      end:

  narrative:
    current:
```

## VisualContinuity

由 Shot 计划与实际 Selected Take 驱动，至少记录：

- Character visual state
- Costume
- Hair
- Injury appearance
- Held items
- Location
- Time / visible weather
- Wind / environmental direction
- Screen direction
- Facing
- Vehicle / prop visible state

只有：

```text
Take → Selected
```

后才允许：

```text
Commit Actual Visual Continuity
```

可手工修正后再 Commit。

## NarrativeState

由 Story / 用户 / AI 的剧情事实更新，**不能从生成视频反推为真实剧情事实**。

至少包括：

- Story knowledge
- Relationship state
- Dramatic / emotional state
- Goal / objective
- Known events

Selected Take 可以影响视觉连续性，但不会自动修改 NarrativeState。

---

# 32. Frame Bridge

Selected Take 自动生成：

- poster；
- first frame；
- last frame。

进入下一 Shot 提供：

```text
Use previous last frame as next first frame
Import / create a new first frame
Inherit continuity only
```

不强制继承上一帧。

---

# 33. Timeline

Timeline 只接受已选 Take。

职责：

- Shot 顺序；
- clip trim；
- in/out；
- simple transition；
- audio track；
- music；
- subtitle；
- export。

不负责 DirectorPlan 编辑。

---

# 34. FFmpeg

本地 FFmpeg 至少负责：

- 视频 metadata；
- poster；
- 首帧 / 尾帧抽取；
- thumbnail；
- trim；
- concat；
- 音轨混合；
- 最终导出；
- 必要格式转换。

启动时做 capability check。

---

# 35. Local Storage

推荐：

```text
<project>.h3studio/
├─ project.db
├─ project.json
├─ assets/
├─ shots/
│  └─ shot-001/
│     ├─ frames/
│     ├─ prompts/
│     ├─ takes/
│     └─ exports/
├─ cache/
├─ timeline/
└─ exports/
```

SQLite 保存元数据，媒体走 filesystem。

---

# 36. SQLite 核心表

```text
projects
story_beats
sequences
shots

entities
characters
character_states
media_assets
reference_bindings

director_plan_versions
prompt_versions

preflight_reports
render_jobs
takes

continuity_entries
timeline_clips

settings
provider_profiles
ai_profiles
```

禁止大型媒体 blob 进 SQLite。

---

# 37. 版本化

以下不可原地覆盖历史：

- DirectorPlan
- Prompt
- RenderRequest
- Take

任意 Take 必须能追溯：

```text
Take
→ PromptVersion
→ DirectorPlanVersion
→ ReferenceBindings / MediaAssets
→ Provider params
```

---

# 38. UI 关键交互

Shot Inspector：

```text
Intent        [Edit] [AI Suggest] [Paste External]
Camera        [Edit] [AI Suggest]
Performance   [Edit] [AI Suggest]
Reality       [Edit] [AI Check]
Prompt        [Standard Compile] [AI Compile] [Paste Prompt]
Preflight     [Basic Check] [AI Check]
```

AI 相关按钮仅在配置 AI 后启用。

---

# 39. 外部 AI 模板

内建：

```text
Ask External AI: Plan Shot
Ask External AI: Improve Camera
Ask External AI: Improve Performance
Ask External AI: Reality Check
Ask External AI: Compile H3 Prompt
Ask External AI: Diagnose Failed Take
```

本质全部是 `Copy Context Package`，不调用 API。

---

# 40. AI Assist / Auto Director

### Assist（默认）

- AI 给建议；
- 用户 Apply；
- 不自动付费 Render。

### Auto Director

可自动：

```text
Story
→ Beats
→ Shots
→ DirectorPlans
→ Preflight
→ Ready to Render
```

必须在真正调用 RunningHub 前停下。

---

# 41. 成本保护

显示：

- 当前 Provider；
- duration；
- resolution；
- batch/variant 数；
- RunningHub 返回消费信息（若 endpoint 提供）；
- 项目累计 Render 消耗。

批量生成前明确显示：

```text
X Shots
Y Takes
```

并二次确认。

---

# 42. 本地运行与环境变量

v0.1 默认运行形态：

```text
Browser
  ↓
Vue 3 + TypeScript
  ↓ localhost HTTP / SSE
Node.js + TypeScript
  ├─ SQLite
  ├─ Filesystem
  ├─ FFmpeg
  ├─ RenderQueue
  ├─ RunningHubAiAppProvider
  └─ Optional AI
```

启动可采用：

```bash
RUNNINGHUB_API_KEY=xxx pnpm start
```

也可以使用本地 `.env` / `.env.local`，但不得提交版本库。

启动顺序：

```text
1. Node Local Server 启动
2. SQLite 初始化 / migration
3. 恢复持久化 RenderQueue
4. 启动或提供 Vue 前端
5. 可选自动打开浏览器
```

Vue 前端不得读取或持有完整 RunningHub API Key。

---

# 43. Provider Credential

- API Key 只存本机；
- 优先 OS secure storage / keyring；
- 不写入项目文件；
- 导出项目不得包含 secret；
- logs mask key；
- diagnostics 不得输出完整 key。

---

# 44. 技术栈

v0.1 正式采用：

```text
Frontend
├─ Vue 3
├─ TypeScript
├─ Vite
├─ Pinia
└─ Vue Router

Local Server
├─ Node.js + TypeScript
├─ Fastify / Hono（二选一，保持轻量）
├─ SQLite
├─ FFmpeg
├─ RunningHubAiAppProvider
├─ RenderQueue
└─ Optional AI Provider

Storage
├─ SQLite metadata
└─ Local filesystem media
```

## 44.1 为什么不使用 Electron / Tauri

v0.1 当前没有必须依赖桌面壳的核心能力。

真正需要的是：

- 本地文件；
- SQLite；
- FFmpeg；
- RunningHub HTTP API；
- 后台 Render Queue；
- 浏览器工作台 UI。

因此 Electron / Tauri 会增加打包、IPC 与运行时复杂度，而不直接提升首版核心体验。

## 44.2 为什么不做纯 Vue SPA

纯浏览器会让这些能力明显更麻烦：

- `RUNNINGHUB_API_KEY`；
- 原生 FFmpeg；
- SQLite；
- 任意本地文件路径；
- 页面关闭后的 RenderJob 恢复；
- 长时间 RunningHub task 轮询。

所以保留一个轻量本地 Node 服务。

## 44.3 未来桌面化

如果未来确实需要：

- 双击启动；
- 自动更新；
- 系统菜单；
- 原生通知；
- 深度 OS 集成；

可以在现有 Vue + Node 架构外套 Electron，或再评估 Tauri。

v0.1 不提前承担该复杂度。

---

# 45. Node 服务模块建议

```text
server/
  app/
  project/
  story/
  shot/
  asset/
  director/
  prompt/
  preflight/
  continuity/
  render/
    provider/
      runninghub-ai-app.ts
  take/
  timeline/
  media/
  ai/
  storage/
  events/
```

原则：

- domain / service 层不要依赖 Vue；
- RunningHub 节点映射集中在 profile/config；
- FFmpeg 通过 `child_process.spawn` 调用；
- Render Queue 必须持久化；
- API Key 只从环境变量或本机配置读取；
- 不引入 NestJS、Redis、消息队列等无必要基础设施；
- Node 服务绑定 `127.0.0.1`，默认不监听 `0.0.0.0`；
- 校验 `Origin` / `Host`，只接受本机前端来源；
- 修改状态的请求必须有本地 session token，并具备 CSRF 防护；
- CORS 不允许通配 `*`；
- 文件 API 必须做 project-root/path traversal 校验。

---

# 46. Frontend 模块建议

```text
src/
  pages/
    StoryPage.vue
    ShotsPage.vue
    AssetsPage.vue
    TimelinePage.vue

  features/
    shotboard/
    director-desk/
    take-review/
    render-queue/
    external-ai/
    preflight/
    continuity/
```

---

# 47. 本地 API

Vue 不直接操作 SQLite、FFmpeg、RunningHub 或项目真实状态。

通过 localhost API：

```text
GET    /api/projects
POST   /api/projects

GET    /api/shots/:id
POST   /api/shots
PATCH  /api/shots/:id

POST   /api/render
GET    /api/render/:id
POST   /api/render/:id/cancel

POST   /api/takes/:id/select
POST   /api/takes/:id/reject

GET    /api/media/:id
POST   /api/media/extract-frame
POST   /api/timeline/export
```

`GET /api/media/:id` 必须：

- 通过 MediaAsset id 解析本地文件，不接受任意绝对路径；
- 支持 HTTP `Range` / `206 Partial Content`；
- 返回正确 Content-Type / Content-Length / Accept-Ranges；
- 支持视频 seek、Take A/B Compare 与缩略图/音频预览；
- 防止路径穿越。

Render 状态优先通过：

```text
SSE
```

从 Node 推送给 Vue。

v0.1 不必使用 WebSocket，除非后续出现真正的双向实时需求。

---

# 48. 事件模型

```text
render.job.created
render.job.queued
render.job.running
render.job.succeeded
render.job.failed
take.created
take.selected
continuity.committed
```

UI 刷新不要依赖不断全表 polling。

---

# 49. v0.1 必须实现

## 项目
- [ ] Project create/open/save
- [ ] Single Shot / Sequence / Story
- [ ] 项目自动恢复

## Story
- [ ] Story editor
- [ ] StoryBeat 手工管理
- [ ] 外部 AI Shot List 导入
- [ ] 可选内置 AI 拆解接口

## Shots
- [ ] Shotboard
- [ ] Shot CRUD
- [ ] Shot 状态
- [ ] duration / mode / purpose

## Assets
- [ ] Entity: Character / Scene / Prop / Vehicle / Creature
- [ ] CharacterState
- [ ] MediaAsset: image / video / audio
- [ ] ReferenceBinding roles
- [ ] drag & drop
- [ ] frame extraction

## Director
- [ ] DirectorPlan
- [ ] 手工编辑
- [ ] External AI copy/paste
- [ ] 本地 Skill 加载接口
- [ ] Deterministic Compiler
- [ ] Raw Prompt

## H3
- [ ] Director / Prompt 层理解 T2VA / I2VA / FL2VA / L2VA / Ref2VA
- [ ] Provider Capability 映射
- [ ] UI 只开放当前 AI App 实际支持的 Render Mode
- [ ] 至少完整跑通当前 AI App 已验证支持的模式
- [ ] 不为未支持模式伪造 Provider 请求

## Preflight
- [ ] Basic
- [ ] Reality constraints
- [ ] Continuity checks
- [ ] Provider compatibility
- [ ] AI semantic extension point

## RunningHub
- [ ] 以该 AI App 实际 Invoke Example 验证请求/响应协议
- [ ] `RunningHubAiAppProvider`
- [ ] 固定 AI App `2089265538441764866` Profile
- [ ] `RUNNINGHUB_API_KEY` 环境变量读取
- [ ] API Key 检测 / 错误提示
- [ ] 获取 / 维护 AI App 可修改字段映射
- [ ] upload assets
- [ ] submit
- [ ] taskId persist
- [ ] poll
- [ ] download
- [ ] retry / failure
- [ ] cost/usage capture when available

## Takes
- [ ] multiple takes
- [ ] compare
- [ ] candidate / reject / selected
- [ ] failure tags
- [ ] prompt traceability

## Continuity
- [ ] planned
- [ ] actual
- [ ] commit selected take
- [ ] frame bridge

## Media
- [ ] MediaAsset API
- [ ] `/api/media/:id`
- [ ] HTTP Range / 206
- [ ] video seek / A-B compare support
- [ ] project-root/path traversal protection

## Timeline
- [ ] selected takes
- [ ] order
- [ ] trim
- [ ] concat
- [ ] basic audio
- [ ] export

---

# 50. v0.1 不应砍掉

以下就是产品与普通“Prompt + API UI”的区别，不应为了做 MVP 删除：

- Take 管理；
- Prompt Version；
- DirectorPlan；
- Continuity；
- Preflight；
- External AI import；
- RunningHub Queue；
- Frame Bridge；
- Timeline export。

可后置：

- 高级调色；
- 多轨复杂字幕动画；
- 复杂音频 DAW；
- 云同步；
- 团队协作；
- 插件市场；
- 自动社区 Skill 下载；
- 自动图片资产生成。

---

# 51. 验收场景

## A. 无 AI，单镜头

1. 新建 Single Shot；
2. 导入一张首帧；
3. 手工编辑 DirectorPlan；
4. Standard Compiler；
5. Basic Preflight；
6. RunningHub I2VA；
7. 得到多个 Take；
8. Compare；
9. Select；
10. Export。

**全程无需 LLM。**

## B. 外部 AI

1. 创建 Shot；
2. Copy Context Package；
3. 丢给 ChatGPT；
4. 粘贴 YAML DirectorPlan；
5. 预览修改；
6. Compile；
7. Preflight；
8. Render。

## C. Raw Prompt

1. 创建 Shot；
2. 粘贴现成 H3 Prompt；
3. 选择 Reference；
4. Basic Preflight；
5. Render。

DirectorPlan 可为空。

## D. 连续短片

1. Story 拆 6 Shots；
2. Shot 1 生成多个 Take；
3. Select Take；
4. Commit Actual Continuity；
5. Extract last frame；
6. Shot 2 继承 continuity；
7. 用户选择是否继承上一帧；
8. 完成各 Shot；
9. Timeline；
10. Export。

## E. 失败修复

1. Take 出现人物漂移；
2. Tag `identity_drift`；
3. 可选 AI Diagnose；
4. 修改 Reference role；
5. 创建新 PromptVersion；
6. 新 Render；
7. 与旧 Take A/B Compare。

---

# 52. 验收硬标准

## AI Independence

关闭所有 AI Provider 后：

- Story 可编辑；
- Shots 可建；
- Assets 可管理；
- DirectorPlan 可编辑；
- Prompt 可编译；
- External Prompt 可导入；
- Preflight 可运行；
- RunningHub 可渲染；
- Take 可选；
- VisualContinuity 可提交，NarrativeState 可独立维护；
- Timeline 可导出。

必须全部成立。

## Recoverability

强制退出后重新启动：

- RunningHub taskId 不丢；
- 运行中任务可继续查询；
- 成功但未下载结果可恢复；
- Selected Take 不丢；
- Prompt version 不丢。

## Traceability

任意 Take 都必须回答：

```text
谁生成的？
用哪个 Prompt？
哪个 DirectorPlan？
哪些 References？
什么 Provider 参数？
什么时候生成？
为什么 Reject / Select？
```

## No Hidden Paid Actions

任何触发 RunningHub 费用的动作：

- 必须是明确用户操作；
- Auto Director 不能绕过；
- Retry 不能无限自动执行。

---

# 53. 推荐开发顺序

## Phase 1 — Core Domain

先实现：

```text
Project
Shot
Asset
DirectorPlan
PromptVersion
Take
Continuity
```

完全不接 RunningHub，也不接 AI。

## Phase 2 — RunningHub

实现：

```text
Provider
Upload
Submit
Poll
Download
Render Queue
```

先跑通 Single Shot。

## Phase 3 — Director Workbench

实现：

```text
Director Desk
Deterministic Compiler
Reference Assignment
Basic Preflight
```

## Phase 4 — Multi-shot

实现：

```text
StoryBeat
Shotboard
Continuity
Frame Bridge
Timeline
```

## Phase 5 — AI Optional Layer

最后接：

```text
External AI Templates
OpenAI-compatible
AI Director
AI Preflight
Failure Diagnosis
```

AI 最后接是为了强制验证“没有 AI 核心也能工作”。

---

# 54. 最重要的不变量

```text
1. Shot ≠ Take
2. DirectorPlan ≠ Prompt
3. Planned VisualContinuity ≠ Actual VisualContinuity；VisualContinuity ≠ NarrativeState
4. AI suggestion ≠ program state
5. RunningHub state ≠ project truth
6. Asset identity ≠ CharacterState
7. Provider capability ≠ H3 theoretical capability
8. Prompt compilation ≠ paid rendering
9. Selecting a Take ≠ automatically committing continuity
10. Timeline uses Selected Take, not latest Take
```

---

# 55. 外部依赖事实（2026-08-19 核实）

## MiniMax H3

官方公开资料当前说明：

- H3 支持文本、图像、视频、音频多模态上下文；
- 输出可带原生立体声音频；
- 输出最长 15 秒；
- Prompt Skill 明确定义 T2VA / I2VA / FL2VA / L2VA / Ref2VA；
- FL2VA 支持无图、单首帧、单尾帧或首尾帧；
- Ref2VA 支持混合多模态参考。

参考：
- https://github.com/MiniMax-AI/MiniMax-H3
- https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing

## RunningHub

当前采用 **AI App API 路径**，而非 Model API。

已确认：

- 用户自己的 RunningHub H3 AI App 可通过个人账户 API Key 调用；
- 用户现有调用入口：
  `https://www.runninghub.cn/openapi/v2/run/ai-app/2089265538441764866`
- API Key 通过 `RUNNINGHUB_API_KEY` 环境变量配置；
- RunningHub AI App / Workflow API 支持消费级-会员 API Key；
- 调用仍是任务型流程：提交 → taskId → 查询 → 结果；
- `HM-RunningHub/OpenClaw_RH_Skills` 已提供 AI App 上传、节点修改、提交、轮询、下载的参考实现。

参考：
- https://github.com/HM-RunningHub/OpenClaw_RH_Skills
- https://www.runninghub.cn/runninghub-api-doc-cn/
- https://www.runninghub.cn/runninghub-api-doc-cn/api-425749010

---

## 实现前必须遵守的边界

```text
Entity ≠ MediaAsset
MediaAsset ≠ ReferenceBinding
VisualContinuity ≠ NarrativeState
H3 theoretical mode ≠ Provider executable mode
RenderRequest ≠ RunningHub node schema
Browser media URL ≠ filesystem path
```

---

# 56. 最终产品定义

这不是：

```text
H3 Prompt 编辑器
RunningHub API 客户端
AI 自动短剧生成器
```

而是：

> **一个本地保存创作事实、以 Shot 为核心、允许人工 / 外部 AI / 内置 AI 三种导演方式，并将 RunningHub 当作可替换渲染后端的 MiniMax H3 Director Workstation。**

核心闭环：

```text
Story / Brief
↓
Shot Plan
↓
Asset Requirements
↓
DirectorPlan
↓
References
↓
H3 Mode
↓
Prompt
↓
Preflight
↓
RunningHub Render
↓
Take
↓
Review / Select
↓
Actual Continuity
↓
Next Shot
↓
Timeline
↓
Export
```


---

## v0.4 技术架构冻结

本版正式确认：

```text
Vue 3 + TypeScript
        ↓
localhost HTTP / SSE
        ↓
Node.js + TypeScript
├─ SQLite
├─ Filesystem
├─ FFmpeg
├─ RunningHub AI App
├─ RenderQueue
└─ Optional AI
```

**Electron / Tauri / Rust 不进入 v0.1 必选技术栈。**

后续实现不得因为“这是本地工作台”而默认引入桌面壳。
