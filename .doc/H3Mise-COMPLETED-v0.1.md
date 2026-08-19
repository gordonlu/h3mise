# H3Mise v0.1 完成文档（Completed）

> 依据：`.doc/MiniMax-H3-Director-Workstation-PRD-v0.4.md`
> 完成日期：2026-08-19（首个开发周期）
> 结论：**PRD §49 v0.1 必须实现清单全部交付**；PRD §52 四类硬标准与 §51 验收场景 A–E 全部脚本化验证通过。
> 第二轮（同日）：**UI 打磨轮** — 浅色主题（默认）+ 深色主题切换、非极简精致化设计系统、P0/P1/P2 review 项全修复，浏览器冒烟无 console 错误。

---

## 1. 交付定位

H3Mise — 面向 MiniMax H3 的 **local-first、Shot-first、AI-optional** 生成式视频导演工作台。
本地负责故事、Shot、资产、导演计划、连续性、Prompt、Take、时间线与项目状态；
RunningHub 仅作为视频渲染 Provider（v0.1 固定接入用户自己的 H3 AI App `2089265538441764866`）。

核心闭环（PRD §56）已完整落地并离线验证：

```text
Story → Shot Plan → Asset Requirements → DirectorPlan → References → H3 Mode
→ Prompt → Preflight → Render → Take → Review/Select → Actual Continuity
→ Next Shot → Timeline → Export
```

---

## 2. 交付清单（对照 PRD §49）

### 项目 ✅
- [x] Project create/open/save（含 `project.json` 配置持久化）
- [x] Single Shot / Sequence / Story 三种格式
- [x] 项目自动恢复（registry 记录 last_project_id，启动时自动重开 + RenderQueue 恢复）

### Story ✅
- [x] Story editor（标题 / Logline / 梗概 / 正文）
- [x] StoryBeat 手工管理（增删改、排序、分类、地点/时间/天气）
- [x] 外部 AI Shot List 导入（粘贴批量创建）
- [x] 可选内置 AI 拆解接口（`ai/actions/story_to_beats`）

### Shots ✅
- [x] Shotboard（封面 / 状态 / Take 数 / 选中 Take / 缺失资产提示）
- [x] Shot CRUD + 批量创建
- [x] Shot 状态机 DRAFT→…→LOCKED（含有限回退，`advanceTo` 双向 BFS）
- [x] duration / mode / purpose / shotFunction / 主角色 / 场景

### Assets ✅
- [x] Entity 五类：Character / Scene / Prop / Vehicle / Creature
- [x] CharacterState（与 Character 严格分离）
- [x] MediaAsset：image / video / audio（ffprobe 自动取尺寸/时长）
- [x] ReferenceBinding roles（first_frame / last_frame / identity / motion / audio 等 12 种）
- [x] drag & drop 导入 + 本地绝对路径导入
- [x] frame extraction（视频抽帧为资产；Take 自动生成 poster / 首帧 / 尾帧）

### Director ✅
- [x] DirectorPlan（完整 §13 schema，不可变版本化）
- [x] 手工分区编辑（Intent / Subject / Blocking / Camera / Performance / Environment / Reality / Continuity / Generation）
- [x] External AI copy/paste（Context Package 复制 + YAML/JSON 粘贴 → 预览 → Apply）
- [x] 本地 Skill 加载接口（`h3-micro-cinematic-director` / `h3-shot-pattern-library` / `h3-performance-director`，支持用户目录覆盖）
- [x] Deterministic Compiler（H3 官方结构：对齐行 + integrated_multimodal_description / overall_soundscape / non_diegetic_music；Ref2VA 六段式；参考编号一致；不发明事实）
- [x] Raw Prompt 路径（免 DirectorPlan，验证通过）

### H3 ✅
- [x] Director / Prompt 层理解 T2VA / I2VA / FL2VA / L2VA / Ref2VA
- [x] Provider Capability 映射（`ProviderCapabilities` 接口 + AiAppProfile）
- [x] UI 只开放当前 Provider Profile 实际支持的模式（Shotboard 与 Director Desk 均按 capabilities 过滤）
- [x] Mock Provider 离线跑通全部 5 种模式（真实 AI App 待用户 key 验证）
- [x] 不为未支持模式伪造 Provider 请求（Preflight 硬拦截）

