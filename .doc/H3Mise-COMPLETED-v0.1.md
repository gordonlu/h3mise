# H3Mise v0.1 完成文档（Completed）

> 依据：`.doc/MiniMax-H3-Director-Workstation-PRD-v0.4.md`
> 完成日期：2026-08-19（首个开发周期）
> 结论：**PRD §49 v0.1 必须实现清单全部交付**；PRD §52 四类硬标准与 §51 验收场景 A–E 全部脚本化验证通过。

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

`pnpm --filter @h3mise/server build`（tsc）✅ · `pnpm --filter @h3mise/web build`（Vite）✅ · `node server/dist/index.js` 生产启动 + SPA 托管 ✅ · Vite dev 代理 ✅

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
4. **浏览器端 UI 交互未被真实浏览器 E2E 覆盖** — 沙箱环境 headless Chrome 的 fetch 被环境阻断；UI 的渲染挂载已验证，交互逻辑与 API 层通过服务端脚本全覆盖。
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
  components/           # RenderQueueDrawer VideoPlayer
  stores/ composables/ api/ router.ts style.css
scripts/     # 验收与运维脚本
.doc/        # PRD + 本文档
```
