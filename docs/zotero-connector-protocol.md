# Zotero Connector 本地 HTTP 协议

来源：Zotero 官方开发文档与源码（`chrome/content/zotero/xpcom/connector/server_connector.js`、`server.js`）。

本插件要伪装成 Zotero 桌面客户端，就必须实现并正确应答这个协议。

## 一、基本概念

Zotero 桌面客户端内置一个 HTTP 服务器，默认监听 `http://127.0.0.1:23119`，专门用于与 Zotero Connector 浏览器扩展通信。扩展的所有请求都到这一台本地服务器。本插件监听同一端口、按同样协议应答即可"截获"数据。

## 二、核心端点：`POST /connector/saveItems`

- **完整路径**：`POST http://127.0.0.1:23119/connector/saveItems`
- **方法**：仅 `POST`
- **Content-Type**：`application/json`
- **作用**：将翻译器（translator）抓取到的条目元数据写入本地库。

### 请求体（Connector 协议 JSON）

```json
{
  "items": [
    {
      "itemType": "book",
      "title": "The Title",
      "creators": [
        { "firstName": "First", "lastName": "Last", "creatorType": "author" }
      ],
      "date": "2024",
      "publisher": "Publisher Name",
      "ISBN": "978-0-123456-78-9",
      "url": "https://...",
      "abstractNote": "Abstract text",
      "tags": [ { "tag": "keyword1" }, { "tag": "keyword2" } ],
      "notes": [ { "note": "<p>HTML note content</p>" } ]
    }
  ],
  "uri": "http://source-url.com",
  "sessionID": "unique-session-id"
}
```

关键说明：
- `items`：条目数组，每个条目使用 Zotero 的 `itemType` 字段格式（`book`、`journalArticle`、`conferencePaper` 等）；
- **`uri` 与 `sessionID` 是协议必需的包装字段**，缺一不可。`sessionID` 用于标识一次"保存会话"，可用任意唯一字符串；`uri` 通常是来源网页地址；
- **成功响应为 `201 Created`**（正文为空，BibLib 实现里返回 200 + sessionID 也能通过）；
- `saveItems` 忽略条目中的 `collections` 字段——它始终保存到 Zotero UI 中当前选中的集合。

## 三、同端口其他 Connector 端点

| 端点 | 作用 |
|---|---|
| `POST /connector/saveItems` | 创建带完整元数据/笔记/标签的条目 |
| `POST /connector/saveSnapshot` | 将网页保存为条目（快照） |
| `POST /connector/import?session=<uuid>` | 导入 BibTeX / RIS 等格式 |
| `POST /connector/saveAttachment` | 为会话中刚创建的条目附加文件 |
| `POST /connector/saveStandaloneAttachment` | 保存独立附件（PDF 等） |
| `POST /connector/updateSession` | 更新会话的标签/目标集合 |
| `POST /connector/getSelectedCollection` | 获取当前选中的文库/集合 |
| `GET/POST /connector/ping` | 健康检查（GET 返回 HTML "Zotero is running"） |
| `POST /connector/installStyle` | 安装引用样式 |
| `POST /connector/sessionProgress` | 扩展轮询会话保存进度 |
| `POST /connector/saveAttachmentFromResolver` | 通过 resolver 保存附件 |
| `GET /connector/getTranslators` | 获取翻译器 |
| `GET /connector/getTranslatorCode` | 获取翻译器代码 |

### `/connector/ping` 的应答结构（关键）

Connector 通过 `ping` 判断本地是否有可用 Zotero。BibLib 的应答体现了必须返回的字段：

```json
{
  "authenticated": false,
  "loggedIn": false,
  "storage": [1, 0, 0],
  "prefs": {
    "downloadAssociatedFiles": true,
    "automaticSnapshots": true,
    "reportActiveURL": false,
    "googleDocsAddNoteEnabled": false,
    "googleDocsCitationExplorerEnabled": false,
    "supportsAttachmentUpload": true,
    "translatorsHash": "obsidian-plugin-static-hash-1.0.7",
    "sortedTranslatorHash": "obsidian-plugin-static-hash-sorted-1.0.7"
  },
  "version": "Obsidian BibLib 1.0.7"
}
```

若 Connector 的 `X-Zotero-Connector-API-Version` 大于服务器支持版本，需返回 `412`.
若返回 `authenticated` 为 true，则要求后续请求带 `Zotero-API-Key`（本插件应返回 false，即未登录）。

## 四、请求头

Connector 通常会带以下头：
- `X-Zotero-Version`：Zotero 版本号；
- `X-Zotero-Connector-API-Version`：Connector API 版本；
- `X-Metadata`：附件上传时 JSON 编码的附件元数据（id、url、contentType、parentItemID、title）；
- `Content-Type`：`application/json`（saveItems）或 `application/octet-stream`（附件二进制正文）。

服务器响应应带 `X-Zotero-Version` 头（Connector 识别服务器身份用）。

## 五、使用前置条件（真实 Zotero）

1. Zotero 桌面版正在运行（Zotero 6/7/8）；
2. 需在偏好设置 → 高级 勾选"允许本机其他应用程序与 Zotero 通信"；
3. 本地 API 无需身份认证。

> 对本插件而言：不依赖真实 Zotero 的这些设置，因为服务器是插件自己。

## 六、安全提示（重要）

官方提醒：任何网页都能向该 HTTP 服务器发起请求（跨域限制只阻止网页**读取**响应，无法阻止请求本身）。因此 **本插件监听的 23119 端口绝不能对公网开放**，必须只绑定 `127.0.0.1`。同时注意，监听此端口会与已运行的 Zotero 桌面版冲突。

## 七、自测命令（curl 模拟 Connector）

```bash
# ping
curl -s -X POST http://localhost:23119/connector/ping -H "Content-Type: application/json" -d '{}'

# saveItems
curl -s -X POST http://localhost:23119/connector/saveItems \
  -H "Content-Type: application/json" \
  -d '{"items":[{"itemType":"book","title":"Test","creators":[],"date":"2024"}],"uri":"http://example.com","sessionID":"test-123"}'
```

## 八、标准 item 字段（常见）

| 字段 | 说明 |
|---|---|
| `itemType` | 条目类型（book/journalArticle/conferencePaper/webpage 等） |
| `title` | 标题 |
| `creators` | 创作者数组，如 `[{firstName, lastName, creatorType}]` |
| `date` | 日期（字符串，如 "2024-06-15"） |
| `abstractNote` | 摘要 |
| `DOI` / `ISBN` / `ISSN` | 标识符 |
| `url` | 来源 URL |
| `tags` | 标签数组，`[{tag}]` |
| `attachments` | 附件数组，`[{title, mimeType, url, linkMode, id}]` |
| `notes` | 笔记数组，`[{note}]` |

## 参考链接

- https://www.zotero.org/support/dev/client_coding/connector_http_server
- 源码：`chrome/content/zotero/xpcom/connector/server_connector.js`、`server.js`（zotero/zotero 仓库）
