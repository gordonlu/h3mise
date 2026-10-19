# H3Mise Studio Canvas — 需求与技术实现指南（PRD + Tech Spec）

> 状态：v1（待评审）· UI 设计稿：[01-ui-design.md](01-ui-design.md)
>
> 读者：实现者（含 GPT / DeepSeek 等编码模型）、评审者。本文件是**派活依据**：§16 的每个工作包（WP）都可以单独交给一个模型完成并单独提 PR。
>
> 开工前必读：仓库根目录 [`AGENTS.md`](../../AGENTS.md)（付费安全、Shot/Take 不变量、幂等规则）。本文档与 AGENTS.md 冲突时，以 AGENTS.md 为准。

---

## 1. 背景

H3Mise 当前的制作链路分散在 8 个页面：故事与节拍、Storyboard、镜头列表、导演台、素材库、参考拉片、时间线、快速剪辑，再加上制作总览与渲染队列抽屉。用户需要在页面之间来回跳转才能理解"整部作品做到哪一步、哪一镜卡住、哪一镜依赖哪一镜"。

MiniMax Design 的 Canvas Flow 与 ComfyUI 证明了**节点画布**适合表达多阶段、多模态、有依赖的生产流程。本需求在 H3Mise 中引入一个统一的 **Studio** 工作区：一张画布 + 左侧资源 Dock + 右侧 Inspector + 底部时间线/队列 Dock。

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 衡量 |
| --- | --- | --- |
| G1 | 一屏看清整集制作状态 | 打开 Studio 后无需滚动/跳页即可看到所有 Beat、Shot、Take 状态（≤ 30 个镜头时） |
| G2 | 主链路一屏完成 | Mock 下从 Demo 到导出，全程不离开 `/studio`（设置页除外） |
| G3 | 连续性关系可视化 | 帧链（previous_take）、角色资产绑定可以通过拖线建立和查看 |
| G4 | 零新增付费风险 | 所有付费动作经统一确认；自动化测试证明连线/布局操作不会提交渲染 |
| G5 | 不破坏现有能力 | 旧页面在过渡期全部可用；现有 `pnpm test` 全绿 |

### 2.2 非目标

- **不做** ComfyUI 式"可执行图"：画布不是程序，不存在"整图提交"。
- **不做**任意自定义节点/插件系统。
- **不替代** ComfyUI Provider 的 workflow 编辑（ComfyUI 工作流仍在 ComfyUI 中编辑，按 `ComfyUI.md` 导入）。
- **不做**多人实时协同。
- **不改变**任何领域不变量：Shot/Take 分离、Preflight、活动任务锁、参考上限、Provider 能力检查、Beat 原子应用与幂等。
- **不在**本期重做时间线精剪（底部 Dock 只做迷你时间线；精修跳转原页面）。

## 3. 核心设计决策（必须遵守）

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **画布 = 领域模型的投影（projection）**。节点和连线由服务端从现有表实时推导，画布只持久化布局（位置/折叠/视口/便签/框）。 | 避免第二数据源；删除布局不丢数据；Agent/MCP/旧页面修改的数据自动出现在画布上。 |
| D2 | **连线 = 命令**。用户拖线后调用服务端 `canvas` 命令分发器，分发器调用**现有模块函数**完成领域修改。 | 校验与原子性集中在服务端；规则表在 `shared` 中供前后端共用。 |
| D3 | **执行永远显式**。没有任何画布事件（连线、移动、改参数）会触发渲染或付费生图。 | AGENTS.md 渲染安全规则。 |
| D4 | **付费动作只走现有接口**：`POST /api/render`、`POST /api/storyboard/:id/generate`、`.../regenerate`、`POST /api/auto-produce/start`、`POST /api/render/:id/retry`（无任务 ID 时会新建付费任务）。前端新增统一 `PaidActionDialog`，不新增任何付费后端路径。 | 不复制、不绕过 Preflight 与 renderGate。 |
| D5 | **一集一张画布**，作用域与现有 `activeEpisodeId`（`story.id`）一致。 | 与 Shot/Beat/Storyboard/Timeline 的 episode 作用域一致。 |
| D6 | **前端使用 Vue Flow**（`@vue-flow/core` 1.48.x，MIT）。 | 项目是 Vue 3；Vue Flow 是 React Flow 的 Vue 对应实现，内置缩放/平移/小地图/自定义节点，支持 `onlyRenderVisibleElements`。 |
| D7 | **默认确定性泳道布局**（自研，纯函数，放在 `shared`），可选 `@dagrejs/dagre`（MIT）做自由整理。不引入 elkjs（EPL-2.0）。 | 我们的图天然分层（按阶段），自研泳道布局可测试、可复现。 |
| D8 | 旧页面保留，Studio 通过新路由 `/studio` 进入，复用（抽取后的）现有组件。 | 渐进迁移，降低回归风险。 |

## 4. 用户故事与验收标准

> 优先级：P0 = MVP 必须；P1 = 第二阶段；P2 = 之后。

### P0

| ID | 用户故事 | 验收标准 |
| --- | --- | --- |
| US-01 | 作为用户，我打开 Studio 就能看到当前集的故事、节拍、镜头、Takes、时间线节点，按泳道排好。 | 安装 Good Boy Demo 后打开 `/studio`：出现 1 个 Story、3 个 Beat、3 个 Shot、3 个 Takes 节点、1 个 Timeline、1 个 Export 节点；Beat→Shot 连线 3 根；位置符合泳道布局；刷新页面后位置不变。 |
| US-02 | 我拖动节点后布局被保存。 | 拖动后 ≤ 1s 内持久化；刷新、重启服务后位置保持；切换项目/集后各自保存。 |
| US-03 | 我选中节点，在右侧 Inspector 编辑。 | 选中 Shot 显示导演台全部标签（复用现有组件），保存后画布节点徽章同步更新；选中 Beat/Story 可编辑字段并保存。 |
| US-04 | 我能通过拖线把 Beat 挂到 Shot。 | 合法时 Shot.storyBeatId 更新、连线出现；已有归属时弹出替换确认；非法连线（如 Beat→Timeline）无法落下并显示原因。 |
| US-05 | 我能通过拖线把图片/实体绑定为镜头参考或首帧。 | 实体（人物）→ Shot.cast 设置 primaryCharacterId；图片 → refs 弹角色选择并创建 ReferenceBinding；图片 → first_frame 创建 `first_frame` 角色绑定；参考超过 Provider 上限时拒绝并提示。 |
| US-06 | 我能用拖线建立帧链。 | Shot A.tail_frame → Shot B.first_frame 将 B 设为 `renderDependencyMode=previous_take, dependsOnShotId=A`；成环被拒绝；断开后恢复为 `auto`。 |
| US-07 | 我能在节点上执行免费动作。 | AI 规划 / 编译 Prompt / 预检 / 补齐 Shot / 快速组装 可在节点或右键菜单触发；Agent 接管时 AI 动作显示 🤖 挂起角标。 |
| US-08 | 我能在节点上执行渲染，但必须先确认。 | 点击渲染 → `PaidActionDialog` 显示 Provider、模式、时长、画幅、MP、参考、预检结果、预估费用；取消不发请求；确认后调用 `POST /api/render`；Mock 同样显示摘要。 |
| US-09 | 渲染进度与结果实时反映在画布上。 | SSE `render.job.*` 到达后 ≤ 500ms 节点状态更新；成功后 Takes 节点出现新缩略；失败显示错误阶段与任务 ID。 |
| US-10 | 我能在 Takes 节点选片并送入时间线。 | 选择/拒绝/选择并提交连续性可用；Takes.selected → Timeline 连线创建 TimelineClip；非 selected Take 无输出端口。 |
| US-11 | 底部 Dock 显示迷你时间线和队列。 | 时间线显示片段顺序与缺失占位；`快速组装`/`导出` 可用；队列显示本项目任务，点击定位节点。 |
| US-12 | 旧页面仍然可用。 | 所有现有路由可访问；`pnpm test`、`pnpm build`、`pnpm typecheck` 通过。 |

### P1

| ID | 用户故事 | 验收标准 |
| --- | --- | --- |
| US-13 | 语义缩放 | 三档 LOD 按 §5.5（设计稿）切换，60 个节点下平移/缩放 ≥ 50fps（M1 / 中端 Windows 笔记本，Chrome） |
| US-14 | 运行到此处 | 计算帧依赖链上游未完成镜头并高亮编号；"免费准备全部"调用 batch prepare；渲染确认框列出全部镜头；只提交当前可渲染的镜头 |
| US-15 | 一键制作计划可视化 | 计划卡 + 节点编号 + 将新建镜头以幽灵节点显示；阻塞项可定位 |
| US-16 | Storyboard 页节点 | 准备/生成¥/单格重生¥/批准 全部可在节点完成，付费动作经 `PaidActionDialog` |
| US-17 | 节点库与资产 Dock 拖入创建 | 拖入"新镜头"在落点所在 Beat 行创建并归属；拖入本地文件导入媒体；拖到端口上导入并绑定 |
| US-18 | 大纲树 + ⌘K 定位 | 大纲与画布双向同步；⌘K 输入 S03/人物名可定位 |
| US-19 | 问题 Dock | 展示 ProductionOverview issues，点击定位并打开 Inspector 对应标签 |
| US-20 | 便签与框 | 创建/编辑/删除，只存布局表，不影响领域数据 |
| US-21 | 领域操作撤销 toast | 连线/断开类操作 5 秒内可撤销（执行反向命令） |
| US-22 | AppSidebar 自动收起、Studio 入口 | 侧栏出现"制作台 Studio"首项；进入 Studio 时侧栏收为图标栏 |

