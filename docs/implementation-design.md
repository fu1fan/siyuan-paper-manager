# siyuan-paper-manager 实现设计

> **模板方案决策**：采用 **思源原生模板片段**（方案 A，用户已确认）。
> 模板以 `.md` 文件存在于思源工作空间 `data/templates/`，插件通过内核 API `POST /api/template/render` 让思源渲染填充，再调 `createDocWithMd` 创建文档。

## 一、目标功能（两件事）

1. **保存 Zotero 浏览器端插件发送的所有文件**（PDF、HTML 快照、toc 页等）。
2. **把论文信息用模板格式化** 成预设计好的模板内容，保存为思源文档。

## 二、总体架构

```
Zotero Connector 浏览器扩展
   │  POST http://127.0.0.1:23119/connector/*
   ▼
┌─────────────────────────────────────────────┐
│  ConnectorServer  (插件内 Node http.Server)  │
│  监听 127.0.0.1:23119                        │
│  /connector/ping  /saveItems  /saveSnapshot  │
│  /saveAttachment  /sessionProgress ...       │
│  → 收集 item + 附件到临时目录                  │
│  → 组装为 ZoteroItem 结构化对象               │
└──────────────┬───────────────────────────────┘
               │ emitCustomEvent
               ▼
┌─────────────────────────────────────────────┐
│  ItemProcessor  (消费 item 事件)             │
│  1. 附件落盘 → 思源 kernel API                │
│  2. 读取模板 → /api/template/render 渲染      │
│  3. 创建文档 → /api/filetree/createDocWithMd  │
└─────────────────────────────────────────────┘
```

## 三、能力 1：保存附件文件（PDF / HTML 等）

### 3.1 附件从哪来

Zotero Connector 在 `saveItems` 后会调用 `/connector/saveAttachment`（或 `saveStandaloneAttachment`），把附件二进制流 POST 过来，插件需：

1. 从请求的 `sessionID` query 定位对应会话；
2. 从 `X-Metadata` 头解析附件元数据（`id`、`url`、`contentType`、`parentItemID`、`title`）；
3. 用 Node 把请求体（二进制流）先写入一个**临时目录**（BibLib 做法：`fs.createWriteStream` + `pipeline`，落盘在 `os.tmpdir()` 下）；
4. 记录 `attachmentStatus[id].progress`，等所有期望附件完成后再统一派发事件。

### 3.2 落盘到思源（用内核 API，禁止直接 fs 写 data）

将临时文件**转存到思源仓库**，需通过内核 API。两个可选项：

| 接口 | 适用场景 | 返回值 |
|---|---|---|
| `POST /api/asset/upload` | 附件/资源文件（首选）。Multipart 表单：`assetsDirPath`（如 `/assets/`）+ `file[]` | `succMap`：上传后地址 `assets/foo-xxx.pdf` |
| `POST /api/file/putFile` | 精确控制路径 | `{"code":0}` |

推荐 `/api/asset/upload`，`assetsDirPath` 用 `/assets/`（稳定地址，无子文件夹 bug）。建议在配置里让用户指定附件存放的子目录（如 `/assets/library/`），但需注意 issue #7454 ——使用子文件夹时返回地址不含子文件夹名，需代码拼上。

### 3.3 附件元数据如何处理

上传成功后，应在文献文档中声明附件。思源里通常的做法：

- 在文献文档内插入对附件的引用，或用文档/块属性 `data-assets` 记录附件地址，防止"清理未引用资源"误删；
- 附件路径作为资源链接写入 Markdown（`![[assets/xxx.pdf]]` 或直接引用），让思源识别为附件。

## 四、能力 2：模板化论文信息

### 4.1 模板方案（已确认：思源原生模板片段）

- 模板文件存放在思源工作空间 `data/templates/` 下，`.md` 后缀，文件名即模板名；
- 插件在设置页提供「模板路径」，默认指向 `data/templates/paper.md`（或某个约定文件名）；
- **插件启动检测**：若默认模板文件不存在，可选择写入一份内置默认模板，让用户开箱即用。

### 4.2 渲染链路（关键：复用思源模板引擎）

```ts
import { request } from "siyuan";        // 或 this.app 提供的请求方法

// 1. 读取模板内容（走内核 API，禁止 fs）
const fileRes = await request("/api/file/getFile", { path: "/data/templates/paper.md" });
const templateMd = fileRes.data as string;

// 2. 渲染模板：传模板绝对路径 + JSON 数据，思源返回渲染后的 Markdown
const renderRes = await request("/api/template/render", {
  path: "/<工作空间>/data/templates/paper.md",   // 绝对路径
  data: JSON.stringify(zoteroData),               // 结构化文献数据（JSON 字符串）
});
const renderedMd = renderRes.data;

// 3. 创建文档
await request("/api/filetree/createDocWithMd", {
  notebook: notebookId,
  path: "/文献库/xxx",
  markdown: renderedMd,
  title: docTitle,
});
```

> **`render` 接口细节**（重要）：
> - `data` 必须是 **JSON 字符串**，模板内用 `{{.key}}` 或 `.action{.key}` 访问；
> - 模板引擎支持 Go 模板 + Sprig：条件 `if`、循环 `range`、`now` 日期、`list` 等；
> - 用 `.action{...}` 而非 `{{...}}` 避免与嵌入块语法冲突；
> - 该接口有管理员权限校验，且需思源版本 ≥ 3.1.16（规避 renderSprig SSTI 漏洞）。
> - **渲染路径是绝对路径**（含工作空间前缀），而 `createDocWithMd` 的 `path` 是仓库内相对 hpath（`/` 开头），两者不要混。

### 4.3 模板变量协议（给 Zotero item → 模板的上下文）

