# H3Mise × ComfyUI 接入指南

这份文档既给用户看，也给用户自己的编码助手看。目标是把一个本地 ComfyUI 工作流接成 H3Mise 的视频 Provider，同时保留 H3Mise 的 Shot、Take、连续性、队列和时间线工作流。

## 能力边界

- 使用 ComfyUI 本地服务的原生 HTTP API：上传参考图、提交 Prompt、查询队列与历史、下载视频结果。
- 当前支持文字、首帧、尾帧、首尾帧和参考图输入；暂不把音频或视频素材上传给 ComfyUI。
- H3Mise 只修改已明确映射的工作流输入，不猜测节点，也不会把未知参数藏进 Prompt。
- 导入和检测连接只会得到 `nodes_detected`。第一次真实任务被 `/prompt` 接受后才会变为 `verified`。
- 默认只允许 `localhost`、`127.0.0.0/8` 和 `::1`。远程 ComfyUI 必须由用户审查地址后显式设置 `allowRemote: true`。

ComfyUI 工作流里的云节点仍可能计费。助手不得因为“ComfyUI 是本地 Provider”就假定整个工作流免费，也不得未经用户确认提交真实生成。

## 用户最短接入流程

1. 启动 ComfyUI，默认地址通常为 `http://127.0.0.1:8188`。
2. 在 ComfyUI 前端开启开发者模式，使用 **Save (API Format)** 导出 `workflow_api.json`。普通界面工作流 JSON 不能直接提交给 `/prompt`。
3. 打开 H3Mise 的 **设置 → Provider — ComfyUI Local**，导入该文件。
4. 检查自动识别的输入映射，点击 **检测连接与映射**。
5. 在 **当前项目 → 默认生成服务** 选择 `ComfyUI Local`。
6. 回到镜头页绑定素材并运行 Preflight。第一次真实生成仍应使用最低可行时长和 `0.6 MP`，确认工作流成本后再提交。

连接可先用不含秘密的命令检查：

```bash
curl -sS http://127.0.0.1:8188/system_stats
curl -sS http://127.0.0.1:8188/object_info
curl -sS http://127.0.0.1:4789/api/providers/comfyui/profile
curl -sS -X POST http://127.0.0.1:4789/api/providers/comfyui/verify
```

## 给用户 Agent 的操作协议

### 1. 先检查，不生成

按顺序读取：

```text
GET /api/health
GET /api/providers
GET /api/providers/comfyui/profile
```

不要直接编辑注册库或用户项目文件。不要调用 `/api/render` 来测试连通性。

### 2. 导入 API Format 工作流

将完整的 `workflow_api.json` 作为 JSON body 发送到：

```text
POST /api/providers/comfyui/import
```

H3Mise 会保留工作流并尝试推断输入。为了让推断更可靠，建议在 ComfyUI 中给相关节点设置明确标题，例如：

```text
H3Mise Prompt
H3Mise First Frame
H3Mise Last Frame
H3Mise Reference Image 1
H3Mise Duration
H3Mise Aspect Ratio
H3Mise Megapixels
H3Mise Video Output
```

自动推断只是起点。Agent 必须检查每个 `nodeId` 在 `workflow` 中存在，而且对应 `inputName` 是可编辑 widget，不是节点连线数组。

### 3. 明确 Profile 映射

必要时修改从 `GET /api/providers/comfyui/profile` 得到的 JSON，再整体发送到：

```text
PUT /api/providers/comfyui/profile
```

关键字段：

```json
{
  "provider": "comfyui",
  "baseUrl": "http://127.0.0.1:8188",
  "apiPrefix": "",
  "allowRemote": false,
  "inputs": {
    "prompt": { "nodeId": "6", "inputName": "text" },
    "firstFrame": { "nodeId": "12", "inputName": "image" },
    "lastFrame": { "nodeId": "13", "inputName": "image" },
    "refImages": [],
    "duration": { "nodeId": "21", "inputName": "duration" },
    "aspectRatio": {
      "nodeId": "21",
      "inputName": "aspect_ratio",
      "valueMap": { "16:9": "16:9 (Widescreen)", "9:16": "9:16 (Portrait)" }
    },
    "megapixels": { "nodeId": "21", "inputName": "megapixels" }
  },
  "outputNodeId": "30",
  "providerParamBindings": {
    "steps": { "nodeId": "18", "inputName": "steps" }
  }
}
```

- `valueMap` 把 H3Mise 的标准值转换成该工作流实际接受的枚举值。
- `refImages` 的顺序就是参考图填入工作流的顺序。
- `outputNodeId` 应指向产生或保存视频文件的输出节点。
- 自定义 `providerParams` 必须逐项写入 `providerParamBindings`；未映射参数会被拒绝。
- 保存 Profile 会清除之前的检测状态，必须重新检测。

### 4. 检测连接与映射

调用：

```text
POST /api/providers/comfyui/verify
```

它会访问 ComfyUI 的 `/system_stats` 和 `/object_info`，并检查所有映射是否指向存在的节点输入。成功只代表“服务可达且映射结构有效”，不会执行工作流，也不会证明模型、自定义节点和输出链完整。

### 5. 选择项目 Provider，再做 Preflight

通过 H3Mise 设置页选择 ComfyUI，或更新当前项目配置：

```json
{ "default_provider": "comfyui" }
```

请求地址为 `PATCH /api/current-project/config`。H3Mise 不会在 ComfyUI 未配置时静默改用 RunningHub 或 Mock。

只有用户明确要求真实生成后，Agent 才能运行 Preflight 并提交。真实提交返回 `prompt_id` 后，H3Mise 会持久化任务并轮询 `/history/{prompt_id}` 与 `/queue`；重启后可以继续对账，不应重复提交同一任务。

取消尚在队列中的任务时，H3Mise 会按 `prompt_id` 从队列删除。ComfyUI 的 `/interrupt` 是进程级全局操作，可能误伤其他客户端，因此 H3Mise 不会自动调用它；已开始执行的任务在 H3Mise 标记取消后仍可能继续占用本机算力，需要用户在 ComfyUI 中确认是否手工中止。

## 常见问题

### 导入后没有识别到输入

确认导出的是 API Format。给节点添加明确标题，重新导出、导入；仍有歧义时手工填写 `inputs`，不要凭节点编号猜测。

### 检测成功但生成失败

`nodes_detected` 不代表工作流可执行。先查看错误里的节点信息，确认本机已安装工作流所需模型和自定义节点，并确认输入的时长、画幅、像素值符合节点限制。

### 任务成功但 H3Mise 找不到视频

工作流必须在 History 输出中暴露一个 `.mp4`、`.webm`、`.mov`、`.mkv` 或 `.gif` 文件。把 `outputNodeId` 指到对应输出节点。H3Mise 不会把预览图误当成视频 Take。

### 工作流更新了

节点编号或字段变化后，应重新导出并导入 API Format 工作流、复核映射、重新检测。不要沿用旧映射或旧的 `verified` 状态。

### 使用反向代理或远程机器

设置正确的 `baseUrl` 和可选 `apiPrefix`。非回环地址还必须显式启用 `allowRemote`。启用前应确认网络边界、鉴权和代理是否会暴露队列、历史、上传文件或工作流内容。