### P2

- 已实现（2026-10）：复制镜头（⌘D）、键盘连线、Studio 默认首页、系列总览画布（`/studio/series`）、参考拆解节点（保存的拆解投影为 `reference` 泳道节点）、MCP 暴露画布图（`get_canvas_graph` 只读工具）。
- 仍待实现：无（P2 清单完成）。

## 5. 范围分期

| 阶段 | 内容 | 对应 WP |
| --- | --- | --- |
| Phase 0 基础 | 共享类型、规则表、泳道布局纯函数、迁移、布局 API、图投影 API | WP-01 ~ WP-04 |
| Phase 1 只读画布 | Studio 路由、Vue Flow 外壳、全部节点只读渲染、布局保存、SSE 刷新、Inspector 只读 | WP-05 ~ WP-07 |
| Phase 2 编辑 | 组件抽取（ShotWorkbench 等）、Inspector 可编辑、连线命令、节点动作、PaidActionDialog、底部 Dock | WP-08 ~ WP-12 |
| Phase 3 体验 | LOD、运行到此处、一键制作可视化、Storyboard 节点、节点库/资产拖入、大纲/⌘K、问题 Dock、便签框、撤销 toast | WP-13 ~ WP-18 |
| Phase 4 收尾 | i18n、文档（README/AGENTS.md）、手工 QA、性能调优、侧栏入口 | WP-19 ~ WP-20 |

P0 = Phase 0–2 全部；P1 = Phase 3–4。

## 6. 架构总览

```text
┌────────────────────────────── web ──────────────────────────────┐
│ StudioPage.vue                                                   │
│  ├─ StudioTopBar  ├─ LeftDock(节点/资产/大纲)  ├─ Inspector       │
│  ├─ StudioCanvas (Vue Flow)                    └─ BottomDock      │
│  │    ├─ nodes/*.vue  edges/*.vue  ConnectionLine                 │
│  │    └─ useConnectionRules ← shared/canvas-rules.ts              │
│  ├─ stores/studio.ts (Pinia：graph、layout、selection、lod)        │
│  └─ composables: useGraphSync(SSE) useLayoutPersist useNodeActions│
│                  usePaidAction(PaidActionDialog)                  │
└──────────────┬──────────────────────────────────────▲────────────┘
     GET graph │ PUT layout  POST/DELETE connections  │ SSE /api/events
               ▼                                      │
┌────────────────────────────── server ───────────────┴────────────┐
│ routes.ts  →  modules/canvas.ts                                   │
│   ├─ buildCanvasGraph(ctx)        ← 读 story/beats/shots/takes/…   │
│   ├─ get/saveLayout(ctx, …)       ← canvas_* 表（迁移 v22）         │
│   └─ connect/disconnect(ctx, …)   → 调用 shots/assets/timeline 模块│
│ 现有模块不变：shots.ts assets.ts timeline.ts story-pipeline.ts …   │
│ 付费路径不变：POST /api/render, storyboard generate, auto-produce  │
└───────────────────────────────────────────────────────────────────┘
shared/src/canvas.ts        类型
shared/src/canvas-rules.ts  端口类型、连线规则（纯函数，前后端共用）
shared/src/canvas-layout.ts 泳道布局（纯函数）
```

数据流：

1. 进入 `/studio` → `GET /api/canvas/graph`（含 ETag）+ `GET /api/canvas/layout`。
2. 前端把 graph 节点与 layout 合并；无布局的节点用 `laneLayout()` 计算位置（不立即写回，用户移动后才写回 → 避免把自动位置固化成 pinned）。
3. 用户操作：
   - 移动/折叠 → 防抖 400ms `PUT /api/canvas/layout`。
   - 连线 → `POST /api/canvas/connections` → 成功返回受影响节点 id，前端重新拉取 graph（带 ETag）。
   - 节点动作 → 直接调用现有业务 API（如 `/api/shots/:id/prompts/compile`）。
4. SSE 事件 → 局部即时补丁（渲染进度）+ 防抖 300ms 重新拉取 graph。

## 7. 共享类型（`shared/src/canvas.ts`）

> 以下为规范定义，实现时可补充字段但不得改名。需在 `shared/src/index.ts` 导出。

