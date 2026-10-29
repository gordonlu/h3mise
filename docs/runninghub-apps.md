# RunningHub AI Apps（H3Mise 路由备忘）

> 只记录 appId、节点映射和调用顺序；**不记录 API Key、Cookie、`.env`**。
> Key 只在 H3Mise 设置页输入；需要真实渲染时再走 Preflight + 明确确认。

## 启动顺序（每次开机/重启）

1. 先检查服务是否存活：

```bash
curl -sS http://127.0.0.1:4789/api/health
```

2. 如果连不上，先启动 H3Mise（幂等；已在运行会直接返回）：

```bash
cd /data/code/H3Mise
node scripts/h3mise.mjs status --json
node scripts/h3mise.mjs up --json     # 已在运行则不会重复 install/启动
```

离线或依赖已安装时可设置 `H3MISE_SKIP_INSTALL=1`，避免再次访问 npm registry。

3. 等 health 返回 `{"ok":true,...}` 后，再发任何 provider/API 请求；**不要一上来就发 API 或付费任务**。

## 当前 H3Mise 配置（2026-10-29）

- 区域：`cn`
- 主 App：`2114228323600650242`（多参考 Ref2VA）
  - 状态：`nodes_detected`（17 个节点；还没有真实渲染确认）
  - 支持模式：`t2va`, `ref2va`, `vref2va`
  - 节点：prompt `250`；aspect_ratio/megapixels `115`；duration `222`；
    images `231–239`（9）；audio `247–249`（3）；reference video `251`。
- Frame App：`2114235428827131905`（首尾帧 I2VA/L2VA/FL2VA）
  - 状态：`nodes_detected`
  - 支持模式：`i2va`, `l2va`, `fl2va`
  - 节点：prompt `250`；first frame `231`；last frame `232`；
    aspect_ratio/megapixels `115`；duration `222`。
- 附加 App：`2114222578872176641`（单纯换脸）
  - `apps[]` 条目现在必须拥有自己的 `inputs / nodes / capabilities / verification`；只填 appId 的条目是“未映射”，不能被设为当前工作流。
  - 通过 workflow API/MCP 保存并检测后才能启用；主 profile 的节点绝不会借给这个 App。
  - 节点：prompt `310`；aspect_ratio/megapixels `308`；image `322`；video `359`。
  - 映射完成后支持 `faceswap` 模式：恰好一张人脸图 + 一个源视频，不接受参考音频，成片保留源音频；视频时长/大小上限可在该 workflow 的 `capabilities.maxVideoSeconds / maxVideoBytes` 中声明。
  - **不要把它设成 primary/frame App**；它是独立 workflow，按模式解析并单独排队。
  - **2026-10-29 已定位并修复**：`face-swap-2114222` 按 `kind: "faceswap"`、`refImages [322]`、`refVideos [359]`、`refAudios []` 保存并 verify 后，即使视频槽位的 fieldData 含 `None`，也会保留 faceswap 能力；旧数据在读取时自动修复模式列表。重启服务后 `preview mode:"faceswap"` 可正常预览。

> `nodes_detected` 只代表节点已发现，不等于真实渲染已验证。第一次真实提交成功后才能标记 `verified`。

## 调用顺序

1. 启动/health 检查（见上）。
2. 在 H3Mise 设置页选择主 App / Frame App；节点映射用 verify 检测，不猜 nodeId。
3. 角色资产：一张正面脸固定身份；服装四宫格只放服装、不露脸；空场景板。
4. 先用 Mock / 0.6MP 做小样；Preflight；明确确认后再真实渲染。
5. 已有 taskId 的任务先 reconcile，不要重复提交。

## Workflow / Agent API

```bash
# 读取 active workflow、每个模式的槽位与所有已保存 workflow
curl -sS http://127.0.0.1:4789/api/providers/runninghub/profile
curl -sS http://127.0.0.1:4789/api/providers/runninghub/workflows

# 保存 workflow（可先只填 appId；此时 runnable=false）
curl -sS -X POST http://127.0.0.1:4789/api/providers/runninghub/workflows \
  -H 'Content-Type: application/json' -H "Cookie: h3mise_session=..." \
  -d '{"id":"face","name":"换脸","appId":"2114222578872176641"}'

# 检测这个 App 自己的节点（免费，不提交渲染）
curl -sS -X POST http://127.0.0.1:4789/api/providers/runninghub/workflows/face/verify \
  -H "Cookie: h3mise_session=..."

# 查看某模式将发送的 nodeInfoList（本地预览，不联网）
curl -sS -X POST http://127.0.0.1:4789/api/providers/runninghub/workflows/face/preview \
  -H 'Content-Type: application/json' -H "Cookie: h3mise_session=..." \
  -d '{"mode":"faceswap"}'

# 只有已有映射的 workflow 才能激活
curl -sS -X POST http://127.0.0.1:4789/api/providers/runninghub/workflows/face/activate \
  -H "Cookie: h3mise_session=..."
```

MCP 等价工具：`ensure_service`、`get_provider_profile`、`upsert_workflow`、`verify_workflow`、`set_active_workflow`、`preview_workflow_payload`。无 session 的写请求返回 401 `{ code: "session_required" }`；GET 返回的 `bindingSlots / slotsByMode / readiness` 为只读，PUT 会忽略。

## 安全

- API Key 只在 H3Mise 设置页或本机环境中；不要读取/传输 `.env`，不要打印到聊天/日志。
- 不为了测试连通性发起付费渲染。
- 换脸 App 只保存路由；不要在未映射的情况下当主 App 使用。
- 人脸只建议一张正向图；服装/四宫格参考不要露脸，避免复制人与换脸冲突。