### Preflight ✅
- [x] Basic（Prompt 非空 / duration 合法 / Provider 模式兼容 / 引用文件存在 / 引用角色完整 / 完整性 / 凭据 / 重复提交）
- [x] Reality constraints（AI 语义检查动作 `reality_check`）
- [x] Continuity checks（AI 语义检查动作 `continuity_check`）
- [x] Provider compatibility（capabilities 校验）
- [x] AI semantic extension point（可选，未配置不阻止）

### RunningHub ✅（实现 + 协议实测对齐；真实调用待 key）
- [x] 以官方文档与实测 probe 验证请求/响应协议（v2 API：upload / submit / query / download；错误码表；HTTP 200-on-error 语义）
- [x] `RunningHubAiAppProvider`（Bearer 鉴权、nodeInfoList 构建、taskId、轮询、结果下载）
- [x] 固定 AI App `2089265538441764866` Profile（可持久化编辑）
- [x] `RUNNINGHUB_API_KEY` 环境变量读取（绝不落盘）
- [x] API Key 检测 / 错误提示（Preflight credential 检查 + Settings 徽标）
- [x] 获取/维护 AI App 可修改字段映射（`apiCallDemo` 节点发现 → Profile 持久化）
- [x] upload assets / submit / taskId persist / poll / download / retry & failure / cost capture（`usage.consumeMoney`）

### Takes ✅
- [x] 多 Take 管理
- [x] Compare（A/B 双播放器，Range 流式）
- [x] candidate / reject / selected + Select+Commit 一键
- [x] failure tags（12 种）
- [x] prompt traceability（Take → PromptVersion → DirectorPlanVersion → ReferenceBindings → Provider 参数，全链可查）

### Continuity ✅
- [x] planned / actual 双层
- [x] commit selected take（未选中不可提交，服务端强制）
- [x] frame bridge（尾帧/首帧自动注册为资产并可一键绑定；连续性继承按钮）

### Media ✅
- [x] MediaAsset API + `/api/media/:id`（仅按 asset id 解析）
- [x] HTTP Range / 206 Partial Content（视频 seek 与 A/B 播放）
- [x] video seek / A-B compare 支持
- [x] project-root/path traversal 保护（raw / 编码 / 绝对路径三种变体实测无泄漏）

### Timeline ✅
- [x] 只接受 Selected Take（服务端强制）
- [x] order / trim in-out / transition（cut / fade / dissolve，xfade 实测 25s/6 片段正确）
- [x] concat（ffmpeg demuxer，-c copy）
- [x] basic audio（amix 混音、volume/mute 元数据）
- [x] export（后台任务 + 逐片段进度 + UI 进度条）

---

## 3. 技术架构（按 PRD §44 冻结栈）

```text
web/  Vue 3 + TypeScript + Vite + Pinia + Vue Router（SPA）
        ↓ localhost HTTP / SSE（127.0.0.1:4789）
server/ Node.js + TypeScript + Hono
├─ SQLite（node:sqlite 内置驱动，零原生依赖；WAL + 迁移机制）
├─ Filesystem（<项目>.h3studio/ 布局，元数据与媒体分离）
├─ FFmpeg（child_process：probe / 抽帧 / poster / trim / concat / xfade / 合成渲染）
├─ RenderQueue（持久化，taskId 恢复续轮询，顺序 worker，成本保护）
├─ Providers：RunningHubAiAppProvider（真实）+ MockProvider（离线，任务持久化）
├─ SSE 事件总线（render.* / take.* / continuity.* / job.*）
├─ 后台任务 JobRunner（ffmpeg 导出、AI 动作——请求不阻塞）
└─ Optional AI（OpenAI-compatible：OpenAI / DeepSeek / MiniMax / Ollama）
```

**安全**（PRD §45 全部落实）：127.0.0.1 绑定；Origin / Host 守卫（仅本机来源）；Session Cookie（HttpOnly + SameSite=Strict）CSRF 防护；CORS 无通配；文件 API 路径穿越校验；API Key 只从环境变量读取，日志不落盘。