```ts
import type { ShotStatus, ShotUserStatus, ShotRenderDependencyMode } from './shots.js';
import type { H3Mode } from './director.js';
import type { EntityKind, MediaKind, ReferenceRole } from './assets.js';
import type { StoryboardStatus } from './storyboard.js';
import type { TakeStatus } from './render.js';

export type CanvasNodeKind =
  | 'story' | 'beat' | 'sequence' | 'storyboard'
  | 'entity' | 'character_state' | 'media'
  | 'shot' | 'takes' | 'timeline' | 'export'
  | 'note' | 'frame';

export type CanvasPortType =
  | 'TEXT' | 'BEAT' | 'ENTITY' | 'IMAGE' | 'FRAME' | 'VIDEO' | 'AUDIO' | 'TAKE' | 'CLIP';

/** Stable node id: `${kind}:${domainId}` (e.g. `shot:shot-002`, `takes:shot-002`). */
export type CanvasNodeId = string;

export type CanvasPortId =
  | 'beats' | 'story' | 'beat'
  | 'entity' | 'image' | 'video' | 'audio'
  | 'cast' | 'first_frame' | 'last_frame' | 'refs' | 'video_ref' | 'audio_ref'
  | 'takes' | 'tail_frame' | 'selected' | 'clips' | 'timeline'
  | `panel:${string}`;

export interface CanvasPort {
  id: CanvasPortId;
  type: CanvasPortType;
  direction: 'in' | 'out';
  label: string;
  multiple: boolean;          // accepts/produces more than one edge
  visible: boolean;           // e.g. last_frame hidden unless mode is fl2va/l2va
  userConnectable: boolean;   // false for derived-only ports (takes, story bus)
}

export interface CanvasBadge { kind: 'paid' | 'blocker' | 'warning' | 'agent' | 'waiting' | 'locked' | 'stale'; count?: number; text?: string }

export interface CanvasNodeBase<K extends CanvasNodeKind, D> {
  id: CanvasNodeId;
  kind: K;
  domainId: string;
  title: string;
  lane: CanvasLane;
  /** Narrative ordering key used by lane layout (beat order, shot order…). */
  rowKey: number;
  ports: CanvasPort[];
  badges: CanvasBadge[];
  /** Parent group (sequence frame) if any. */
  groupId?: CanvasNodeId | null;
  data: D;
}

export type CanvasLane = 'cast' | 'story' | 'beats' | 'storyboard' | 'shots' | 'takes' | 'edit' | 'free';

export interface ShotNodeData {
  order: number;
  status: ShotStatus;
  userStatus: ShotUserStatus;
  h3Mode: H3Mode | null;
  durationSeconds: number;
  aspectRatio: string;
  storyBeatId: string | null;
  primaryCharacterId: string | null;
  sceneId: string | null;
  renderDependencyMode: ShotRenderDependencyMode;
  dependsOnShotId: string | null;
  dependencyReady: boolean;
  castChips: Array<{ entityId: string; name: string; kind: EntityKind; imageAssetId: string | null }>;
  missingRequired: string[];
  coverPath: string | null;           // poster of selected/latest take
  previewTakeId: string | null;
  hasPlan: boolean;
  latestPromptVersionId: string | null;
  latestPreflight: { id: string; blocked: boolean; risk: string | null; stale: boolean } | null;
  activeJob: { id: string; status: string } | null;
  takeCount: number;
  candidateCount: number;
  selectedTakeId: string | null;
  guideSteps: Array<{ key: string; state: string }>;
  pendingAiRequestIds: string[];
}

export interface TakesNodeData {
  shotId: string;
  takes: Array<{ id: string; status: TakeStatus; posterPath: string | null; rating: number | null; failureTags: string[]; duration: number; createdAt: string }>;
}

export interface BeatNodeData { order: number; category: string; summary: string; durationSeconds: number; location?: string; timeOfDay?: string; weather?: string; shotIds: string[] }
export interface StoryNodeData { synopsis: string; plannedDurationSeconds: number; beatDurationSeconds: number; beatCount: number }
export interface StoryboardNodeData { pageNumber: number; totalPages: number; panelCount: 3 | 6 | 9; status: StoryboardStatus; sourceStartIndex: number; sourceEndIndex: number; panels: Array<{ id: string; order: number; description: string; assetId: string | null; version: number }>; activeJobId: string | null }
export interface EntityNodeData { entityKind: EntityKind; imageAssetId: string | null; stateCount: number; usageShotIds: string[] }
export interface CharacterStateNodeData { characterId: string; effectiveImageAssetId: string | null }
export interface MediaNodeData { mediaKind: MediaKind; posterPath: string | null; durationSeconds?: number; userPlaced: boolean }
export interface TimelineNodeData { clipCount: number; durationSeconds: number; clips: Array<{ id: string; order: number; shotId: string; takeId: string }> }
export interface ExportNodeData { latest: { relPath: string; durationSeconds: number | null; createdAt: string } | null; exportCount: number }
export interface AnnotationNodeData { text: string; color: string; width: number; height: number }

export type CanvasNode =
  | CanvasNodeBase<'story', StoryNodeData>
  | CanvasNodeBase<'beat', BeatNodeData>
  | CanvasNodeBase<'sequence', { order: number }>
  | CanvasNodeBase<'storyboard', StoryboardNodeData>
  | CanvasNodeBase<'entity', EntityNodeData>
  | CanvasNodeBase<'character_state', CharacterStateNodeData>
  | CanvasNodeBase<'media', MediaNodeData>
  | CanvasNodeBase<'shot', ShotNodeData>
  | CanvasNodeBase<'takes', TakesNodeData>
  | CanvasNodeBase<'timeline', TimelineNodeData>
  | CanvasNodeBase<'export', ExportNodeData>
  | CanvasNodeBase<'note' | 'frame', AnnotationNodeData>;

export type CanvasEdgeKind =
  | 'story_beat'        // derived
  | 'beat_shot'         // user: shot.storyBeatId
  | 'cast'              // user: shot.primaryCharacterId / sceneId
  | 'binding'           // user: reference_bindings row
  | 'frame_chain'       // user: shot.renderDependencyMode=previous_take
  | 'storyboard_panel'  // derived: binding created by storyboard approval
  | 'shot_takes'        // derived
  | 'take_clip'         // user: timeline_clips row
  | 'timeline_export'   // derived
  | 'continuity';       // derived

/** Stable edge id. binding:<bindingId> | beat_shot:<shotId> | cast:<shotId>:<entityId> |
 * frame_chain:<shotId> | take_clip:<clipId> | shot_takes:<shotId> | … */
export interface CanvasEdge {
  id: string;
  kind: CanvasEdgeKind;
  source: CanvasNodeId;
  sourcePort: CanvasPortId;
  target: CanvasNodeId;
  targetPort: CanvasPortId;
  derived: boolean;           // true → cannot be deleted by user
  /** Hidden by default; shown when an endpoint is selected (see design §7.5). */
  focusOnly: boolean;
  data?: { roles?: ReferenceRole[]; bindingId?: string; clipId?: string; order?: number };
}

export interface CanvasGraph {
  projectId: string;
  storyId: string;            // episode id
  revision: string;           // content hash, also returned as ETag
  generatedAt: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasNodeLayout {
  nodeId: CanvasNodeId;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  collapsed: boolean;
  pinned: boolean;            // user moved it; auto-layout must not move it
  userPlaced: boolean;        // for media nodes: keep visible even if unbound
}

export interface CanvasViewState {
  viewport: { x: number; y: number; zoom: number };
  layoutMode: 'lanes' | 'free';
  edgeVisibility: 'default' | 'all';
  hiddenLanes: CanvasLane[];
}

export interface CanvasLayoutDoc {
  storyId: string;
  nodes: CanvasNodeLayout[];
  view: CanvasViewState;
  annotations: Array<{ id: string; kind: 'note' | 'frame'; x: number; y: number; width: number; height: number; text: string; color: string }>;
  updatedAt: string;
}

export interface CanvasConnectRequest {
  storyId: string;
  source: { nodeId: CanvasNodeId; port: CanvasPortId };
  target: { nodeId: CanvasNodeId; port: CanvasPortId };
  options?: {
    roles?: ReferenceRole[];
    preserve?: string[];
    ignore?: string[];
    /** Required to overwrite an existing single-valued link (beat, primary character, first frame…). */
    replace?: boolean;
    /** Allow switching the target shot's h3Mode when the port requires it (e.g. refs on t2va → ref2va). */
    switchMode?: H3Mode;
  };
}

export interface CanvasConnectResult {
  ok: true;
  edgeId: string;
  affectedNodeIds: CanvasNodeId[];
  /** Inverse command for the undo toast (design §10.6). */
  undo: { method: 'DELETE'; edgeId: string } | { method: 'POST'; request: CanvasConnectRequest } | null;
}

export type CanvasConnectErrorCode =
  | 'invalid_connection'   // rule table says no
  | 'needs_replace'        // single-valued target already linked; resend with replace:true
  | 'needs_mode_switch'    // port not accepted by current mode; resend with switchMode
  | 'cycle'                // frame chain would form a cycle
  | 'reference_limit'      // provider reference limit exceeded
  | 'locked'               // shot is LOCKED / rendering
  | 'not_found'
  | 'stale_episode';       // storyId is not the active episode
```

## 8. 连线规则表（`shared/src/canvas-rules.ts`）

规则表是**单一事实来源**：前端用它决定拖线时哪些端口可落；服务端用它做第一道校验，再做领域级深度校验（成环、上限、锁定）。

```ts
export interface CanvasConnectionRule {
  sourceKind: CanvasNodeKind;
  sourcePort: CanvasPortId;
  targetKind: CanvasNodeKind;
  targetPort: CanvasPortId;
  /** Optional predicate on source node data (e.g. entityKind). Pure, no I/O. */
  when?: (source: CanvasNode, target: CanvasNode) => true | string; // string = reason
  effect: CanvasConnectEffect;
  needsRolePicker?: boolean;
}

export type CanvasConnectEffect =
  | 'set_shot_beat'
  | 'set_shot_primary_character'
  | 'set_shot_scene'
  | 'create_binding'
  | 'create_first_frame_binding'
  | 'create_last_frame_binding'
  | 'set_frame_chain'
  | 'add_timeline_clip';

export function canConnect(source: CanvasNode, sourcePort: CanvasPortId, target: CanvasNode, targetPort: CanvasPortId):
  { ok: true; rule: CanvasConnectionRule } | { ok: false; reason: string };
```

| # | source.kind.port | target.kind.port | when（纯函数前置条件） | effect | 服务端执行（调用现有模块） | 单值冲突 |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | beat.beat | shot.beat | 同一集 | set_shot_beat | `shotsMod.updateShot(ctx, id, { storyBeatId })` | 已有 beat → `needs_replace` |
| R2 | entity.entity | shot.cast | entityKind ∈ {character, creature} | set_shot_primary_character | `updateShot({ primaryCharacterId })`；随后 `assetsMod.ensureShotEntityImageBindings` | 已有主角色 → `needs_replace` |
| R3 | entity.entity | shot.cast | entityKind = scene | set_shot_scene | `updateShot({ sceneId })` + ensure bindings | 已有场景 → `needs_replace` |
| R4 | entity.entity | shot.refs | entityKind ∈ {prop, vehicle}，且实体有主图 | create_binding | `assetsMod.createBinding({ assetId: entity.imageAssetId, shotId, roles, sourceEntityId })` | — |
| R5 | character_state.image | shot.refs | 有 effectiveImageAssetId | create_binding | `createBinding({ assetId: effectiveImageAssetId, roles: options.roles ?? ['identity','costume'] })` | — |
| R6 | character_state.image | shot.first_frame | 同上 | create_first_frame_binding | `createBinding({ roles: ['first_frame'] })` | 已有首帧绑定 → `needs_replace`（replace 时删除旧绑定） |
| R7 | media.image | shot.refs | mediaKind=image | create_binding | `createBinding({ roles })`，roles 必填 | — |
| R8 | media.image | shot.first_frame | mediaKind=image | create_first_frame_binding | 同 R6 | 同 R6 |
| R9 | media.image | shot.last_frame | mediaKind=image；目标模式 ∈ {fl2va, l2va} | create_last_frame_binding | `createBinding({ roles: ['last_frame'] })` | 已有尾帧 → `needs_replace` |
| R10 | media.video | shot.video_ref | mediaKind=video | create_binding | `createBinding({ roles: options.roles ?? ['motion'] })`；目标非 vref2va → `needs_mode_switch` | — |
| R11 | media.audio | shot.audio_ref | mediaKind=audio | create_binding | `createBinding({ roles: ['audio'] })` | — |
| R12 | shot.tail_frame | shot.first_frame | source ≠ target；不成环 | set_frame_chain | `updateShot(target, { renderDependencyMode: 'previous_take', dependsOnShotId: source })` | 目标已有首帧绑定或其他依赖 → `needs_replace` |
| R13 | takes.selected | timeline.clips | take.status = selected | add_timeline_clip | `timelineMod.addClip({ shotId, takeId })`（该函数已拒绝非 selected Take） | — |

