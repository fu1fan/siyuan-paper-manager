# siyuan-paper-manager 实现设计

> **模板方案决策**：采用 **思源原生模板片段**（方案 A，用户已确认）。
> 模板以 `.md` 文件存在于思源工作空间 `data/templates/`，插件通过内核 API `POST /api/template/render` 让思源渲染填充，再调 `createDocWithMd` 创建文档。

## 一、目标功能（三件事）

1. **保存 Zotero 浏览器端插件发送的所有文件**（PDF、HTML 快照、toc 页等）。
2. **把论文信息用模板格式化** 成预设计好的模板内容，保存为思源文档。
3. **直接导入本地 PDF**：用户主动选择本地 PDF 文件导入，插件自动提取其元数据（含中文文献），再走模板流程保存。

## 二、总体架构

```
                        ┌──────────────────────────────┐
Zotero Connector 浏览器扩展 │        PDF 直接导入入口        │
   │ POST /connector/*    │  (用户选本地 PDF 文件)         │
   ▼                      └──────────┬───────────────────┘
┌────────────────────────────┐       │
│  ConnectorServer (Node http)│       │
│  监听 127.0.0.1:23119       │       │
│  /ping /saveItems /...      │       ▼
│  收集 item + 附件到临时目录   │  MetadataExtractor
└──────────┬─────────────────┘  (PDF 元数据提取)
           │ emitCustomEvent      │ 含中文文献增强
           ▼                      ▼
┌─────────────────────────────────────────────┐
│  ItemProcessor  (统一消费来源)               │
│  1. 附件落盘 → 思源 kernel API                │
│  2. 读取模板 → /api/template/render 渲染      │
│  3. 创建文档 → /api/filetree/createDocWithMd  │
└─────────────────────────────────────────────┘
```

> PDF 直接导入与 Zotero Connector 两条入口最终汇合到同一套 `ItemProcessor`，共用模板渲染与落盘逻辑。

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

## 五、能力 3：直接导入本地 PDF

### 5.A 功能入口

用户主动把本地 PDF 拖入思源/或通过插件命令添加，触发"直接导入"流程。这是除浏览器 Connector 外的第二条输入入口。

### 5.B Zotero 原生如何提取 PDF 元数据

Zotero 5.0.36（2018）之后的机制（**旧版查 Google Scholar 已废弃**）：

1. **取 PDF 前几页文本**——依赖 PDF 有可检索文字层（纯扫描/图片型无法识别）；
2. **识别标识符**——在首几页文本里找 **DOI / ISBN**；
3. **走 Zotero 官方 web 服务** + **Crossref 查元数据**——把前几页 + 识别到的 DOI/ISBN 发给 Zotero 设计的一个 web 服务，服务用多种算法 + Crossref 数据拼出完整父条目。

**关键结论**：
- **DOI 最关键**。PDF 首页有清晰 DOI 时提取成功率最高，建议把 DOI 放显眼位置，"Zotero-friendly PDF"正是这个意思。
- **不读嵌入的 PDF 元数据 / XMP**。Zotero 官方明确"不看 XMP 属性，因为平均质量太低"。即使一个 PDF 用 Adobe 设置了 Title/Author/Keywords，Zotero 也不会采信。
- **不读 Google Scholar**（2018 后弃用，避免频率限制）。

所以 Zotero 原生 = **前几页文本 → DOI/ISBN 检测 → Crossref/web 服务补全**。

### 5.C 中文文献元数据：茉莉花（Jasminum）怎么做

茉莉花（`l0o0/jasminum`）专门解决 Zotero 对中文文献支持差的问题。它**不用知网官方 API**（知网没有稳定公开接口），而是：

1. **从文件名反推检索词**：默认按 `{%t}_{%g}`（标题_作者）模板解析文件名，用正则提取**标题、作者、年份**。**严格要求文件名含中文**（知网对英文关键词召回率极低）。
2. **构造知网高级检索请求**：拼出符合知网语法的检索式（如 `TI %= '标题' AND AU='作者'`），模拟浏览器 POST，带正确 Referer / User-Agent / Origin，区分大陆版与海外版。处理反爬（403 时会重试、刷新 cookie）。
3. **解析检索结果页**：DOM 解析题名、作者、期刊、年卷期、页码、摘要、关键词、DOI、分类号、基金等；多结果时弹窗让人工选最匹配项。
4. **用知网导出接口拿标准引文**：茉莉花还调用知网 `GetExport` 接口，直接拿到 **EndNote 格式**引文文本（`displaymode=GBTREFER`），这比手动解析列表页字段更规整可靠。
5. **中文姓名处理**：针对知网"姓在前、名在后、无空格"的姓名，内置常用姓氏库（含欧阳、司马等复姓）、单双字名概率、上下文判断，做**中文姓名拆分/合并**（支持"初步合并/强制分离"两种模式）。
6. **配套**：把被引次数、是否核心期刊存入 Extra 字段；本地附件智能匹配。

**局限**：强依赖文件名格式且要含中文；**目前只支持知网（CNKI）**，万方/维普不支持；被改过名的文件易匹配失败。

### 5.D 本插件的元数据提取设计（可行路径）

在本插件里，直接导入 PDF 后需拿到结构化元数据。按可靠性排序，采用**多级提取策略**：

| 级别 | 方法 | 适用 | 优点 | 依赖 |
|---|---|---|---|---|
| **1. 嵌入 XMP / 文档属性** | 读 PDF 的 Document Info / XMP（Dublin Core 等） | 出版商 PDF | 本地、快 | PDF 内嵌元数据质量参差 |
| **2. DOI 检测 + Crossref** | 从 PDF 全文/前几页正则找 DOI → 调 CrossRef REST API | 大多英文文献 | 准、标准 | 需提取 PDF 文本、联网 |
| **3. 文件名 + 中文检索** | 茉莉花式：文件名(`标题_作者`) → 知网检索（或 Crossref 等） | 中文文献 | 补上中文本地化 | 强依赖文件名含中文、反爬风险 |
| | | | | |

