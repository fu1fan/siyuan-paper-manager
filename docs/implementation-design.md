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

## 四、能力 2：论文元数据页（文档定位升级）

> **文档定位升级（本次变更）**：生成的论文文档不再只是一篇"文献笔记"，而是升级为 **论文的元数据页（Metadata Page）**。自上而下分三段结构：
>
> 1. **隐藏字段区**：保存论文的**所有**元数据（以思源块属性存储，正文不渲染）。
> 2. **元数据模板区**：论文创建**或元数据被修改**时，自动重新渲染，展示可读的元数据摘要。
> 3. **笔记模板区**：只在论文创建时**一次性**格式化到文档末尾，作为自由笔记区，后续不再被模板覆盖。

### 4.1 是否需要思源官方 API 支撑（可行性结论）

三个需求逐一核对思源 API，**结论：都能实现，但第 2 点的"自动"触发机制有明确限制**——详见 4.7。

| 需求 | 思源 API | 是否满足 |
|---|---|---|
| 1. 隐藏字段存元数据 | `/api/attr/setBlockAttrs` 写 `custom-*` 块属性 | ✅ 满足（属性正文不渲染，天然隐藏） |
| 2. 元数据模板自动更新 | `/api/block/updateBlock` + 模板 `render` | ⚠️ 部分满足（需自定义触发，见 4.7） |
| 3. 笔记模板一次性创建 | `createDocWithMd` 时写入正文末尾 | ✅ 满足（等价于文档正文，只在创建时生成） |

### 4.2 模板文件方案（沿用思源原生模板片段）

沿用已确认的"思源原生模板片段"方案，但拆成**两份模板**：

| 模板文件 | 用途 | 渲染时机 |
|---|---|---|
| `data/templates/paper-meta.md` | 生成"元数据模板区"内容 | 创建 + 元数据变更时重渲染 |
| `data/templates/paper-note.md` | 生成"笔记模板区"内容 | 仅创建时一次 |

> 创建文档时可把两段拼成一份 Markdown 一次性 `createDocWithMd`；此后更新只重渲染 `paper-meta` 对应块。

### 4.3 渲染链路（创建时，复用思源模板引擎）

```ts
import { request } from "siyuan";        // 或 this.app 提供的请求方法

// 1. 读取模板内容（走内核 API，禁止 fs）
const metaMd = (await request("/api/file/getFile", { path: "/data/templates/paper-meta.md" })).data;
const noteMd = (await request("/api/file/getFile", { path: "/data/templates/paper-note.md" })).data;

// 2. 渲染模板：传模板绝对路径 + JSON 数据，思源返回渲染后的 Markdown
const render = async (path:string, data:object) =>
  (await request("/api/template/render", { path, data: JSON.stringify(data) })).data;

const metaRendered = await render("/<工作空间>/data/templates/paper-meta.md", zoteroData);
const noteRendered = await render("/<工作空间>/data/templates/paper-note.md", zoteroData);

// 3. 创建文档（正文 = 元数据区 + 笔记区）
await request("/api/filetree/createDocWithMd", {
  notebook, path: "/文献库/xxx", markdown: `${metaRendered}\n\n${noteRendered}`, title: docTitle,
});
```

> **`render` 接口细节**（重要）：
> - `data` 必须是 **JSON 字符串**，模板内用 `{{.key}}` 或 `.action{.key}` 访问；
> - 模板引擎支持 Go 模板 + Sprig：条件 `if`、循环 `range`、`now` 日期、`list` 等；
> - 用 `.action{...}` 而非 `{{...}}` 避免与嵌入块语法冲突；
> - 该接口有管理员权限校验，且需思源版本 ≥ 3.1.16（规避 renderSprig SSTI 漏洞）。
> - **渲染路径是绝对路径**（含工作空间前缀），而 `createDocWithMd` 的 `path` 是仓库内相对 hpath（`/` 开头），两者不要混。

### 4.4 模板变量协议（给 Zotero item → 模板的上下文）

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

模板示例——元数据区（`data/templates/paper-meta.md`）：

