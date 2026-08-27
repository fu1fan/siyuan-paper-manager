# siyuan-paper-manager

一个思源笔记（SiYuan Note）插件，用于接收 Zotero 浏览器扩展（Zotero Connector）发送的文献信息，并将其保存为思源笔记中的指定文档。

核心思路参考 Obsidian 的 [BibLib](https://github.com/callumalpass/obsidian-biblib) 插件。

## 核心目标

将自己**伪装成一个 Zotero 桌面客户端**，拦截 Zotero Connector 浏览器扩展发送的文献数据。

在浏览器网页上点击 Zotero Connector 扩展按钮时，扩展会通过本地 HTTP 协议把抓取到的文献元数据 POST 到本机的 `23119` 端口。原本这个端口上是 Zotero 桌面版,本插件通过监听同一个端口、按同样的协议应答，从而"截获"这条数据流，将其解析后保存到思源笔记指定位置。

## 工作流程图

```text
浏览器网页
   │  点击 Zotero Connector 扩展按钮
   ▼
Zotero Connector 浏览器扩展
   │  POST http://127.0.0.1:23119/connector/saveItems  (JSON)
   ▼
本插件内置的本地 HTTP 服务器 (监听 23119 端口)
   │  解析文献元数据 (item 数据)
   ▼
弹窗/直接创建
   │  通过思源内核 API 调 createDocWithMd
   ▼
思源笔记 指定笔记本 + 指定路径 下的文档
```

> ⚠️ 关键约束：端口 `23119` 与 Zotero 桌面版冲突。使用本插件接收文献时，需要关闭 Zotero 桌面客户端（BibLib 同样如此）。

## 核心功能清单

1. **伪装 Zotero 客户端**：在桌面版思源内监听 `127.0.0.1:23119`，实现 Zotero Connector 协议端点。
2. **接收文献**：处理 `/connector/ping`、`/connector/saveItems`、`/connector/saveSnapshot`、`/connector/saveAttachment` 等端点。
3. **解析元数据**：把 Zotero item 数据（itemType、title、creators、date、DOI 等）转换为思源可用的结构化数据。
4. **保存到指定位置**：通过思源内核 API 将文献写入指定笔记本 + 路径下的新文档。
5. **附件处理**：接收并保存 Zotero Connector 发来的 PDF 等附件（走 `/api/asset/upload` 转存）。
6. **直接导入本地 PDF**：用户主动导入本地 PDF，插件自动提取元数据（含中文文献增强），再走模板流程保存。

## 存储设计：论文元数据页

每篇文献 = 一个**论文元数据页（Metadata Page）**，自上而下三段结构，通过思源内核 API 创建与维护：

- **隐藏字段区**：用思源块属性（`custom-*`）保存论文**所有**元数据，正文不渲染、天然隐藏；通过 `/api/attr/setBlockAttrs` 写入，用户在属性面板查看/编辑。
- **元数据模板区**：可读的元数据摘要，用思源模板片段渲染；论文创建**或元数据被修改**时自动重渲染（用 `/api/block/updateBlock` 更新）。
- **笔记模板区**：自由笔记区，仅在论文创建时由模板**一次性**格式化到文档末尾，之后不再被覆盖。

模板以 `.md` 存于思源工作空间 `data/templates/`（两份：`paper-meta.md` 元数据区、`paper-note.md` 笔记区），插件通过 `POST /api/template/render` 让思源渲染填充（Go 模板 + Sprig：条件、循环、日期等）。

> **已知限制**：思源内核 `setBlockAttrs` 修改属性**不触发 `savedoc` 事件**（Issue #17179），因此"用户手动改属性 → 元数据模板区纯自动刷新"较难；落地以插件主动更新 + 插件提供"编辑元数据"入口为主。详见设计文档 4.7。

附件（PDF / HTML）通过内核 API `POST /api/asset/upload` 转存到思源仓库，禁止直接 `fs` 写 `data`。

## 直接导入 PDF 的元数据提取

参考 Zotero 原生与茉莉花插件的做法，采用多级回退策略。第一版以 **公开 API 为主 + 知网检索为可选（默认关闭）**：

| 级别 | 方法 | 适用 | 合规性 |
|---|---|---|---|
| 1 | 读 PDF 内嵌 XMP / 文档属性 | 出版商 PDF | ✅ 本地读取 |
| 2 | 提取前几页文本 → 找 DOI → 交叉引库（CrossRef / 维基 Citoid） | 大多文献（含部分中文） | ✅ 公开 API，免 key |
| 3 | 文件名(标题_作者) → 中文检索（知网式） | 中文文献增强 | ⚠️ 无官方 API、有反爬，作为可选开关（默认关闭） |

> **API 合规性**（核实自 BibLib 源码 `src/services/api/citoid.ts`）：BibLib 实际用的是 **维基 Citoid REST**（`en.wikipedia.org/api/rest_v1/data/citation/bibtex/`，公开免 key）+ **Citation.js**（内部组合 **CrossRef / PubMed / Open Library / Wikidata** 等公开 API）。这些全部对第三方开放。
> 相反，**Zotero 官方的 PDF 识别 web 服务未公开、无开发者授权**，BibLib 也没用，不建议用；**知网 CNKI 无官方 API**（茉莉花靠爬虫模拟），置为可选且默认关闭。

> 说明：Zotero 原生（5.0.36+）是"前几页文本 → DOI/ISBN 检测 → Crossref/web 服务补全"，**不读 XMP、不用 Google Scholar**。茉莉花则依赖"文件名反推 → 模拟知网检索 → 解析页面"，可参考其中文姓名拆分/合并。

详细设计见 [docs/implementation-design.md](docs/implementation-design.md)。

## 技术要点

- **运行环境**：思源桌面版基于 Electron，插件内可用 `window.require` / 类似途径获取 Node 模块（`http`、`fs`、`path`、`crypto` 等），从而启动本地 HTTP 服务器。
- **插件 API**：前端插件 API 通过 `require('siyuan')` 获取（`Plugin` 类、生命周期钩子、`fetchPost` 等）。
- **创建文档**：必须走思源内核 API（`/api/filetree/*`），**禁止**直接用 `fs` 写 `data` 下的文件，否则会导致同步损坏。
- **桌面端限定**：监听端口只在桌面版可行，移动端需禁用。

## 参考资料

详细研究笔记见 `docs/` 目录：

- [docs/siyuan-plugin-dev-guide.md](docs/siyuan-plugin-dev-guide.md) — 思源插件开发指南要点
- [docs/biblib-zotero-connector-core.md](docs/biblib-zotero-connector-core.md) — BibLib 插件的 Connector 实现逻辑
- [docs/zotero-connector-protocol.md](docs/zotero-connector-protocol.md) — Zotero Connector 本地 HTTP 协议细节
- [docs/siyuan-kernel-api.md](docs/siyuan-kernel-api.md) — 思源内核 API（创建文档等）
- [docs/implementation-design.md](docs/implementation-design.md) — 插件实现设计（附件落盘 + 模板渲染）

### 官方 / 上游链接

- 思源插件示例：https://github.com/siyuan-note/plugin-sample
- 思源插件 API 声明：https://github.com/siyuan-note/petal
- 思源内核 API 文档（中文）：https://github.com/siyuan-note/siyuan/blob/master/API_zh_CN.md
- BibLib 仓库：https://github.com/callumalpass/obsidian-biblib
- Zotero Connector HTTP Server 文档：https://www.zotero.org/support/dev/client_coding/connector_http_server
