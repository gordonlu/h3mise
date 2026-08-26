# h3mise-bible@1 导入格式

通过 `POST /api/import/bible` 导入。导入总是创建新项目，不会覆盖已有项目。

最小内容：

```json
{
  "format": "h3mise-bible@1",
  "story": { "title": "项目名" }
}
```

可选顶层字段：

- `story`: `synopsis`、`body`、`plannedDurationSeconds`、`sequences[]`、`beats[]`
- `entities[]`: `kind`、`name`、`description`、`traits`、`image`、`references[]`、`states[]`
- `worldview`: `text`、`locations[]`
- `visualDirection`: `style`、`aspectRatio`、`defaultDurationSeconds`（1–60 秒）

`image` 和 `references[].path` 在 v1 中必须是本机绝对路径；文件会复制进新项目。单项素材或引用错误会作为 `warnings` 返回。结构错误返回 400；不可预期的中断返回 500，并通过 `partialProjectId` 指明可能留下的半成品项目。