服务端在规则表之后必须做的深度校验：

- **成环**（R12）：沿 `dependsOnShotId` 从 source 回溯，若遇到 target 则 `cycle`。
- **参考上限**：上限来自当前项目默认 Provider 的能力（`caps.maxImageRefs` / `maxVideoRefs` / `maxAudioRefs`，以及工作流槽位限制），目前在 `server/src/modules/preflight.ts` 的参考检查段（`ref.image.limit`、`ref.count.*`）中内联计算。把这段计数逻辑抽成导出函数（例如 `referenceLimitViolations(ctx, providers, shot, extraBinding)`），Preflight 与连线分发器共同调用，不得复制常量。超限 → `reference_limit`。
- **锁定**：目标 Shot 状态为 `LOCKED` 或有活动渲染任务时，任何会改变渲染意图的连线 → `locked`。
- **模式**：端口与当前 `h3Mode` 不兼容时返回 `needs_mode_switch` 及建议模式；前端确认后带 `switchMode` 重发，服务端在**同一事务**内先改模式再建绑定。
- **作用域**：`storyId` 必须等于当前 `activeEpisodeId`，否则 `stale_episode`（409）。

断开（`DELETE /api/canvas/connections/:edgeId`）的反向操作：

| edge.kind | 反向操作 |
| --- | --- |
| beat_shot | `updateShot({ storyBeatId: null })` |
| cast | 对应字段置 null（主图自动绑定是否移除，沿用 `ensureShotEntityImageBindings` 现有语义，不另写逻辑） |
| binding | `assetsMod.deleteBinding(id)`（使用现有删除路由背后的函数） |
| frame_chain | `updateShot({ renderDependencyMode: 'auto', dependsOnShotId: null })` |
| take_clip | `timelineMod.removeClip(id)` |
| 其他（derived） | 422 `invalid_connection`："派生连线不可断开" |

## 9. 数据库迁移（项目库 v22 `canvas-layouts`）

追加到 `server/src/db/schema.ts` 的 `PROJECT_MIGRATIONS`，版本号取当前最大值 + 1（当前为 21 → 22；实现时以仓库实际最大值为准）。

```sql
CREATE TABLE IF NOT EXISTS canvas_node_layouts (
  story_id    TEXT NOT NULL REFERENCES story(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  width       REAL,
  height      REAL,
  collapsed   INTEGER NOT NULL DEFAULT 0,
  pinned      INTEGER NOT NULL DEFAULT 0,
  user_placed INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (story_id, node_id)
);

CREATE TABLE IF NOT EXISTS canvas_views (
  story_id   TEXT PRIMARY KEY REFERENCES story(id) ON DELETE CASCADE,
  view_json  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canvas_annotations (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES story(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('note', 'frame')),
  x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_annotations_story ON canvas_annotations(story_id);
```

规则：

- 布局行对应的领域对象被删除后，布局行成为孤儿：`GET /api/canvas/layout` 时与 graph 节点集合比对，**惰性清理**孤儿行（`user_placed=1` 的 media 节点：媒体仍存在则保留）。
- 注释 id 使用 `server/src/db/ids.ts` 的 `nextId(db, 'note')`。
- Demo 安装、项目导出/导入：布局属于项目库，自然随项目复制；Demo 无布局时走泳道布局。
- 迁移需通过现有 migrate 测试模式（新库全量迁移 + 旧库增量迁移各一次）。

## 10. API 设计

所有路由放在 `server/src/http/routes.ts`，业务逻辑放在新模块 `server/src/modules/canvas.ts`。修改类路由自动受现有 `sessionGuard` 保护（需要 `h3mise_session` cookie）。

### 10.1 `GET /api/canvas/graph`

- Query：`storyId?`（默认当前 activeEpisodeId；不等于当前时 409 `stale_episode`）
- Header：支持 `If-None-Match: <revision>` → 304
- 200：`CanvasGraph`，`ETag: "<revision>"`
- revision：对 `nodes`/`edges` 的规范化 JSON 做 sha1（`node:crypto`），不含 `generatedAt`。

### 10.2 `GET /api/canvas/layout` · `PUT /api/canvas/layout`

- GET → `CanvasLayoutDoc`（顺带惰性清理孤儿）
- PUT body：

```json
{
  "storyId": "story-001",
  "nodes": [{ "nodeId": "shot:shot-002", "x": 1280, "y": 340, "collapsed": false, "pinned": true, "userPlaced": false }],
  "removeNodeIds": ["media:media-009"],
  "view": { "viewport": { "x": 0, "y": 0, "zoom": 0.8 }, "layoutMode": "lanes", "edgeVisibility": "default", "hiddenLanes": [] }
}
```

- 语义：按节点 upsert，**逐节点 last-write-wins**（布局无需乐观锁）；`view` 可选；单次最多 500 个节点（超出 413）。
- 不发 SSE（布局是本地视图状态，多标签页之间不必实时同步）。
- `POST /api/canvas/layout/reset`：删除该集全部 `canvas_node_layouts`（保留注释），用于"重置为泳道布局"。

### 10.3 注释

- `POST /api/canvas/annotations` → 201 新注释
- `PATCH /api/canvas/annotations/:id`
- `DELETE /api/canvas/annotations/:id`

### 10.4 `POST /api/canvas/connections`

- body：`CanvasConnectRequest`
- 201：`CanvasConnectResult`
- 409：`{ code: 'needs_replace', existing: { edgeId, label } }` / `{ code: 'needs_mode_switch', suggestedMode }` / `{ code: 'cycle' }` / `{ code: 'locked' }` / `{ code: 'stale_episode' }`
- 422：`{ code: 'invalid_connection' | 'reference_limit', error }`
- 执行完成后 `services.bus.emit({ type: 'project.updated' })`（若修改了 Shot 再发 `shot.updated`），以便其他标签页与旧页面刷新。
- 整个命令在 `ctx.db.tx()` 内执行（replace = 删旧 + 建新必须原子）。
- 使用与 render 相同模式的按 Shot 串行锁（`mutex.ts` 的 `createKeyedMutex()`，参照 `routes.ts` 中 `renderGate` 的用法），键 `canvas:${projectId}:${shotId}`，避免双击产生两条绑定。

### 10.5 `DELETE /api/canvas/connections/:edgeId`

- Query：`storyId`
- 200：`{ ok: true, affectedNodeIds, undo: { method: 'POST', request } | null }`
- derived edge → 422

### 10.6 复用的现有接口（前端节点动作直接调用，不新增后端）

| 节点动作 | 现有接口 | 付费 |
| --- | --- | --- |
| Story：AI 拆 Beats | `POST /api/ai/actions/story_to_beats`（Agent 接管时自动 202 deferred） | 否 |
| Story：推荐/套用骨架 | `POST /api/story/skeletons/recommend`、`POST /api/story/skeletons/:id/apply` | 否 |
| Story/Beat 编辑 | `PATCH /api/story`、`PATCH /api/story/beats/:id`、`POST /api/story/beats/reorder` | 否 |
| Beat：补齐 Shot | `POST /api/story/beats/materialize-shots` | 否 |
| Storyboard：准备 / 编辑格 / 批准 | `POST /api/storyboard/prepare`、`PATCH /api/storyboard/panels/:id`、`POST /api/storyboard/:id/approve` | 否 |
| Storyboard：生成整页 / 单格重生 | `POST /api/storyboard/:id/generate`、`POST /api/storyboard/:id/panels/:panelId/regenerate` | **是** |
| Shot：创建/编辑/排序/删除 | `POST /api/shots`、`PATCH /api/shots/:id`、`POST /api/shots/reorder`、`DELETE /api/shots/:id` | 否 |
| Shot：AI 规划 | `POST /api/ai/actions/plan_shot` | 否 |
| Shot：编译 Prompt | `POST /api/shots/:id/prompts/compile` | 否 |
| Shot：预检 | `POST /api/shots/:id/preflight` | 否 |
| Shot：解析首帧依赖 | `POST /api/shots/:id/render-dependency/resolve` | 否 |
| Shot：渲染 | `POST /api/render` | **是** |
| 队列：取消 | `POST /api/render/:id/cancel` | 否 |
| 队列：重试/对账 | `POST /api/render/:id/retry`（有 providerTaskId → 对账同一任务；无 → **新建付费任务**） | 无任务 ID 时**是** |
| Takes：选择/拒绝/选择并提交/评审/分析/导入 | `POST /api/takes/:id/select`、`.../reject`、`.../select-commit`、`PATCH /api/takes/:id`、`POST /api/takes/:id/analyze`、`POST /api/shots/:id/takes/import` | 否 |
| Takes：AI 诊断 | `POST /api/ai/actions/diagnose_take` | 否 |
| Timeline：快速组装 / 导出 | `POST /api/timeline/quick-build`、`POST /api/timeline/export` | 否（本地 FFmpeg） |
| 批量准备 | `GET /api/render/batch/plan`、`POST /api/render/batch/prepare` | 否 |
| 一键制作 | `GET /api/auto-produce/plan`、`POST /api/auto-produce/start`（真实 Provider 需 `confirmRealProvider: true`） | **是** |
| 问题 Dock | `GET /api/production` | 否 |
| 引导 | `GET /api/guide/project` | 否 |
| Agent 状态 | `GET /api/ai/agent`、`GET /api/ai/requests?status=pending` | 否 |