```markdown
# {{.title}}

## 元数据摘要
- **类型**：{{.itemType}}
- **作者**：
{{range .authors}}  - {{.family}}, {{.given}}
{{end}}
- **日期**：{{.date}}
- **期刊**：{{.journal}}
- **卷期**：{{.volume}}({{.issue}}) {{.pages}}
- **DOI**：{{.doi}}
- **链接**：{{.url}}

## 摘要
{{.abstract}}

## 附件
{{range .attachments}}- [{{.title}}]({{.url}})
{{end}}
```

模板示例——笔记区（`data/templates/paper-note.md`，仅创建时渲染一次）：

```markdown
## 阅读笔记
<!-- 在这里记录你的阅读/思考，此区域不会被自动覆盖 -->

- 一句话总结：
- 关键论点：
- 启发：
```

### 4.5 引用键（citekey）生成

BibLib 用 citekey 命名笔记。建议从 `firstAuthor family` + `year` + `title首词` 拼，如 `smith2024alice`，存入隐藏字段 `citekey`，便于后续引用与去重。

### 4.6 去重 / 复用已有文档

`createDocWithMd` 用相同 `path` 重复调用**不会覆盖**（会新建带随机后缀的文档）。为避免重复导入同一篇文献：

- 先按 `citekey` 或 DOI 查重（用 `/api/query/sql` 查 `blocks` 的属性，或用 `/api/filetree/getIDsByHPath` 按路径查）；
- 已存在时，可选：跳过 / 追加 `/api/block/appendBlock` / 弹窗询问。

### 4.7 隐藏字段区 + 元数据自动更新的实现方案（关键：可行的边界）

#### (1) 隐藏字段区——存所有元数据

用思源**块属性**存元数据，正文不渲染，天然"隐藏"。做法：

- 创建文档后，对**文档根块（文档 ID）**调用 `/api/attr/setBlockAttrs` 写入全部元数据，属性名用 `custom-` 前缀，如 `custom-title`、`custom-authors`、`custom-doi`、`custom-tags` 等等（字段名见 4.4 协议）。
- 用户查/改入口：思源属性面板（右侧或块标菜单→属性）的自定义属性页签；编辑字段正文不渲染，只作为结构化数据。
- **注意**：`custom-*` 属性默认**不在正文显示**（需 CSS 才显示），这正好符合"隐藏字段"需求；想要时也可停官方 CSS 片段把指定属性显示出来。

#### (2) 元数据模板区——元数据修改时自动更新

**设计约定（关键）**：隐藏字段（元数据）**只能通过本插件提供的 UI 修改**，不允许用户在思源属性面板里绕过插件改。因此：

- **不存在"用户绕过插件改字段、插件却不知情"的触发问题**。每一次元数据修改都必然经过插件 UI，插件拿到新值后**主动重渲染元数据模板区**，完全自动化，无需依赖思源的属性变更事件。
- 更新模板区内容用 `/api/block/updateBlock`（保留块 ID），但**直接 `updateBlock` 会清空该块原有属性**，需用 `getBlockKramdown` 取回源码、内联属性一并传回，或用 `/api/transactions` / `protyle` 事务改。

**因此"自动更新"的触发链路（单一、明确）：**
```
用户在插件 UI（编辑元数据对话框）修改属性
   → 插件 setBlockAttrs 写隐藏字段（custom-*）
   → 插件把新 zoteroData 过 /api/template/render 重渲染元数据区
   → 插件 updateBlock 刷新元数据区区块
```
> 结论：无需依赖思源事件。因为修改入口唯一且由插件掌控，模板区刷新可做到**确定性的纯自动**。此前担心的"思源无属性变更事件（Issue #17179）"不再是障碍——我们本来就不想靠它。

> 备注：仍保留"用 `custom-section = meta / note` 块属性标记两块区域"的做法，用于定位要刷新的区块，避免误伤笔记区。

#### (3) 笔记模板区——一次性创建

笔记区作为文档正文的一部分，在 `createDocWithMd` 时随元数据区一起写入文档末尾，后续**不参与元数据刷新**（更新只作用于专门标记的元数据区块）。可通过给笔记区块设标记（如 `custom-note-section`）保持稳定，避免被模板刷新误覆盖。

### 4.8 文档如何区分"元数据区"与"笔记区"