**关键实现决策**
- `node:sqlite`（Node ≥22.13 内置）——避免原生编译依赖，符合 local-first；
- Hono 中间件顺序：守卫与静态托管注册在路由挂载之前（实测修正）；
- SSE 用 Hono `streamSSE`（适配器不暴露 `c.env.node`，实测修正）；
- 长操作一律走后台任务（timeline export / AI actions），端点立即返回 jobId；
- Mock Provider 任务持久化到磁盘，使「强杀 → 重启 → 按 taskId 恢复」可离线完整验收；
- RunningHub 节点映射只存在于 AiAppProfile（PRD §25.3），UI/业务层零节点 ID 依赖。

---

## 4. 验证结果（2026-08-19 实测）

### 验收场景（PRD §51）

| 场景 | 脚本 | 结果 |
|---|---|---|
| A 无 AI 单镜头全流程（mock 渲染后端） | `scripts/e2e-mock.sh` | ✅ ALL-E2E-OK |
| B 外部 AI 粘贴 YAML DirectorPlan | `scripts/verify-scenarios-bc.sh` | ✅ 解析→预览→Apply→Context Package |
| C Raw Prompt（免 DirectorPlan） | `scripts/verify-scenarios-bc.sh` | ✅ 导入→预检→可渲染 |
| D 连续短片（Frame Bridge 连续性链） | `scripts/verify-scenario-d.sh` | ✅ 尾帧作首帧→渲染→时间线顺序 |
| E 失败修复循环 | `scripts/verify-scenario-e.sh` | ✅ 打标→改参考角色→新 PromptVersion→重渲→A/B 可追溯 |

### 硬标准（PRD §52）

| 标准 | 验证方式 | 结果 |
|---|---|---|
| AI Independence | 全部流程在零 AI 配置下跑通 | ✅ |
| Recoverability | 渲染中途 `kill -9` → 重启 → taskId 续轮询 → LOCAL_READY | ✅ |
| Traceability | Take → PromptVersion → DirectorPlanVersion → 引用全链 | ✅ |
| No Hidden Paid Actions | 渲染强制 Basic Preflight，BLOCKED 时 422 拒绝；Auto Director 停在渲染前 | ✅ |

### 安全实测

Origin 守卫 403 ✅ · Session 守卫 401 ✅ · Host 守卫 403 ✅ · 路径穿越（raw/编码/绝对路径）无泄漏 ✅ · `GET /api/media/:id` 仅 id 解析 ✅ · Range → 206 ✅ · SSE 流存活 ✅

### 构建与启动

`pnpm --filter @h3mise/server build`（tsc）✅ · `pnpm --filter @h3mise/web build`（Vite）✅ · `node server/dist/index.js` 生产启动 + SPA 托管 ✅ · Vite dev 代理 ✅ · `pnpm -r typecheck` 三包全绿 ✅

### UI 冒烟（headless Chrome，UI 打磨轮新增）

7 页面（projects / story / shots / assets / timeline / settings / shot desk）全部加载：**零 console error、零失败请求**；主题 light→dark 切换并持久化；shot 详情 5 个 tab 渲染；takes 面板 / A-B 播放器 / 左栏资产需求齐全；timeline 12 clip 比例条带 + 点击 clip 出 trim 面板（入点/出点按钮）；assets 媒体 tab 67 缩略图；StoryPage Beat↔Shot 关联徽章。

---

## 5. 运行方式

```bash
pnpm install
cp .env.example .env.local        # 填入 RUNNINGHUB_API_KEY（真实渲染必需）
pnpm dev                          # 并行：server :4789 + Vite :5173
# 或生产：pnpm --filter @h3mise/web build && pnpm start  →  http://127.0.0.1:4789
```

离线验收模式：`H3MISE_PROVIDER=mock pnpm start`（合成渲染，零费用）。

验证脚本索引：`scripts/e2e-mock.sh`、`scripts/verify-standards.sh`、`scripts/verify-scenarios-bc.sh`、`scripts/verify-scenario-d.sh`、`scripts/verify-scenario-e.sh`、`scripts/restart-server.sh`。

---

## 6. 已知限制与凭据门控项（非代码缺口）