## 11. 图投影算法（`buildCanvasGraph`）

位置：`server/src/modules/canvas.ts`。必须是**只读**、**确定性**（相同数据 → 相同输出与 revision）。

步骤：

1. `storyId = activeEpisodeId(ctx)`；读 Story（当前集）。
2. Beats：`storyMod.listBeats(ctx)` → beat 节点（rowKey = order）。
3. Sequences：`storyMod.listSequences(ctx)` → sequence 组节点；beat/shot 的 `groupId` 指向所属 sequence。
4. Shots：`shotsMod.listShots(ctx)`。为避免 N+1，**用聚合 SQL 一次取齐**以下数据（参照 `GET /api/shots` 现有查询，但改为 `GROUP BY shot_id` 批量）：takes 计数/候选数/selected/最新海报、活动任务、最新 prompt 版本、最新 preflight（id、blocked、risk、created_at）、是否有 plan。
   - `rowKey`：若 storyBeatId 存在 → `beat.order * 1000 + shot.order`；否则 `999_000 + shot.order`。
   - `missingRequired`：`assetsMod.shotAssetRequirements(ctx, shot)` 中 level=required。
   - `dependencyReady`：`shotsMod.renderReadiness(ctx, shot).ready`。
   - `latestPreflight.stale`：最新 prompt 版本晚于最新 preflight。
   - 端口可见性：`last_frame` 仅 fl2va/l2va；`video_ref` 仅 vref2va；`refs` 对 t2va 也可见（落线时触发 `needs_mode_switch`）。
   - badges：`paid`（当前 Provider 非 mock 时）、`blocker`（missingRequired + preflight blocked + 依赖未就绪）、`agent`（pending ai_requests 中 shotId 匹配）、`waiting`、`locked`、`stale`。
5. Takes 节点：每个 Shot 一个 `takes:<shotId>`，包含该 Shot 全部 Take 摘要（按 createdAt 降序）。
6. Entities：`assetsMod.listEntities(ctx)` 全部（项目级）；`usageShotIds` 只统计本集 Shot。CharacterState 作为 `character_state` 节点，`groupId` = 所属 entity 节点（前端渲染为可展开子卡）。
7. Media：仅包括 (a) 被本集 Shot 的 binding 引用、且该 binding **不是**实体主图自动绑定（`sourceEntityId` 为空）的媒体；(b) 布局表中 `user_placed=1` 的媒体。
8. Reference breakdowns：`reference_breakdowns` 中已保存拆解的媒体 → `breakdown:<assetId>` 节点（`reference` 泳道），数据含段数、帧数、是否已 AI 分析与 revision；未分析时带 warning 角标。
9. Storyboards：`storyboardMod.listStoryboardPages(ctx)`（当前集）。
10. Timeline / Export：`timelineMod.getTimeline(ctx)`（已按集过滤）+ `listTimelineExports`。
11. Edges：

| edge | 来源 |
| --- | --- |
| story_beat | 每个 beat 一根（derived） |
| beat_shot | shot.storyBeatId |
| cast | shot.primaryCharacterId → `entity:<id>`；shot.sceneId → `entity:<id>`（focusOnly） |
| binding | 本集 Shot 的 reference_bindings；source 为 media/character_state/entity（按 `sourceEntityId` 与资产归属判断）；`first_frame`/`last_frame` 角色连到对应端口，其余连到 refs/video_ref/audio_ref（focusOnly） |
| storyboard_panel | 绑定的 assetId 属于某 storyboard panel 当前版本 → derived 虚线 |
| frame_chain | renderDependencyMode=previous_take 且 dependsOnShotId 非空 |
| shot_takes | 每个 Shot 一根 derived |
| take_clip | 每个 timeline clip 一根 |
| timeline_export | 1 根 derived |
| continuity | 相邻 Shot 且前者有 `continuity_entries(scope=visual, kind=actual)` → derived |

12. 注释节点（note/frame）**不在** graph 中返回，只在 layout 文档里（它们不是领域对象）。
13. 排序：nodes 按 (lane 顺序, rowKey, id) 排序；edges 按 id 排序 → revision 稳定。

性能预算：60 个 Shot、300 个 Take、50 个实体的项目，`buildCanvasGraph` ≤ 50ms（本地 SQLite）。在测试中断言查询次数不随 Shot 数线性增长（可通过包装 `ctx.db` 计数）。

## 12. 泳道布局（`shared/src/canvas-layout.ts`）

纯函数，前端调用；放 shared 便于在 `server/test` 中用 node:test 测试（web 目前没有测试框架，不为此引入）。

```ts
export interface LaneLayoutOptions {
  laneOrder: CanvasLane[];               // ['cast','story','beats','storyboard','shots','takes','edit']
  laneWidth: Record<CanvasLane, number>; // 例如 shots: 340
  laneGap: number;                       // 80
  rowGap: number;                        // 32
  nodeSize: (node: CanvasNode) => { width: number; height: number };
  hiddenLanes?: CanvasLane[];
}

/** Returns positions for nodes WITHOUT a pinned layout; pinned positions are passed through untouched. */
export function laneLayout(nodes: CanvasNode[], pinned: Map<CanvasNodeId, { x: number; y: number }>, opts: LaneLayoutOptions): Map<CanvasNodeId, { x: number; y: number }>;
```

算法要点：

1. 每条泳道 x = 前面所有可见泳道宽度 + gap 之和。
2. 行对齐：以 Beat 为行锚。Beat 的 y 由累计高度决定；挂在 Beat 下的 Shot 从该 Beat 的 y 开始向下堆叠；该行高度 = max(beat 高, 该 beat 下 shots 总高, 对应 storyboard 占用高)。Takes 节点 y 与其 Shot 相同。
3. 未归属 Shot 放在所有行之后。
4. `cast` 泳道独立纵向堆叠（实体按 kind、name 排序；CharacterState 子卡跟随实体，折叠时不占高度）。
5. `story` 节点 y = 0；`timeline` 节点 y = 0，`export` 在其下方。
6. 已 pinned 的节点保持原位，不参与避让（P1 可加简单的重叠检测提示，不自动推开）。
7. 输出必须确定性：相同输入同一结果（测试断言）。

## 13. 前端实现

### 13.1 依赖

```bash
pnpm --filter @h3mise/web add @vue-flow/core@^1.48 @vue-flow/background @vue-flow/minimap @vue-flow/controls @vue-flow/node-resizer
# 可选（P1 自由整理）：
pnpm --filter @h3mise/web add @dagrejs/dagre
```

- 在 `StudioPage.vue` 中按需引入 Vue Flow 样式（`@vue-flow/core/dist/style.css`、`theme-default.css`），再用 `studio.css` 覆盖为 H3Mise token。
- `/studio` 路由懒加载，不影响其他页面首屏体积。

### 13.2 目录结构

```text
web/src/
  pages/StudioPage.vue
  studio/
    StudioCanvas.vue            # <VueFlow> 配置、事件转发
    StudioTopBar.vue
    LeftDock.vue                # 标签：节点 / 资产 / 大纲
    dock/NodeLibrary.vue
    dock/AssetDock.vue
    dock/OutlineTree.vue
    inspector/Inspector.vue     # 根据选中节点 kind 分发
    inspector/StoryInspector.vue
    inspector/BeatInspector.vue
    inspector/ShotInspector.vue # 包装 ShotWorkbench
    inspector/TakesInspector.vue
    inspector/EntityInspector.vue
    inspector/MediaInspector.vue
    inspector/BreakdownInspector.vue
    inspector/StoryboardInspector.vue
    inspector/TimelineInspector.vue
    inspector/MultiInspector.vue
    inspector/EmptyInspector.vue
    bottom/BottomDock.vue
    bottom/MiniTimeline.vue
    bottom/QueuePanel.vue       # 可复用 RenderQueueDrawer 内部列表
    bottom/ProblemsPanel.vue
    bottom/AiRequestsPanel.vue
    bottom/ActivityLog.vue
    nodes/BaseNode.vue          # 头部色条、徽章、端口、底部状态、LOD 切换
    nodes/StoryNode.vue
    nodes/BeatNode.vue
    nodes/StoryboardNode.vue
    nodes/EntityNode.vue
    nodes/MediaNode.vue
    nodes/BreakdownNode.vue
    nodes/ShotNode.vue
    nodes/TakesNode.vue
    nodes/TimelineNode.vue
    nodes/ExportNode.vue
    nodes/NoteNode.vue
    nodes/FrameNode.vue
    nodes/PortHandle.vue        # <Handle> 包装：类型色、形状、兼容高亮
    edges/TypedEdge.vue         # 按 kind 着色/虚线/focusOnly 淡出
    overlays/RolePicker.vue
    overlays/QuickCreateMenu.vue
    overlays/ContextMenu.vue
    overlays/RunPlanCard.vue
    overlays/PaidActionDialog.vue
    composables/useGraphSync.ts
    composables/useLayoutPersist.ts
    composables/useConnect.ts
    composables/useNodeActions.ts
    composables/usePaidAction.ts
    composables/useLod.ts
    composables/useStudioShortcuts.ts
    studio.css
  stores/studio.ts
```