为避免更新元数据模板时误伤笔记区，可在创建时用**块属性**给两部分打标：
- 元数据区根块加 `custom-section = "meta"`；
- 笔记区根块加 `custom-section = "note"`。

更新时按属性定位元数据区块（SQL 查 `attributes` 或按容器块遍历），只 `updateBlock` 该区块。

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

> **决策（已确认）**：第一版走 **公开 API 为主 + 知网爬虫可选开关（默认关闭）**。
> - **外文文献**：用公开、免费、免 key 的公共服务，合规稳定。
> - **中文文献**：提供可选开关调用知网检索（类似茉莉花），默认关闭以规避反爬与条款风险；中文文献有 DOI 时，公开 API 亦可能覆盖。

#### 元数据 API 的合规性对照（先厘清"能不能用"）

| 来源 | 性质 | 第三方是否可用 | 说明 |
|---|---|---|---|
| **维基 Citoid**（Wikipedia REST，URL/DOI/ISBN → BibTeX） | 维基媒体基金会公开 REST 服务 | ✅ 可用 | 免 key、无访问限制，设 `User-Agent` 即可 |
| **CrossRef**（DOI → CSL-JSON） | 公开学术元数据登记库 | ✅ 可用 | 免费、免 key，`api.crossref.org` |
| **PubMed / Open Library / Wikidata**（PMID / ISBN） | 公开 API | ✅ 可用 | 配合 citation-js 插件调用 |
| **Zotero 官方 PDF 识别 web 服务** | Zotero 内部私用 | ❌ 不可用 | 未公开、无文档、无开发者授权；BibLib 也没用 |
| **知网 CNKI 检索**（茉莉花式） | 无官方 API，爬虫 + 反爬 | ⚠️ 灰色 | 不稳定、有反爬风险、可能违反条款；作为可选开关 |
| **Google Scholar** | 已被 Zotero 弃用（限流） | ❌ 不建议 | — |
| **PDF 内嵌 XMP** | 本地读取，非 API | ✅ 可用 | 质量参差，只作兜底 |

#### MetadataExtractor 提取流程（按可靠性回退）

| 级别 | 方法 | 适用 | 优点 | 依赖 |
|---|---|---|---|---|
| **1. 嵌入 XMP / 文档属性** | 读 PDF 的 Document Info / XMP（Dublin Core 等） | 出版商 PDF | 本地、快 | PDF 内嵌元数据质量参差 |
| **2. DOI 检测 + 公开 API** | 从 PDF 前几页正则找 DOI → 交叉引库（CrossRef/Citoid） | 大多文献（含部分中文） | 准、标准、合规 | 需提取 PDF 文本、联网 |
| **3. 文件名 + 中文检索（可选，默认关）** | 茉莉花式：文件名(`标题_作者`) → 知网检索 | 中文文献 | 补上中文本地化 | 强依赖文件名含中文、反爬风险 |
| | | | | |

**落地建议**：
- **先本地、后联网**：方法 1（XMP）→ 方法 2（DOI→ CrossRef/Citoid，公开 API）→ 方法 3（知网，仅在开关开启时）。
- **公开 API 首选**：DOI 走 CrossRef 或 Citoid（推荐先用 Citoid 拿 BibTeX 再解析，或直接 CrossRef 的 CSL-JSON，与本插件模板字段最贴合）。
- **中文策略（开关）**：`中文检索` 默认关闭。仅当用户开启时，才调用知网检索补中文本地化；失败不影响主流程（回退到公开 API 或仅存 PDF）。
- **PDF 文本层**：用 Node 的 PDF 解析库（`pdf-parse`/`pdfjs-dist`）提取前几页，正则找 DOI/标题。
- **中文姓名归一化**：把中文作者名拆成 family/given，供模板 `{{range .authors}}` 复用。

### 5.E 直接导入 PDF 的流程（时序）