1. **真实 RunningHub 渲染未在线验证** — Provider 按官方文档 + 实测 probe 实现（上传/提交/轮询/下载/错误码），但从未用真实 key 跑过真实任务。接入步骤：
   - 配置 `RUNNINGHUB_API_KEY` 重启服务；
   - Settings → Provider → 「检测并获取节点映射」（`apiCallDemo` 抓取用户 AI App 的真实 nodeId/fieldName，写回 Profile）；
   - 跑一次 I2VA/FL2VA 真实渲染，确认上传文件名与节点映射后即可日常使用。
   - 若字段映射需调整：Settings → 编辑 Profile（JSON），只影响适配器。
2. **内置 AI 动作未在线验证** — `AI_BASE_URL / AI_API_KEY / AI_MODEL` 配置后可用（plan_shot / improve_camera / improve_performance / reality_check / continuity_check / compile_prompt / diagnose_take / story_to_beats / beats_to_shots / auto_director）。未配置时优雅降级为 External AI 模板，全产品可用。
3. **内置 Director Skills 为 starter 版** — 三份 skill 文档为精简指引，可后续扩充（`server/skills/` 或 `~/.h3mise/skills/` 覆盖）。
4. **浏览器端 UI 交互测试为冒烟级** — headless Chrome 冒烟覆盖全部页面加载、主题切换、tab/trim 面板交互与 console 错误检查（零错误）；深路径交互（拖拽排序、A/B 同步播放、连续性表单）由服务端 e2e 脚本覆盖 API 层。
5. **服务端暂无单元测试** — 现有验收为集成脚本（覆盖主干）；后续可补模块级测试。

---

## 7. 后续路线（v0.2 候选）

- 批量渲染（X Shots / Y Takes 二次确认，PRD §41 已有成本显示与确认语义，UI 未做批量入口）
- 服务端单元测试与 CI 脚本
- NarrativeState 独立编辑 UI（目前 API 已支持）
- Take 失败 AI 诊断结果直接写入 Take notes
- 时间线音频轨道音量可视化
- 桌面壳评估（Electron/Tauri，PRD §44.3——v0.1 明确不做）

---

## 8. 文件结构速览

```text
shared/src/index.ts        # 领域类型（唯一真相）
server/src/
  config.ts  project-store.ts  events.ts  ffmpeg.ts
  db/        # sqlite 封装 / 迁移 / schema / ids
  modules/   # story shots assets director prompt preflight
             # render takes continuity timeline media ai ai-actions jobs
  providers/ # types / registry / runninghub / mock
  http/      # security / routes / media-route / app
  skills/    # 内置 Director Skills（starter）
web/src/
  pages/     # Projects Story Shots ShotPage(Desk) Assets Timeline Settings
  components/director/  # PlanEditor PromptPanel PreflightPanel TakesPanel ReferencesPanel
  components/           # RenderQueueDrawer VideoPlayer ToastHost ConfirmHost EmptyState
  stores/    # project render toast confirm theme
  composables/ api/ router.ts style.css
scripts/     # 验收与运维脚本
.doc/        # PRD + 本文档
```

---

## 9. UI 打磨轮（2026-08-19 第二轮）

第一轮交付后对全部页面做了一轮 UI review（P0/P1/P2 分级），用户确认"全部修复 + 浅色主题 + 精致化（不做极简风）"。本轮成果：

### 主题系统
- **浅色为默认主题**（暖纸色调 `#ece6d8` 系），深色主题保留并细化（影院暗色）；
- 顶栏 ☾/☀ 一键切换，`localStorage h3mise-theme` 持久化，刷新/重开保留；
- `style.css` 全量重写为双主题设计系统：CSS token（颜色/圆角/阴影/字体栈）、纸感面板、层级按钮（primary/ghost/danger）、徽章、输入框、滚动条、kbd、toast、对话框、empty-state；
- 字体栈：中文正文思源宋体 `var(--serif)` + 数字/编号 `var(--mono)`，精致化而非极简。

### 基础设施
- `stores/toast.ts` + `ToastHost.vue`：全局 toast（ok/err/info，可带 action 跳转），替代散落的 notice；
- `stores/confirm.ts` + `ConfirmHost.vue`：promise 化确认对话框（Enter/Escape 快捷键），替代 `window.confirm`；
- `EmptyState.vue`：各页统一空态（图标 + 标题 + 说明 + 可选行动按钮）；
- `stores/theme.ts`；`api/client.ts` 新增 `fileUrl(relPath)`（poster/导出文件直链）。

