# MiniMax H3 Storyboard Patterns

仅在用户要求生成、解释或使用 6/9/12 宫格 Storyboard 时使用。

## Choose the Grid

### 6 panels

适合 10–15 秒、单一事件和简单动作：

1. Establish
2. Subject introduction
3. Action begins
4. Development
5. Climax
6. Ending

### 9 panels

默认选择，适合大多数 15 秒 H3 视频：

1. Establish
2. Introduce subject
3. Start motion
4. Develop
5. Secondary visual event
6. Build
7. Main climax
8. Resolve
9. Hero ending

### 12 panels

只在动作链更复杂、镜头确实更多或中间状态对生成很重要时使用。不要为了显得详细，把 9 格机械扩成 12 格。

## Panels Are Not Cuts

宫格表达顺序视觉状态，不等于切镜数。例如 9 宫格可以分配为：

- Shot 1：Panel 1–2；
- Shot 2：Panel 3；
- Shot 3：Panel 4–6；
- Shot 4：Panel 7–9。

同一镜头中的连续格应保持机位逻辑、运动轨迹和主体尺度连续。不要把每格都写成新的景别或机位，否则视频容易像 PPT。

## Panel Content

每格必须产生真正不同且有导演意义的视觉状态：信息建立、动作开始、因果反馈、视觉高潮或结束构图。避免只把抬手、转头等微小动作机械切成多格。

每格描述：

- 所属 shot；
- 视觉功能；
- 构图与主体尺度；
- 主要动作状态；
- camera position 或 movement（仅在发生变化时）；
- 必须继承到下一格的连续性。

## Continuity Audit

生成后只检查高价值项目：

- screen direction；
- subject orientation；
- camera axis；
- subject scale；
- spatial geography；
- prop ownership；
- lighting direction；
- motion trajectory。

连续向右行驶的主体在所有格中保持 screen-right travel。正面或反打机位通过移动 camera 实现，不能让主体物理掉头。

## Uploaded Grid Reference

用户上传完整宫格图时，默认从左到右、从上到下读取，把整张图视为一个有序 Storyboard，而不是若干互不相关的参考图。

编译进 H3 Prompt 时表达：

`<Picture 1> 是完整且有顺序的 Storyboard。每格表示连续视觉状态或镜头。保持主体身份、银幕方向、空间连续性和动作进程；最终视频不要复制宫格边框、编号、说明文字或 Storyboard 排版。`

若另有身份、场景或道具参考，分别声明每个素材的唯一主要职责，不让宫格图同时承担所有身份细节。

## Storyboard to H3 Prompt

先把相邻格合并为 2–4 个可执行 visual beats，再编译 Prompt：

1. 保留 Storyboard 的关键构图变化和动作因果；
2. 合并同一镜头内的相邻状态；
3. 锁定银幕方向、运动轨迹、道具归属和结束格；
4. 给高潮与 ending 足够时间；
5. 使用调用方要求的 H3 原生段落与标签，不输出宫格分析表。

如果总时长无法覆盖全部状态，优先删掉重复格或合并中间状态，不能让后半段成为最拥挤的动作区间。