```
用户选本地 PDF
   │
   ▼
MetadataExtractor
  1. 读 XMP / 文档属性（本地）
  2. 提取前几页文本 → 正则找 DOI/标题
  3. 公开 API 查元数据（首选 CrossRef / Citoid，免 key）
  4. 若"中文检索"开关开启：文件名中文 → 知网检索（可选中一个最匹配结果）
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
| 元数据模板路径 | 元数据区模板（创建+变更时重渲染） | `/data/templates/paper-meta.md` |
| 笔记模板路径 | 笔记区模板（仅创建时一次） | `/data/templates/paper-note.md` |
| 开箱默认模板 | 首次运行是否写入内置模板 | 开启 |
| 编辑元数据 UI | 插件自建"编辑元数据"对话框（隐藏字段的唯一修改入口） | 开启（必需） |
| PDF 元数据回退顺序 | 直接导入 PDF 时的提取顺序 | XMP → DOI/Citoid → 中文检索 |
| 中文检索（知网） | 是否启用中文（知网）元数据增强；默认关闭 | 关闭（默认） |

## 七、工作流（完整时序）

**入口 A：浏览器 Connector**
1. **插件 onload**：读取设置 → 启动 ConnectorServer（监听 23119）→ 检查默认模板是否存在，不存在则写入。
2. **用户在浏览器点击 Zotero Connector** → 扩展 `ping` 通过（插件返回握手数据）→ `saveItems` 发送 item → 插件登记会话。
3. **扩展逐附件 POST `/connector/saveAttachment`** → 插件把附件写临时目录并记录进度。
4. 会话完成后 ConnectorServer `emitCustomEvent('zotero-item-received', {item, files})`。
5. **ItemProcessor** 消费事件：
   - 所有附件 `/api/asset/upload` 转存到思源，拿回 `assets/...` 地址；
   - 组装 `zoteroData` → `/api/template/render` 同时渲染**元数据区 + 笔记区**两份模板；
   - `/api/filetree/createDocWithMd` 创建文档（正文 = 元数据区 + 笔记区）；
   - `/api/attr/setBlockAttrs` 对文档根块写入**隐藏字段**（全部元数据，`custom-*`）。
6. **元数据变更时**（见 4.7）：插件重渲染"元数据区"模板，`updateBlock` 刷新对应区块；笔记区不参与。
7. **用户卸载插件**：`onunload` 关闭服务器、清临时目录。

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
8. **`setBlockAttrs` 无属性变更事件**：Issue #17179 —— 修改块属性不会触发 `savedoc`。**但这不影响本插件**：因隐藏字段唯一修改入口是插件 UI，改动必经过插件，插件主动刷新模板区即可（见 4.7(2)）。仅当未来允许用户直接在思源面板改属性时才需兜底。
9. **`updateBlock` 会清空块属性**：直接 `updateBlock` 更新元数据区会丢该块原有属性，需 `getBlockKramdown` 取回内联属性一并传回，或用 `/api/transactions` / `protyle` 事务。
10. **`setBlockAttrs` 的转义 bug**（Issue #6198）：API 写入的属性值读取时可能被 HTML 转义，某些值需 `htmlDecode` 处理。

## 九、待办（实现前的 confirm 项）

- [ ] 实测思源桌面版 `window.require` / Electron 环境下能否启动 Node `http.server`；
- [ ] 确认获取思源**工作空间绝对路径**的方式（渲染模板需要）；
- [ ] 用 curl 验证 `/api/template/render` 在本机思源可用、字段映射正确；
- [ ] 在思源插件运行环境里实测 Node 的 PDF 解析库能否提取文本（决定直接导入 PDF 的可行性）；
- [ ] 实测"插件 UI 改隐藏字段 → 重渲染元数据模板区 → updateBlock 刷新"这条链路是否顺畅（这是元数据自动更新的核心路径）；
- [ ] 实测 `updateBlock` 更新元数据区时，如何用 `getBlockKramdown` 保留块属性（避免数据丢失）。

## 参考

- `../docs/zotero-connector-protocol.md` — Zotero Connector 协议
- `../docs/biblib-zotero-connector-core.md` — BibLib 实现参考
- `../docs/siyuan-kernel-api.md` — 思源内核 API（createDocWithMd 等）
- `../docs/siyuan-plugin-dev-guide.md` — 思源插件开发指南
- https://github.com/l0o0/jasminum — 茉莉花（中文文献元数据增强）源码参考
- https://www.zotero.org/support/adding_items_to_zotero — Zotero PDF 元数据提取说明