### 页面重写
| 页面 | 关键改动 |
|---|---|
| ShotsPage | 5 态筛选（draft/ready/rendering/review/done）、搜索、新建/粘贴面板、卡片五态徽章 + 场景/主角 badge + 缺失资产行（⚠）+ Risk badge + 封面占位 |
| ShotPage | tab 改 `v-show` 保活（草稿切 tab 不丢）、planDirty 守卫（路由离开 + beforeunload + 确认框）、面包屑、头部五态徽章（tooltip 显示内部态）、264px 左栏（资产需求/参考缩略图/连续性+继承按钮）、空态显示首帧预览 |
| PlanEditor | 手风琴分区（默认只开 Intent，状态记忆）、中文主标签 + 英文副标签、dirty 实时检测 + 保存按钮态 |
| TakesPanel | 按 Take 状态出主操作（candidate→选片/选片+提交/拒片；selected→提交连续性/取消；rejected→恢复/改选）、A/B 对比槽 + 同步播放（镜像守卫）、星级评分、失败标签折叠、S/R/A/B 快捷键、完整连续性提交表单（逐角色服装/发型/伤势/手持物 + CharacterState 下拉 + 载具状态） |
| PreflightPanel | 成本预览面板（Provider/Mode/时长/画幅/分辨率 ×1 Take）、渲染主按钮、props 收敛 |
| ReferencesPanel | 缩略图（图片直显 / 视频用 poster）、角色按组（帧/身份外观/运动/声音）、资产选择网格 |
| PromptPanel | `availableModes` prop、按钮忙碌态、列表逆序、复制反馈 |
| StoryPage | Beat↔Shot 关联徽章（从 `/api/shots` 按 storyBeatId 统计）+ 跳转链接、EmptyState |
| AssetsPage | 视频卡片显示 poster 封面 + 抽帧按钮、confirmDialog、EmptyState、媒体导入拖拽区 |
| TimelinePage | clip 条带按时长等比（14px/s）+ poster 缩略图 + 拖拽排序（HTML5 DnD）+ 点击出 trim 面板（播放器打点设入/出点）+ 转场选择 + 导出进度条；总时长用真实 Take 时长 |
| ProjectsPage | confirmDialog + toast |
| App.vue | 导航按 PRD §4 改为 Story/Shots/Assets/Timeline、主题切换按钮、挂 ToastHost/ConfirmHost、SSE→toast（渲染成功/失败可跳转、选片、连续性提交）、ffmpeg/RH/AI 状态徽章 |

### 服务端配套
- `/api/shots` 新增 `missing`（required 需求标签缺口）与 `risk`（最近 preflight 风险）；
- 迁移 v2 `media-poster`：`media_assets.poster_path`，视频导入自动 ffmpeg 抽封面（失败不阻断）；`/api/file` 直链；
- shared 新增 `SHOT_USER_STATUS`（10 内部态 → 5 用户态映射）+ `SHOT_USER_STATUS_LABEL`；
- **修复**：`RunningHubAiAppProvider.name` 字段初始化器在构造函数前读取 `options.profile` 导致默认 runninghub 模式启动崩溃 → 改为 getter。

### 修复的真实 bug（浏览器实测发现）
1. `structuredClone` 克隆 Vue reactive 代理抛 `DataCloneError` → 4 处改用 `toRaw`（PlanEditor / TakesPanel / ShotPage）；
2. `/assets` 前端路由 404：SPA fallback 对 `webDist/assets/`（构建产物目录）误走 serveStatic → `app.ts` 改为仅 `statSync().isFile()` 才静态服务；
3. Vue 模板内联箭头函数不支持 TS 对象字面量类型注解 → 移除 `:on-add` 注解。

### 验证
`pnpm -r typecheck` 三包全绿 ✅ · web build ✅ · e2e-mock 全绿（渲染→选片→连续性→时间线→导出）✅ · headless Chrome 冒烟 7 页面零 console error / 零失败请求 ✅ · 主题切换持久化 ✅ · 默认 runninghub 模式启动不再崩溃 ✅