### 13.3 Pinia store（`stores/studio.ts`）

```ts
state: {
  graph: CanvasGraph | null;
  layout: CanvasLayoutDoc | null;
  selection: CanvasNodeId[];
  selectedEdgeId: string | null;
  lod: 'overview' | 'card' | 'detail';
  connecting: { nodeId: CanvasNodeId; port: CanvasPortId; type: CanvasPortType } | null;
  liveJobs: Record<string /*shotId*/, { jobId: string; status: RenderJobStatus }>; // SSE 即时补丁
  layoutUndo: LayoutPatch[]; layoutRedo: LayoutPatch[];
  docks: { left: number; right: number; bottom: number; leftTab: string; bottomTab: string };
}
getters: flowNodes, flowEdges (合并 graph + layout + laneLayout + liveJobs + focus 规则), selectedNode
actions: load(), refreshGraph() (ETag), moveNodes(), toggleCollapse(), select(), connect(), disconnect(), resetLayout()
```

- `flowNodes` 映射为 Vue Flow 的 `Node`：`{ id, type: node.kind, position, data: node, hidden: hiddenLanes.includes(node.lane) }`。
- Dock 尺寸存 `localStorage`（浏览器级偏好，不进项目库）。

### 13.4 Vue Flow 配置要点

```vue
<VueFlow
  :nodes="studio.flowNodes" :edges="studio.flowEdges"
  :node-types="nodeTypes" :edge-types="{ typed: TypedEdge }"
  :only-render-visible-elements="true"
  :min-zoom="0.15" :max-zoom="2"
  :snap-to-grid="snap" :snap-grid="[16, 16]"
  :is-valid-connection="isValidConnection"
  :connect-on-click="false"
  :delete-key-code="null"
  :zoom-on-double-click="false"
  @node-drag-stop="onDragStop"
  @connect-start="onConnectStart" @connect-end="onConnectEnd" @connect="onConnect"
  @node-click="onNodeClick" @node-double-click="onNodeDblClick"
  @pane-click="onPaneClick" @node-context-menu="onCtx" @edge-context-menu="onEdgeCtx" @pane-context-menu="onPaneCtx"
  @viewport-change-end="onViewport"
/>
```

- `delete-key-code="null"`：禁用 Vue Flow 默认删除，由 `useStudioShortcuts` 接管（删除领域对象必须确认）。
- `isValidConnection` 调用 `canConnect()`（shared 规则表），同时给 `PortHandle` 提供高亮数据。
- `@connect` 不直接把边加入本地状态；调用 `useConnect().connect()` → 服务端成功后 `refreshGraph()`。失败时 toast + 409 分支处理（`needs_replace` → confirmDialog → `replace: true` 重发；`needs_mode_switch` → confirmDialog → `switchMode` 重发；需要角色 → 先弹 `RolePicker`）。
- 拖到空白处（`connect-end` 且无目标）→ `QuickCreateMenu`。

### 13.5 LOD

- `useLod()` 监听 viewport.zoom，阈值 0.45 / 0.9，带 0.05 滞回避免抖动。
- `BaseNode` 根据 `lod` 渲染三种模板；Overview 不渲染 `<img>`/`<video>`，只渲染色块和序号。
- 缩略图使用 `/api/file/<posterPath>` 或 `/api/media/:id`，`loading="lazy"`、`decoding="async"`；悬停视频预览只在 Card/Detail 级、且鼠标停留 500ms 后创建 `<video muted>`，移出即销毁。

### 13.6 SSE 同步（`useGraphSync`）

| 事件 | 即时处理 | 是否触发 refreshGraph（防抖 300ms） |
| --- | --- | --- |
| `render.job.created/queued/running/updated` | `liveJobs[shotId] = status`，节点进度环 | 仅 created |
| `render.job.succeeded/failed` | 清除 liveJobs | 是 |
| `take.created/selected` | — | 是 |
| `shot.updated` | — | 是 |
| `continuity.committed` | — | 是 |
| `project.updated` | — | 是 |
| `auto.updated` | 更新 RunPlanCard | 是 |
| `job.updated` | 导出/分析进度 | done/failed 时是 |
| `ai.request.*` | 刷新 ai store | 是（更新 agent 角标） |

- 仅处理当前项目事件（`render.job.*` 带 `projectId`，与 `App.vue` 现有过滤一致）。
- `refreshGraph()` 使用 `If-None-Match`，304 时不改状态，避免无谓重渲染。
- 项目或集切换：`App.vue` 已按 `projectId:fullPath` 重挂载页面；Studio 额外在 `project.updated` 后校验 `graph.storyId` 是否等于当前集，不等则整体 reload。

### 13.7 布局持久化（`useLayoutPersist`）

- 拖动结束（`node-drag-stop`，含多选拖动）→ 记录 pinned=true → 合并入待发队列 → 400ms 防抖 PUT。
- `beforeunload` / 路由离开时立即 flush（`navigator.sendBeacon` 不支持自定义 cookie 以外的头，直接用 `fetch(..., { keepalive: true })`）。
- 自动布局计算出的位置**不写回**，除非用户点击"自动整理"（此时写回且 pinned=false）。
- 布局撤销栈只记录本地 LayoutPatch。

### 13.8 组件抽取（复用现有能力的关键）

| 抽取 | 来源 | 新组件 | 要求 |
| --- | --- | --- | --- |
| E1 | `pages/ShotPage.vue`（1116 行）中的状态与标签页编排 | `components/director/ShotWorkbench.vue`，props: `shotId`、`compact?: boolean` | ShotPage 改为薄包装 `<ShotWorkbench :shot-id>`，行为不变；Studio 的 ShotInspector 用 `compact` 模式（单列、标签页横向滚动）。渲染确认改为调用 `usePaidAction`（ShotPage 同步受益）。 |
| E2 | `pages/StoryPage.vue` 故事表单与 Beat 卡片 | `components/story/StoryFactsForm.vue`、`components/story/BeatEditor.vue` | StoryPage 复用之，行为不变 |
| E3 | `pages/AssetsPage.vue` 实体/媒体编辑 | `components/assets/EntityEditor.vue`、`components/assets/MediaDetail.vue` | 同上 |
| E4 | `pages/StoryboardPage.vue` 页编辑 | `components/storyboard/StoryboardPageEditor.vue` | 同上 |
| E5 | `components/RenderQueueDrawer.vue` 任务列表 | `components/render/RenderJobList.vue` | 抽屉与底部 Dock 共用 |
| E6 | `pages/ShotPage.vue` 渲染确认文案 | `studio/overlays/PaidActionDialog.vue` + `composables/usePaidAction.ts`（放 `web/src/composables/` 以便旧页面复用） | 见 §14 |

抽取原则：**先抽取并让旧页面使用新组件（无行为变化），再在 Studio 中使用**。每个抽取单独一个 PR，并人工对比旧页面行为。

### 13.9 路由与导航

- `router.ts` 新增 `{ path: '/studio', name: 'studio', component: () => import('./pages/StudioPage.vue') }`；`/` 重定向到 `/studio`（工作流模式为默认首页）。未打开项目时 Studio 显示冷启动卡，`/projects` 仍保留。
- `/studio/series` 提供系列总览（每集一个大节点），可切换当前剧集或新建剧集后返回 Studio。
- 支持深链：`/studio?node=shot:shot-002&tab=prompt` → 加载后定位并打开 Inspector 标签。
- `ProductionIssue.to`、`NextAction.to` 现有为旧页面路径；新增前端映射函数 `toStudioLink(to)`，在 Studio 内点击时转为节点定位（P1），不修改服务端返回值。
- `AppSidebar`：新增首项"制作台 Studio"；在 `/studio` 下侧栏收为 56px 图标栏（`App.vue` 的 grid 列宽根据路由切换）。Studio 页面不使用 `.page` 的 1440px 最大宽度与 padding（全屏画布）。

