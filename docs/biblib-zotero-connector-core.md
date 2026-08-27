# BibLib 插件的 Zotero Connector 实现逻辑

研究自 [callumalpass/obsidian-biblib](https://github.com/callumalpass/obsidian-biblib) 源码。

## 一、核心设计理念

BibLib 是 Obsidian 的学术文献管理插件。核心设计是**没有数据库**——每篇文献存储为一个 Markdown 笔记，元数据以 **CSL-JSON 格式**写入 YAML frontmatter：

```yaml
---
id: smith2023
type: article-journal
title: Example Article Title
author:
  - family: Smith
    given: Alice
container-title: Journal of Examples
issued:
  date-parts:
    - [2023, 6, 15]
DOI: 10.1234/example
tags:
  - literature_note
---
```

## 二、伪装 Zotero 客户端的原理

Zotero Connector（浏览器扩展）默认把抓取到的文献数据 POST 到本机 **23119 端口** 上的 Zotero 桌面客户端。BibLib 的做法：

- 在 Obsidian 内启动一个本地 HTTP 服务器，监听 **23119 端口**（与 Zotero 桌面版相同）；
- 因为端口相同，两者**不能同时运行**，使用前必须关闭 Zotero 桌面应用；
- 浏览器扩展并不知道端口上是谁，它只按协议发送请求——于是被 BibLib 的服务器"截获"。

## 三、关键源码文件

核心实现分两个文件：

1. `src/services/connector-server.ts` —— **HTTP 服务器**，监听 23119，处理 Connector 协议端点；
2. `src/managers/zotero-connector-manager.ts` —— **事件消费与管理**，订阅服务器派发的事件，解析 Zotero item，弹窗预填并落盘。

### 3.1 ConnectorServer（connector-server.ts）

**核心依赖获取**：Obsidian 桌面版（Electron）允许在渲染进程里用 `window.require` 拿 Node 模块：

```ts
function requireNodeModule<T>(moduleName: string): T {
    const requireFn = (window as unknown as { require?: (id: string) => unknown }).require;
    return requireFn(moduleName) as T;
}
```

启动时需要 `http`、`fs`、`path`、`stream`、`url`、`crypto`、`os`、`util` 等模块。

**服务器启动 / 停止**：

```ts
this.server = http.createServer((req, res) => { void this.handleRequest(req, res); });
this.server?.listen(port, LOCALHOST, () => { /* Success */ });
// 处理 EADDRINUSE（端口被占）、EACCES 等错误
this.server?.on('error', (err) => { /* notice + reject */ });
```

端口来自 `settings.zoteroConnectorPort` 或默认 `DEFAULT_ZOTERO_PORT`（23119）。

**请求路由**（`handleRequest`）：先设置 CORS 头，处理 `OPTIONS`（返回 204），`X-Zotero-Version` 响应头。路径以 `/connector/` 开头则进入 `routeConnectorApi`，根路径 `/` 返回状态信息。

**端点路由表**（`routeConnectorApi`）：

| 端点 | 处理 |
|---|---|
| `ping` | 返回 Zotero 可识别的握手数据（`authenticated:false`、`prefs`、`version` 等）。若客户端 API 版本 > 支持版本返回 412 |
| `saveItems` | 核心。解析 JSON 中的 `items`、建立 session，存 `sessions` Map，返回 200 |
| `saveSnapshot` | 处理网页快照，建立 session |
| `saveAttachment` / `saveStandaloneAttachment` | 把附件流写入临时目录，记录进度 |
| `saveSingleFile` | 处理 HTML 快照文件 |
| `getSelectedCollection` | 返回一个假集合，让扩展能继续 |
| `sessionProgress` | Zotero 轮询会话进度，`done` 时为 true 则触发派发 |
| `getTranslatorCode` / `getTranslators` | 返回空数组 |
| `delaySync` / `updateSession` | 返回 acknowledged |
| `installStyle` / `import` / `getClientHostnames` / `proxies` | 501 未实现 |

**session 管理**：用 `Map<string, SessionData>` 存储每个 `sessionID` 的数据（uri、items、attachmentStatus、processedSnapshots 等）。定期清理超时（30 分钟）且已派发过的 session。

**关键协议常量**：
- `CONNECTOR_SERVER_VERSION = '1.0.7'`（冒充的版本号）；
- `CONNECTOR_API_VERSION_SUPPORTED = 3`；
- `ZOTERO_APP_NAME = 'Obsidian BibLib'`。

**附件处理**：`saveAttachment` 用 X-Metadata header 携带附件元数据（id、url、contentType、parentItemID、title），从 `sessionID` 查询参数定位 session。用 `pipeline(req, fs.createWriteStream(filePath))` 落盘。按文件名、内容做去重。

**session 完成判断与派发**（`checkAndDispatchIfComplete`）：当所有期望附件的进度都到 100 或 -1 时，判定会话完成，通过 `CustomEvent('zotero-item-received')` 派发到 `activeDocument`，payload 是深拷贝的 item + 附件路径列表。因为它可能跟踪迟到附件，还有 `monitorForAdditionalAttachments`（每 1 秒检查一次，最多 5 分钟）派发 `zotero-additional-attachments`。

### 3.2 ZoteroConnectorManager（zotero-connector-manager.ts）

职责：管理服务器生命周期 + 消费事件并创建文献笔记。

- **平台限制**：`Platform.isMobile` 时直接返回不初始化（监听端口只有桌面版可行）。
- **动态加载**：用 `await import('../services/connector-server')` 延迟加载 ConnectorServer 类，避免移动端报错。
- **事件监听**：`activeDocument.addEventListener('zotero-item-received', ...)` 和 `zotero-additional-attachments`。用 `plugin.register()` 注册清理（Obsidian 卸载时自动移除监听）。
- **去重**：维护 `processedSessionIds`（10 分钟自动删旧，超 50 条裁剪）、`processingItem`、`activeZoteroItemId` 防止重复弹窗 / 重复导入。
- **主流程** `handleZoteroItemReceived`：
  1. 校验 `event.detail.item`；
  2. 用 `citationService.parseZoteroItem(item)` 把 Zotero item 解析成 CSL-JSON；
  3. 打开 `BibliographyModal` 弹出并 `populateFormFromCitoid(cslData)` 预填字段；
  4. 处理附件（文件/路径 → `modal.setAttachmentData`）；
  5. `modal.onClose` 时 `resetZoteroProcessing()`。
- **附件补发**：`handleAdditionalAttachments` 处理迟到的 PDF，追加到已打开的 modal。

## 四、对其他实现（本插件）的启示

- **本插件需从零实现一套等效服务**：思源无现成的 `window.require` 来源？——思源桌面版同为 Electron，通常也暴露 `window.require`（或需通过 `require` 兼容层），需实测确认；否则可考虑利用思源提供的 `fetchPost` 之类通道，但启动本地 HTTP 服务器仍需 Node 模块。
- **协议端点必须覆盖**：`ping`（让扩展握手通过）、`saveItems`（主入口）、`saveSnapshot` / `saveAttachment`（附件，可选）、`sessionProgress`（扩展轮询）。其中 `ping` 的字段结构（`authenticated`、`prefs`、`version`）必须正确，否则 Connector 不认为本地有可用 Zotero。
- **务必告知用户关闭 Zotero 桌面版**：端口冲突。
- **落盘方式不同**：BibLib 写 Obsidian vault 文件；本插件应改为调思源内核 API `createDocWithMd`。

## 参考链接

- https://github.com/callumalpass/obsidian-biblib
- https://github.com/callumalpass/obsidian-biblib/blob/main/src/services/connector-server.ts
- https://github.com/callumalpass/obsidian-biblib/blob/main/src/managers/zotero-connector-manager.ts
