# 思源内核 API：创建文档（createDocWithMd）

思源笔记（SiYuan Note）提供内核 HTTP API（B/S 架构），用于通过 Markdown 内容创建文档。核心接口为 **`POST /api/filetree/createDocWithMd`**。

本插件接收 Zotero 文献后，最终通过此 API 把文献保存为思源指定位置的文档。

## 一、接口基本信息

- **端点**：`POST http://127.0.0.1:6806/api/filetree/createDocWithMd`
- **请求头**：`Content-Type: application/json`；
  `Authorization: Token <你的 API Token>`（Token 在 思源→设置→关于 中查看）
- **方法**：所有思源内核 API 均为 POST，请求体为 JSON
- **返回结构**（统一格式）：
```json
{
  "code": 0,       // 0 成功，非 0 错误
  "msg": "",
  "data": { ... }
}
```

## 二、请求参数

| 参数 | 类型 | 必选 | 描述 |
|---|---|---|---|
| `notebook` | string | 是 | 笔记本 ID（通过 `/api/notebook/lsNotebooks` 获取） |
| `path` | string | 是 | 文档路径，以 `/` 开头，层级用 `/` 分隔，如 `/foo/bar` |
| `markdown` | string | 是 | GFM Markdown 内容 |
| `title` | string | 否 | 文档标题，默认取 Markdown 的第一个标题 |

可选参数（部分版本）：`withMath`（是否包含数学公式）、`clippingHref`、`listDocTree` 等。

## 三、返回数据（data 字段）

| 字段 | 描述 |
|---|---|
| `id` | 新创建的文档 ID |
| `rootID` | 文档根 ID |
| `box` | 笔记本 ID |
| `path` | 文档在数据目录中的存储路径 |
| `hPath` | 人类可读的文档路径 |
| `name` | 文档名称 |

## 四、调用示例

### curl
```bash
curl -s -X POST "http://127.0.0.1:6806/api/filetree/createDocWithMd" \
  -H "Authorization: Token $SIYUAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "notebook": "20210808180117-czj9bvb",
    "path": "/教程",
    "markdown": "# Markdown示例\n\n这是一个通过 API 创建的文档。",
    "title": "Markdown示例文档"
  }'
```

### Python
```python
import requests
url = "http://127.0.0.1:6806/api/filetree/createDocWithMd"
headers = {"Authorization": "Token your_api_token", "Content-Type": "application/json"}
payload = {
    "notebook": "20210808180117-czj9bvb",
    "path": "/教程",
    "markdown": "# 会议纪要\n\n- 讨论了项目时间线",
    "title": "会议纪要"
}
resp = requests.post(url, headers=headers, json=payload)
print(resp.json()["data"]["id"])
```

### JavaScript (fetch)
```javascript
const res = await fetch("http://127.0.0.1:6806/api/filetree/createDocWithMd", {
  method: "POST",
  headers: { "Authorization": "Token " + token, "Content-Type": "application/json" },
  body: JSON.stringify({
    notebook: notebookId,
    path: "/Meeting Notes/2026-03-22",
    markdown: "# Meeting Notes\n\n- Discussed project timeline",
    title: "Meeting Notes"
  })
});
const data = (await res.json()).data;
```

## 五、注意事项（避坑指南）

1. **同名路径不会覆盖**：用同一个 `path` 重复调用，不会覆盖已有文档，而是创建一个以随机数字结尾的新文档。若想"有则追加、无则创建"，需先通过 SQL 查询或 `/api/filetree/getIDsByHPath` 获取已有文档 ID，再调用 `/api/block/appendBlock` 追加。
2. **Markdown 会被解析为块结构**：接口将 Markdown 解析为思源的块结构（Block DOM），支持 GFM（标题、列表、引用、代码块、表格、链接、图片等）。
3. **创建日记**：手动用 `createDocWithMd` 创建日记需手动补 `custom-dailynote-yyyymmdd` 属性；用 `/api/filetree/createDailyNote` 则无需。
4. **内核 API 与插件 API 的区别**：`createDocWithMd` 属于内核 API（HTTP POST，供外部脚本/自动化调用）；插件开发应使用 `require('siyuan')` 的插件 API。两者独立。
5. **写操作不要走 SQL**：思源强烈不建议用 `/api/query/sql` 直接 INSERT/UPDATE/DELETE，会造成数据不一致；创建文档应始终用 `/api/filetree/*` 结构化接口。

## 六、本插件可能的调用路径

- 启动时/设置页让用户选择目标**笔记本**（`/api/notebook/lsNotebooks` 列出），并配置**存放路径**；
- 接收到 Zotero item → 生成文献 Markdown（frontmatter + 正文）→ 调 `createDocWithMd` 写入配置的 notebook + path；
- 若文档已存在（同 citekey/title），需先 `getIDsByHPath` 查重或追加。

## 七、相关接口

- `/api/notebook/lsNotebooks`：列出所有笔记本
- `/api/filetree/getIDsByHPath`：BPath 反查文档 ID（较新版本）
- `/api/block/appendBlock`：向已有文档追加内容
- `/api/file/getFile`：读取 data 下的文件

## 参考链接

- 官方 API 文档：https://github.com/siyuan-note/siyuan/blob/master/API_zh_CN.md
- 路由源码：`kernel/api/router.go`、`kernel/api/filetree.go`
- 接口归类：文档树操作统一在 `/api/filetree/*`