## 14. 付费安全硬性规范（逐条验收）

1. `PaidActionDialog` 是前端**唯一**允许调用以下接口的入口：`POST /api/render`、`POST /api/storyboard/:id/generate`、`POST /api/storyboard/:id/panels/:panelId/regenerate`、`POST /api/auto-produce/start`（非 mock）、`POST /api/render/:id/retry`（job 无 providerTaskId 时）。代码评审用 `rg` 检查这些路径只出现在 `usePaidAction.ts`（以及过渡期的旧页面，旧页面也应迁移到 usePaidAction）。
2. 对话框必须展示：Provider 名称与区域、Profile 验证状态、镜头/页、模式、时长、画幅、MP、参考摘要、预检结论、预估费用（有则显示，并标注"仅供参考"）、任务数量。
3. 确认按钮打开后 600ms 内禁用；提交中禁用；同一 shotId 在请求未返回前不可再次打开对话框（前端锁，服务端 renderGate 仍是最终保障）。
4. 默认 MP 为 `0.6`（顶栏选择器，可选 0.6/0.8/1.0/1.2，按原值传递，不做替换）。
5. Profile `unconfigured`/`failed` → 禁用确认并给出设置页链接；`nodes_detected` → 显示"首次真实提交"提示。
6. 已有活动任务或候选 Take（批量/一键制作场景）→ 不弹确认，改为阻塞提示并可定位。
7. 失败任务若有 providerTaskId，首选按钮为"对账"（retry 会对账同一任务）；无任务 ID 的"重试"视为新付费任务，走对话框。
8. 连线、断开、布局、Inspector 字段编辑、节点动作中的任何免费动作，**不得**间接调用上述付费接口。服务端测试覆盖（见 §17）。
9. 测试只用 Mock Provider；不得调用真实 RunningHub/ComfyUI。

## 15. i18n、主题、无障碍

- 新增 `web/src/i18n/studio.ts`，在 `i18n/index.ts` 合并（参照 `shot.ts`、`workflow.ts` 的做法），zh 完整，en/ja 至少覆盖顶栏、节点标题、对话框、错误码文案。
- `CanvasConnectErrorCode` → 文案映射在前端；服务端 `error` 字段仍给中文默认描述（与现有路由风格一致）。
- 所有颜色用 CSS 变量；在 `[data-theme='dark']` 下检查对比度（文本 ≥ 4.5:1）。
- 节点 `aria-label`、端口可聚焦；`prefers-reduced-motion` 关闭循环动画。

## 16. 工作包（派活清单）

> 约定：每个 WP 一个分支、一个 PR；分支名 `feat/studio-wpXX-<slug>`。"依赖"列中的 WP 合并后才能开始。"规模"为改动面大致描述，不代表时间。

| WP | 标题 | 依赖 | 主要文件 | 规模 | 建议执行模型 |
| --- | --- | --- | --- | --- | --- |
| WP-01 | 共享类型 + 规则表 + 泳道布局纯函数 | — | `shared/src/canvas.ts`、`canvas-rules.ts`、`canvas-layout.ts`、`index.ts`；`server/test/canvas-rules.test.ts`、`canvas-layout.test.ts` | 中，纯函数 | 任一（适合 DS） |
| WP-02 | 迁移 v22 + 布局/注释 API | WP-01 | `server/src/db/schema.ts`、`server/src/modules/canvas.ts`（layout 部分）、`routes.ts`；`server/test/canvas-layout-api.test.ts` | 中 | 任一 |
| WP-03 | 图投影 `GET /api/canvas/graph` | WP-01 | `server/src/modules/canvas.ts`（graph 部分）、`routes.ts`；`server/test/canvas-graph.test.ts` | 大，需读懂多个模块 | GPT |
| WP-04 | 连线命令分发器 | WP-01, WP-03 | `server/src/modules/canvas.ts`（connect 部分）、从 `preflight.ts` 抽出并导出参考上限函数；`server/test/canvas-connect.test.ts` | 大，领域校验多 | GPT |
| WP-05 | Studio 外壳 + Vue Flow + 只读节点 | WP-03 | `web/package.json`、`router.ts`、`pages/StudioPage.vue`、`studio/StudioCanvas.vue`、`nodes/*`（只读）、`edges/TypedEdge.vue`、`stores/studio.ts`、`studio.css`、`App.vue`（全屏布局） | 大，UI | GPT |
| WP-06 | 布局持久化 + SSE 同步 | WP-02, WP-05 | `composables/useLayoutPersist.ts`、`useGraphSync.ts` | 中 | 任一 |
| WP-07 | Inspector 框架 + 只读 Inspector | WP-05 | `studio/inspector/*`（只读版） | 中 | DS |
| WP-08 | 组件抽取 E1：ShotWorkbench | — | `pages/ShotPage.vue`、`components/director/ShotWorkbench.vue` | 大，回归风险高 | GPT |
| WP-09 | 组件抽取 E2–E5 | — | Story/Assets/Storyboard/Queue 组件 | 中 ×4（可拆 4 个 PR） | DS |
| WP-10 | PaidActionDialog + usePaidAction，并迁移 ShotPage 渲染确认 | WP-08 | `composables/usePaidAction.ts`、`studio/overlays/PaidActionDialog.vue`、`ShotWorkbench.vue` | 中，安全关键 | GPT |
| WP-11 | 可编辑 Inspector + 节点动作 + 连线交互（RolePicker、409 分支、QuickCreate） | WP-04, WP-07, WP-08, WP-09, WP-10 | `studio/inspector/*`、`composables/useConnect.ts`、`useNodeActions.ts`、`overlays/*`、`ContextMenu.vue` | 大 | GPT |
| WP-12 | 底部 Dock（迷你时间线、队列、问题、AI 请求、日志） | WP-05, WP-09 | `studio/bottom/*` | 中 | DS |
| WP-13 | LOD + 性能（onlyRenderVisibleElements、懒加载、悬停预览） | WP-05 | `useLod.ts`、`BaseNode.vue` | 中 | 任一 |
| WP-14 | 运行到此处 + 一键制作可视化（RunPlanCard、幽灵节点） | WP-10, WP-11 | `overlays/RunPlanCard.vue`、`useNodeActions.ts` | 中 | GPT |
| WP-15 | Storyboard 节点交互 | WP-10, WP-11 | `nodes/StoryboardNode.vue`、`inspector/StoryboardInspector.vue` | 中 | DS |
| WP-16 | 节点库 / 资产 Dock 拖入创建、文件拖入导入 | WP-11 | `dock/NodeLibrary.vue`、`dock/AssetDock.vue` | 中 | DS |
| WP-17 | 大纲树 + ⌘K 定位 + 深链 + 快捷键 | WP-05 | `dock/OutlineTree.vue`、`useStudioShortcuts.ts`、`CommandPalette.vue` | 中 | 任一 |
| WP-18 | 便签/框 + 撤销（布局撤销栈、领域撤销 toast） | WP-02, WP-11 | `nodes/NoteNode.vue`、`FrameNode.vue`、store | 中 | DS |
| WP-19 | i18n + 主题 + 无障碍检查 | WP-11 起 | `i18n/studio.ts` 等 | 中 | DS |
| WP-20 | 文档与入口：README（三语）、AGENTS.md「Studio」小节、侧栏入口、手工 QA 清单执行 | 全部 | `README*.md`、`AGENTS.md`、`AppSidebar.vue` | 小 | 任一 |

并行建议：WP-01 → (WP-02 ∥ WP-03) → WP-04；前端 WP-08、WP-09 不依赖后端，可从第一天并行；WP-05 在 WP-03 完成后开始。

### 16.1 每个 WP 的通用完成定义（DoD）

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过（新增测试同在 `server/test/*.test.ts`，使用 node:test + tsx，与现有测试一致）
- [ ] 前端改动的 WP：`pnpm --filter @h3mise/web build` 通过，并附 Good Boy Demo 下的截图/录屏
- [ ] 没有新增对付费接口的调用路径（WP-10 之外）
- [ ] 没有提交 `.env`、项目目录、`output/`、密钥
- [ ] 旧页面行为不变（抽取类 WP 需附对比说明）
- [ ] 新增用户可见文案走 i18n（WP-19 前可先用 zh 常量，但集中在 `i18n/studio.ts`）

### 16.2 各 WP 验收要点（摘要）