**落地建议**：
- **先本地、后联网**：先试方法 1（XMP）与 2（DOI→Crossref），都不行再试方法 3（中文检索）。
- **PDF 文本层**：需要从 PDF 提取文本。思源插件里可用 Node 的 PDF 解析库（`pdf-parse` / `pdfjs-dist` 等）在前端/本地提取前几页，再正则找 DOI 或标题。
- **CrossRef REST**：`https://api.crossref.org/works?query.bibliographic=...`，免费无需 key，返回 JSON 含 title/authors/journal/date/DOI，与我们的模板字段天然对齐。
- **中文来源策略**：若要复刻茉莉花，需实现知网检索 + 解析（无官方 API、有反爬），复杂度高且易被前端改版影响。**建议第一版先做方法 2（Crossref/DOI），中文文献作为增强用文件名+中文搜索引擎或知网可选插件**，风险可控。
- **中文姓名归一化**：把提取到的中文作者名按茉莉花逻辑拆成 family/given，供模板 `{{range .authors}}` 复用。

### 5.E 直接导入 PDF 的流程（时序）

```
用户选本地 PDF
   │
   ▼
MetadataExtractor
  1. 读 XMP / 文档属性（本地）
  2. 提取前几页文本 → 正则找 DOI
  3. 花 DOI → Crossref 查元数据（英文）
  4. 可选：文件名中文 → 知网/CSL 检索（中文，增强）
   │ 产出统一 ZoteroItem 结构（含 attachments 指向本地 pdf）
   ▼
ItemProcessor 复用：上传附件 → 渲染模板 → createDocWithMd
```

## 六、需要用户配置项（设置面板）

| 设置项 | 说明 | 默认值 |
|---|---|---|
| Zotero 端口 | 监听端口 | `23119` |
| 目标笔记本 | 文献保存到哪个笔记本 | 用户选择（`/api/notebook/lsNotebooks` 列出） |
| 存放路径 | 笔记本内文档树相对路径（hpath） | `/文献库` |
| 附件目录 | `assetsDirPath` | `/assets/` |
| 模板路径 | 模板文件在 templates 下的路径 | `/data/templates/paper.md` |
| 开箱默认模板 | 首次运行是否写入内置模板 | 开启 |
| PDF 元数据回退顺序 | 直接导入 PDF 时的提取顺序 | XMP → DOI/Crossref → 中文检索 |
| 中文文献检索 | 是否启用中文（知网）元数据增强 | 关闭（默认） |

## 七、工作流（完整时序）

**入口 A：浏览器 Connector**
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

**入口 B：直接导入本地 PDF**
1. 用户选择本地 PDF → `MetadataExtractor` 提取元数据（见 5.D 多级策略）。
2. 产出 `ZoteroItem` 结构 → 走与入口 A 相同的 `ItemProcessor`（上传附件 → 渲染模板 → 建文档）。

> 两条入口共用 `ItemProcessor`，保证模板与落盘逻辑一致。

## 八、关键风险与注意

1. **端口冲突**：23119 与 Zotero 桌面版冲突，使用插件时须关闭 Zotero；只绑定 `127.0.0.1`，禁公网。
2. **`window.require` 可用性**：思源桌面版（Electron）是否能像 Obsidian 一样在渲染进程用 `window.require` 取 Node 模块，**需实测确认**；若不可用，需另找在思源里启动本地 http server 的方法。
3. **模板 `render` 需要绝对路径**，需能获取工作空间路径（思源提供相应 API/属性），否则无法定位模板文件。
4. **附件子目录 bug**（issue #7454）：`/api/asset/upload` 用子文件夹时返回地址不含子文件夹名，需代码拼接。
5. **版本安全**：思源 ≥ 3.1.16，规避 renderSprig / asset upload 的历史漏洞。
6. **PDF 文本提取依赖**：直接导入 PDF 需要从 PDF 提取前几页文本，需引入 PDF 解析库（`pdf-parse`/`pdfjs-dist`）；纯扫描/图片型 PDF 无文字层，提取会失败，需提示用户手动或改用 Connector。
7. **知网反爬**：若实现中文知网检索（茉莉花式），无官方 API、依赖浏览器模拟 + cookie 处理，易受知网前端改版影响，不建议放入第一版核心路径。

## 九、待办（实现前的 confirm 项）

- [ ] 实测思源桌面版 `window.require` / Electron 环境下能否启动 Node `http.server`；
- [ ] 确认获取思源**工作空间绝对路径**的方式（渲染模板需要）；
- [ ] 用 curl 验证 `/api/template/render` 在本机思源可用、字段映射正确；
- [ ] 在思源插件运行环境里实测 Node 的 PDF 解析库能否提取文本（决定直接导入 PDF 的可行性）。

## 参考

- `../docs/zotero-connector-protocol.md` — Zotero Connector 协议
- `../docs/biblib-zotero-connector-core.md` — BibLib 实现参考
- `../docs/siyuan-kernel-api.md` — 思源内核 API（createDocWithMd 等）
- `../docs/siyuan-plugin-dev-guide.md` — 思源插件开发指南
- https://github.com/l0o0/jasminum — 茉莉花（中文文献元数据增强）源码参考
- https://www.zotero.org/support/adding_items_to_zotero — Zotero PDF 元数据提取说明
