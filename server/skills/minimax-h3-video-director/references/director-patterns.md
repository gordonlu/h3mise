# MiniMax H3 Director Patterns

仅在设计镜头、优化 Prompt 或诊断常见生成问题时使用。

## Visual Goal

Visual Goal 不是剧情摘要，而是最强的视觉记忆点。用一句话表达主体、环境或光影之间最重要的关系。

示例：用户说“银色汽车穿过秋日古城”，视觉核心可以是“现代银色车身与暖色古建筑之间的时代反差”。镜头、光线和 ending 都服务这个反差，不把车标、行人、树叶、建筑细节平均强调。

## Visual Beats 与时间

短视频优先 2–4 个阶段：

1. Establish：让观众理解地点、主体和运动轴线。
2. Develop：主动作开始并建立方向。
3. Payoff：视觉高潮或关键反应。
4. Ending：用稳定的 Hero Shot 或明确结果收束。

时间不平均分配。建立信息够用即可，把更多时间留给主动作、视觉高潮和 ending。只有对白同步、碰撞时点、转场触发或首尾帧对齐确实需要精确控制时，才使用连续且不重叠的时间段。

## Camera Motivation

选择镜头运动前先问它解决什么问题：

- tracking：保持主体与环境关系可读；
- push-in：把注意力集中到决定性细节或反应；
- orbit：主体形态本身需要从多个角度被理解；
- fixed camera：让主体或环境运动成为视觉中心；
- handheld：叙事需要临场、不稳定或纪实感；
- POV：需要让观众承担角色视点。

每个 beat 最多一个主要运动。写清起点、触发、速度关系与停止状态。不能因为“电影感”默认 push-in 或 orbit。

## Motion Hierarchy

为镜头明确以下层级：

- **Primary motion**：推动镜头目的的主动作，只保留一个主要运动所有者。
- **Secondary motion**：由主动作触发的跟随、惯性、衣物或道具反馈。
- **Ambient motion**：风、云、水、烟、树叶或光影等低权重环境运动。
- **Static anchors**：道路、建筑、桌面、地形、机位轴线与核心构图等稳定参照。

示例：车辆持续向画面右侧行驶是 primary；轮胎经过后带起少量落叶是 secondary；树枝轻晃是 ambient；道路几何、城门结构和运动轴线是 static anchors。

## Physical and Performance Causality

按真实先后关系写动作：意图或刺激 → 准备动作 → 主动作/接触 → 被动反馈 → 恢复与结果。

- 角色听见对白后才反应；
- 手接触杯子后杯子才移动；
- 轮胎经过后落叶才被带起；
- 风开始作用后头发和树叶才响应；
- 跌落、冲撞或急停后保留惯性、重心转移和恢复。

如果时长不够，减少动作数量，不压缩呼吸、理解、接触与反应时间。

## Continuity Priorities

只锁真正会漂移且影响理解的事实：

- screen direction；
- subject orientation；
- camera axis；
- subject scale；
- spatial geography；
- prop ownership；
- lighting direction；
- motion trajectory。

换机位不能让主体看起来物理反向。需要反打或正面角度时，改变 camera position，同时保持运动轨迹和银幕方向可读。

## Ending State

Ending State 至少回答：

- 主体最后在哪里、朝向哪里；
- 主动作完成到什么状态；
- 镜头最后是什么景别与构图；
- 哪些环境锚点仍然可见；
- 下一镜若要衔接，应继承什么状态。

避免“继续向前”“镜头结束”之类没有可见状态的结尾。

## Common Failure Fixes

### Direction reversal

锁定 screen direction、主体朝向、运动轨迹和 camera axis；删掉与它冲突的炫技运镜。

### Unwanted push-in

明确 fixed camera、locked composition、no intentional push-in or orbit，并减少其他镜头运动描述。

### Static characters

给人物一个清晰的主动作链、重心变化和结束姿态，不用增加更多环境运动来掩盖。

### Overloaded action

减少 beat 和事件，只保留 visual payoff；把后半段动作密度降下来，避免生成到一半超时。

### Drifting geometry

把建筑、道路、桌面、地台、地平线和核心构图定义为 static anchors；不要同时要求大幅 orbit 或复杂镜头变焦。

### Weak ending

补充 ending composition、final pose、主体位置和仍保留的背景锚点；让最后阶段有足够时间稳定下来。

### Storyboard only partly executed

合并相邻状态，减少每格动作量，不把每格都当独立镜头，并确保后半段不是动作最密集的部分。