Zotero 的 `saveItems` 传入的 item 字段，映射为模板变量。约定如下（字段名尽量沿用 Zotero，便于记忆）：

```jsonc
{
  "itemType": "journalArticle",          // 条目类型
  "title": "……",
  "authors": [                            // 创作者（由 creators 归一化）
    { "family": "Smith", "given": "Alice", "creatorType": "author" }
  ],
  "date": "2024-06-15",
  "dateParts": [2024, 6, 15],
  "abstract": "……",
  "doi": "10.xxxx/xxxxx",
  "isbn": "……",
  "issn": "……",
  "url": "https://……",
  "journal": "……",                        // container-title
  "volume": "12",
  "issue": "3",
  "pages": "123-145",
  "publisher": "……",
  "tags": ["tag1", "tag2"],
  "attachments": [                        // 已上传的附件地址
    { "title": "PDF", "url": "assets/xxx.pdf", "mimeType": "application/pdf" }
  ],
  "citekey": "smith2024alice"             // 引用键（可选，生成）
}
```

模板示例（`data/templates/paper.md`）：

```markdown
---
title: {{.title}}
citation-key: {{.citekey}}
type: {{.itemType}}
authors:
{{range .authors}}  - {{.family}}, {{.given}}
{{end}}---

# {{.title}}

## 元数据
- **日期**：{{.date}}
- **期刊**：{{.journal}}
- **卷期**：{{.volume}}({{.issue}}) {{.pages}}
- **DOI**：{{.doi}}
- **链接**：{{.url}}

## 作者
{{range .authors}}- {{.family}}, {{.given}}
{{end}}

## 摘要
{{.abstract}}

## 附件
{{range .attachments}}- [{{.title}}]({{.url}})
{{end}}

## 阅读笔记
<!-- 在这里记录… -->
```

### 4.4 引用键（citekey）生成

BibLib 用 citekey 命名笔记。建议从 `firstAuthor family` + `year` + `title首词` 拼，如 `smith2024alice`，存入 frontmatter `citation-key`，便于后续引用与去重。

### 4.5 去重 / 复用已有文档

`createDocWithMd` 用相同 `path` 重复调用**不会覆盖**（会新建带随机后缀的文档）。为避免重复导入同一篇文献：

- 先按 `citekey` 或 DOI 查重（用 `/api/query/sql` 查 `blocks` 的属性，或用 `/api/filetree/getIDsByHPath` 按路径查）；
- 已存在时，可选：跳过 / 追加 `/api/block/appendBlock` / 弹窗询问。

## 五、需要用户配置项（设置面板）

| 设置项 | 说明 | 默认值 |
|---|---|---|
| Zotero 端口 | 监听端口 | `23119` |
| 目标笔记本 | 文献保存到哪个笔记本 | 用户选择（`/api/notebook/lsNotebooks` 列出） |
| 存放路径 | 笔记本内文档树相对路径（hpath） | `/文献库` |
| 附件目录 | `assetsDirPath` | `/assets/` |
| 模板路径 | 模板文件在 templates 下的路径 | `/data/templates/paper.md` |
| 开箱默认模板 | 首次运行是否写入内置模板 | 开启 |

## 六、工作流（完整时序）

1. **插件 onload**：读取设置 → 启动 ConnectorServer（监听 23119）→ 检查默认模板是否存在，不存在则写入。
2. **用户在浏览器点击 Zotero Connector** → 扩展 `ping` 通过（插件返回握手数据）→ `saveItems` 发送 item → 插件登记会话。
3. **扩展逐附件 POST `/connector/saveAttachment`** → 插件把附件写临时目录并记录进度。
4. 会话完成后 ConnectorServer `emitCustomEvent('zotero-item-received', {item, files})`。
5. **ItemProcessor** 消费事件：
   - 所有附件 `/api/asset/upload` 转存到思源，拿回 `assets/...` 地址；
   - 组装 `zoteroData` → `/api/template/render` 渲染模板得到 Markdown；
   - `/api/filetree/createDocWithMd` 创建文档；
   - 查重/追加策略可选。
6. **用户卸载插件**：`onunload` 关闭服务器、清临时目录。

## 七、关键风险与注意

1. **端口冲突**：23119 与 Zotero 桌面版冲突，使用插件时须关闭 Zotero；只绑定 `127.0.0.1`，禁公网。
2. **`window.require` 可用性**：思源桌面版（Electron）是否能像 Obsidian 一样在渲染进程用 `window.require` 取 Node 模块，**需实测确认**；若不可用，需另找在思源里启动本地 http server 的方法。
3. **模板 `render` 需要绝对路径**，需能获取工作空间路径（思源提供相应 API/属性），否则无法定位模板文件。
4. **附件子目录 bug**（issue #7454）：`/api/asset/upload` 用子文件夹时返回地址不含子文件夹名，需代码拼接。
5. **版本安全**：思源 ≥ 3.1.16，规避 renderSprig / asset upload 的历史漏洞。

## 八、待办（实现前的 confirm 项）

- [ ] 实测思源桌面版 `window.require` / Electron 环境下能否启动 Node `http.server`；
- [ ] 确认获取思源**工作空间绝对路径**的方式（渲染模板需要）；
- [ ] 用 curl 验证 `/api/template/render` 在本机思源可用、字段映射正确。

## 参考

- `../docs/zotero-connector-protocol.md` — Zotero Connector 协议
- `../docs/biblib-zotero-connector-core.md` — BibLib 实现参考
- `../docs/siyuan-kernel-api.md` — 思源内核 API（createDocWithMd 等）
- `../docs/siyuan-plugin-dev-guide.md` — 思源插件开发指南
