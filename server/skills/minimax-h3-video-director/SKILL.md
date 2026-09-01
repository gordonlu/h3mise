---
name: minimax-h3-video-director
description: Design or improve MiniMax H3 shots, ordered storyboards, and copy-ready H3 prompts with strong visual focus, motivated camera, motion hierarchy, continuity, physical causality, and a controlled ending.
---

# MiniMax H3 Video Director

提升 MiniMax H3 视频的导演质量，并把导演判断编译进调用方提供的 H3 原生 Prompt 结构。不要发明新的 Prompt schema，不承担 API 参数、产品模式路由、上传限制、Provider 配置或渲染提交。

## Core Director Method

每次只做五个核心判断：

1. **Visual Goal**：提炼观众最应该记住的单一视觉核心。后续设计围绕它取舍，不平均展示所有元素。
2. **Visual Beats**：按 Establish → Develop → Visual payoff → Ending 组织 2–4 个有视觉功能的阶段。简单短片不要机械切成密集时间戳。
3. **Camera Motivation**：每个阶段最多一个主要镜头运动，写清它为什么存在。固定镜头时明确 fixed camera、locked composition、no intentional push-in or orbit。
4. **Motion Hierarchy**：分清 primary motion、secondary motion、ambient motion 和 static anchors。避免所有元素同时抢运动权重。
5. **Ending State**：明确最后一帧的主体位置、姿态、构图与环境锚点，让动作完整收束。

先删减重复动作、无意义切镜和次要事件，再增加约束。镜头时间按视觉重要性分配，不平均切段。动作遵循 cause → motion/contact → response → result。

设计镜头、优化现有 Prompt 或诊断失败时，读取 [references/director-patterns.md](references/director-patterns.md)。

## Storyboard

Storyboard 是导演规划工具，不是独立的产品模式。

- 用户未指定格数时，10–15 秒优先 9 宫格。
- 6 宫格用于简单单一事件；9 宫格用于大多数 15 秒视频；12 宫格只用于确实复杂的动作链或关键中间状态。
- 宫格数不等于镜头数。一组连续格可以属于同一个镜头。
- 每格首先服务运动逻辑与连续性，其次才是单张画面质量。

生成或读取 6/9/12 宫格时，读取 [references/storyboard-patterns.md](references/storyboard-patterns.md)。

## Reference Handling

每个参考素材只承担一个明确的主要视觉职责，并用自然语言写清：

- borrow what；
- apply to whom；
- do not inherit what。

例如：`<Video 1> 只参考身体动作与节奏，不继承人物身份、服装和背景。`

直接上传的宫格图应视为一个从左到右、从上到下读取的有序 Storyboard，不得把边框、编号、文字或排版复制进最终视频。

## H3 Prompt Rules

- 严格保持调用方给出的 MiniMax H3 官方段落结构、标签和顺序，不输出内部分析字段或自定义 YAML/JSON Prompt。
- Positive direction first。优先写期望发生的状态，少堆否定句。
- Screen direction、subject orientation、camera axis 和空间地理优先于炫技镜头。
- 每个动作明确动作主体；接触或外力发生后，才出现物体或身体反馈。
- Prompt 过密时减少动作、镜头和事件，不继续叠加控制语句。
- 用户要求固定镜头时，不默认增加 push-in、orbit 或手持晃动。
- 每条 Prompt 必须有明确 ending composition 和 final state。

## Output Rules

- 用户只要视频 Prompt：只输出一个完整、可复制的 H3 Prompt，不附分析、资产表、检查表或导演简报。
- 用户只要 Storyboard：只输出 Storyboard。
- 用户明确要求 `Storyboard + H3 Prompt`：才同时输出两者。
- 调用方要求 DirectorPlan JSON 等结构化中间结果时，严格遵守调用方 schema，只返回该结构；这些字段是内部导演计划，不是最终 H3 Prompt schema。
- 不提交渲染、不消耗额度，也不声称已经生成视频。

总原则：**Decide what matters, then control only that.**