- **WP-01**：`canConnect` 对 §8 R1–R13 每条有正例与至少一个反例；`laneLayout` 对 Good Boy 形状数据输出确定、pinned 节点不被移动、隐藏泳道后 x 坐标收紧。
- **WP-02**：新库与旧库（v21）迁移均成功；PUT 后 GET 一致；孤儿行惰性清理；超过 500 节点 413；未带 session cookie 的 PUT 返回 401。
- **WP-03**：Good Boy 节点/边数量断言（见 US-01）；连续两次调用 revision 相同；修改任一 Shot 后 revision 改变；`If-None-Match` 返回 304；非当前集 storyId 409；查询次数不随 Shot 数线性增长。
- **WP-04**：R1–R13 成功路径各一测；`needs_replace`/`needs_mode_switch`/`cycle`/`reference_limit`/`locked`/`stale_episode` 各一测；replace 原子性（模拟第二步抛错，第一步回滚）；断开反向操作；**断言整个测试过程中 render_jobs 与 storyboard_jobs 行数为 0**。
- **WP-05**：`/studio` 渲染 Good Boy 全部节点与默认连线；暗色主题可读；其他路由不受影响。
- **WP-06**：拖动后刷新位置保持；Mock 渲染时节点进度实时变化；ETag 304 生效（网络面板可见）。
- **WP-08**：ShotPage 所有标签页、渲染、选片、连续性提交行为与改动前一致（附检查清单）。
- **WP-10**：§14 第 1–7 条逐条验证；Mock 也展示摘要；`rg "'/api/render'" web/src` 结果只在 `usePaidAction.ts`。
- **WP-11**：US-03 ~ US-08、US-10 全部通过。
- **WP-14**：运行到此处只提交依赖链上当前可渲染的镜头；一键制作确认文案中的任务数包含将被新建的镜头。

## 17. 测试计划

### 17.1 服务端自动化（新增）

| 文件 | 覆盖 |
| --- | --- |
| `server/test/canvas-rules.test.ts` | 规则表、`canConnect` 正反例、端口可见性 |
| `server/test/canvas-layout.test.ts` | 泳道布局确定性、pinned、隐藏泳道、多 Shot 同 Beat 行高 |
| `server/test/canvas-layout-api.test.ts` | 迁移、布局 CRUD、孤儿清理、注释 CRUD、session 保护 |
| `server/test/canvas-graph.test.ts` | Demo 投影、revision 稳定、ETag、episode 作用域、媒体出现规则、badges |
| `server/test/canvas-connect.test.ts` | R1–R13、全部错误码、原子性、断开、**无付费任务产生** |

测试搭建参照现有 `server/test/*.test.ts`（临时 `H3MISE_HOME`、Mock Provider、安装 Demo）。

### 17.2 前端

- 当前 web 无测试框架；本期**不强制**引入。纯逻辑均放在 `shared` 并由服务端测试覆盖。
- 若实现者希望为 store/composable 加测试，可引入 `vitest`（单独 PR，需评审同意）。

### 17.3 手工 QA 清单（WP-20 执行，Mock Provider）

1. 安装 Good Boy → `/studio` → 节点与连线符合 US-01。
2. 拖动 5 个节点 → 刷新 → 位置保持；切换到另一集再切回 → 各自保持。
3. 把 Ben 拖到 S03.cast → 替换确认 → 主角色改变，导演台页同步。
4. 把一张图拖到 S03.refs → 角色选择 → 绑定出现；断开 → 撤销 toast → 撤销 → 绑定恢复。
5. S02.tail_frame → S03.first_frame → S03 显示 ⛓；尝试 S03 → S02 → 提示成环。
6. S03：AI 规划（未配 AI 时提示）→ 编译 Prompt → 预检 → 渲染 → 对话框显示摘要（Mock）→ 确认 → 进度 → Take 出现。
7. 选择并提交连续性 → Takes.selected → Timeline → 快速组装 → 导出 → Export 节点显示结果。
8. 设置中把 Provider 切为未配置的 RunningHub → 渲染对话框确认按钮禁用并有设置链接。
9. 外部调用 `POST /api/ai/agent/session` → 在 Studio 点 AI 规划 → 🤖 角标与 AI 请求 Dock 计数出现 → `DELETE` 会话后恢复。
10. 窗口缩到 1200px → 显示宽度提示与经典页面链接。
11. 所有旧路由逐个打开，无报错。

## 18. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 画布被误解为"可执行图"，用户期待改完自动跑 | 期望落差 / 误付费焦虑 | 顶栏与空状态文案说明"画布是项目地图，生成需逐个确认"；永不自动执行 |
| 投影查询 N+1 导致大项目卡顿 | 性能 | §11 聚合 SQL + 查询次数测试 + ETag 304 |
| ShotPage 抽取引发回归 | 导演台功能损坏 | WP-08 单独 PR、先抽取后使用、人工对比清单 |
| 连线绕过领域校验 | 数据不一致 / 绕过上限 | 分发器只调用现有模块函数；深度校验在服务端；测试覆盖 |
| 多标签页同时编辑 | 布局互相覆盖 | 布局逐节点 LWW（可接受）；领域修改由现有接口保证；SSE 驱动刷新 |
| 孤儿布局行积累 | 库膨胀 | 惰性清理 + reset 接口 |
| 资产节点过多导致意大利面 | 可读性 | 实体连线 focusOnly、芯片替代、媒体按需出现 |
| 部分现有路由修改后不发 SSE（如 Beat/绑定 CRUD） | 其他标签页画布不刷新 | 本标签页依赖命令返回值刷新；P1 在这些路由补发 `project.updated`（单独小 PR，需确认不影响 App.vue 的刷新频率） |
| Vue Flow 1.x → `@xyflow/vue` 2.x 迁移 | 未来升级成本 | 所有 Vue Flow 用法集中在 `StudioCanvas.vue`、`BaseNode.vue`、`PortHandle.vue`、`TypedEdge.vue` 四个文件 |

## 19. 给执行模型的通用指令（派活时粘贴在任务开头）

```text
你在 H3Mise 仓库中实现「Studio Canvas」的一个工作包。开工前：
1. 完整阅读仓库根目录 AGENTS.md，以及 docs/studio-canvas/01-ui-design.md 和 02-prd-tech.md。
2. 只实现分配给你的 WP（编号见 02-prd-tech.md §16），不要顺手实现其他 WP。
3. 硬性规则：
   - 画布是领域模型的投影，只持久化布局；不得新增第二份 Beat/Shot/Take 数据。
   - 连线命令只能调用现有模块函数完成领域修改；不得复制或绕过 Preflight、活动任务锁、参考上限、Provider 能力检查。
   - 不得新增任何付费后端路径；前端付费调用只能经过 usePaidAction / PaidActionDialog。
   - 测试只使用 Mock Provider，不得访问网络或需要任何密钥。
   - 不修改与本 WP 无关的文件；保留现有行为。
4. 代码风格与周边代码一致：TypeScript strict、Vue 3 <script setup>、Pinia setup store、Hono 路由、node:sqlite、
   测试用 node:test + tsx 放在 server/test/*.test.ts。注释只写代码本身无法表达的约束。
5. 交付：通过 pnpm typecheck、pnpm test（前端 WP 还需 pnpm --filter @h3mise/web build）；
   PR 描述列出完成的验收项（§16.2）与未完成项，前端 WP 附截图。
```

## 附录 A：节点 ID / 边 ID 速查

| 对象 | 节点 ID | 说明 |
| --- | --- | --- |
| Story（当前集） | `story:<storyId>` | |
| Beat | `beat:<beatId>` | |
| Sequence | `sequence:<sequenceId>` | 组框 |
| Storyboard 页 | `storyboard:<storyboardId>` | 格子是节点内部端口 `panel:<panelId>` |
| Entity | `entity:<entityId>` | |
| CharacterState | `cstate:<stateId>` | groupId = entity 节点 |
| Media | `media:<mediaId>` | |
| Shot | `shot:<shotId>` | |
| Takes | `takes:<shotId>` | 每 Shot 一个 |
| Timeline | `timeline:<timelineId>` | |
| Export | `export:<timelineId>` | |
| Note / Frame | `note:<id>` / `frame:<id>` | 仅存在于 layout 文档 |

| 边 | 边 ID |
| --- | --- |
| story_beat | `story_beat:<beatId>` |
| beat_shot | `beat_shot:<shotId>` |
| cast | `cast:<shotId>:<entityId>` |
| binding | `binding:<bindingId>` |
| storyboard_panel | `storyboard_panel:<bindingId>` |
| frame_chain | `frame_chain:<shotId>` |
| shot_takes | `shot_takes:<shotId>` |
| take_clip | `take_clip:<clipId>` |
| timeline_export | `timeline_export:<timelineId>` |
| continuity | `continuity:<fromShotId>:<toShotId>` |

## 附录 B：现有页面路由 → Studio 深链映射（`toStudioLink`）

| 旧路径 | Studio 深链 |
| --- | --- |
| `/story` | `/studio?node=story:<activeStoryId>` |
| `/storyboard` | `/studio?lane=storyboard` |
| `/shots` | `/studio?lane=shots` |
| `/shots/:id` | `/studio?node=shot:<id>` |
| `/shots/:id?tab=prompt`（若有） | `/studio?node=shot:<id>&tab=prompt` |
| `/assets` | `/studio?dock=assets` |
| `/timeline` | `/studio?bottom=timeline` |
| `/production` | `/studio?bottom=problems` |
