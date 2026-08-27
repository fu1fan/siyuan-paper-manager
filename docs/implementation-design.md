# siyuan-paper-manager 实现设计

> **模板方案决策**：采用 **思源原生模板片段**（方案 A，用户已确认）。
> 模板**随插件打包**（位于 `data/plugins/{插件名}/templates/`），插件通过内核 API `POST /api/template/render` 让思源渲染填充，再调 `createDocWithMd` 创建文档。模板不写入 `data/templates`，随插件安装/更新/卸载自动管理。

> **技术栈决策**：**Vite + TypeScript**。工程骨架参照社区主流模板（`frostime/plugin-sample-vite` 或 `siyuan-note/plugin-sample-vite-svelte`），支持热重载与 GitHub Action 自动打包。

## 〇、工程结构（Vite + TS）

```
siyuan-paper-manager/
├── src/
│   ├── index.ts                # 插件入口（Plugin 子类，注册命令/UI/事件）
│   ├── connector-server.ts     # 能力1：监听 23119 的 Zotero Connector 服务器
│   ├── item-processor.ts       # 能力1/2/3：统一消费来源，渲染+建文档+写隐藏字段
│   ├── metadata-extractor.ts   # 能力3：PDF 元数据提取（XMP→DOI→中文）
│   ├── pdf2zh-service.ts       # 能力4：调 pdf2zh CLI（child_process + os.tmpdir）
│   ├── template-render.ts      # 模板读取+render 封装（getWorkspaceInfo 取绝对路径）
│   ├── settings.ts             # Setting 面板（4 Tab）
│   ├── i18n/                   # 国际化
│   └── ui/                     # Dialog（导入/编辑元数据）、元数据页渲染
├── templates/
│   ├── paper-meta.md           # 元数据区模板（随插件打包）
│   └── paper-note.md           # 笔记区模板
├── plugin.json
├── vite.config.ts
└── package.json
```

## 一、目标功能（四件事）

1. **保存 Zotero 浏览器端插件发送的所有文件**（PDF、HTML 快照、toc 页等）。
2. **把论文文档升级为元数据页**（隐藏字段 + 元数据模板区 + 一次性笔记区），见能力 2。
3. **直接导入本地 PDF**：用户主动选择本地 PDF 文件导入，插件自动提取其元数据（含中文文献），再走模板流程保存。
4. **论文翻译**：调用本地额外安装的 `pdf2zh` 命令行工具，根据隐藏字段定位论文 PDF 附件，生成单语/双语翻译版，并更新元数据模板区中的翻译文档链接。

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
│  4. 写隐藏字段 → /api/attr/setBlockAttrs      │
└───────────────┬─────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────┐
│  PdfTranslator  (能力 4：翻译)               │
│  按隐藏字段定位 PDF 附件 → 调 pdf2zh CLI      │
│  → 生成 mono/dual 翻译版 → 回填元数据模板区   │
└─────────────────────────────────────────────┘
```

> 两条输入入口（浏览器 Connector、PDF 直接导入）最终汇合到同一套 `ItemProcessor`；翻译则作为独立能力，对任意已存在的论文元数据页触发。

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

**决策（已确认）**：附件**格式化到元数据模板**展示，不额外另立 UI。做法：

- 上传成功后，把附件地址写进隐藏字段 `custom-paper-data` 的 `attachments[]`，并作为模板变量 `attachments[]` 传给 `render`，在元数据模板区渲染成链接（如 `- [PDF](assets/xxx.pdf)`）；
- 同时用文档/块属性 `data-assets` 记录附件地址，防止"清理未引用资源"误删（见风险 #4）；
- 附件路径写入 Markdown 资源链接（`assets/xxx.pdf`），让思源识别为附件、可直接点击。

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

### 4.2 模板文件方案（纯随插件打包，已确认）

> **决策（已确认）**：默认模板**纯随插件打包**，不写入 `data/templates/`。用户不可自定义，始终用插件内置版本。这样模板的**安装 / 更新 / 卸载**完全跟随插件生命周期自动管理，零残留、无同步冲突。

模板放在**插件安装目录** `data/plugins/{插件名}/templates/`，打包时用 copy 插件随包发布：

```
data/plugins/siyuan-paper-manager/
├── templates/
│   ├── paper-meta.md      # 元数据区模板（创建+变更时重渲染）
│   └── paper-note.md      # 笔记区模板（仅创建时一次）
├── index.js
└── plugin.json
```

**生命周期（自动）**：
- **安装**：插件目录出现，模板随之出现。
- **更新**：集市下载新版本 → 整体覆盖插件目录，模板**自动更新为带的新版本**。
- **卸载**：插件目录被删，模板随之删除。
- **同步**：模板属于插件数据，不参与笔记云同步，避免跨设备覆盖冲突。

**读取模板**：通过 URL `/plugins/{插件名}/templates/paper-meta.md`，或用内核 `/api/file/getFile` 按 `data/plugins/...` 路径读取。

| 模板文件 | 用途 | 渲染时机 |
|---|---|---|
| `paper-meta.md` | 生成"元数据模板区"内容 | 创建 + 元数据变更时重渲染 |
| `paper-note.md` | 生成"笔记模板区"内容 | 仅创建时一次 |

> 创建文档时可把两段拼成一份 Markdown 一次性 `createDocWithMd`；此后更新只重渲染 `paper-meta` 对应块。

### 4.3 渲染链路（创建时，复用思源模板引擎）

```ts
import { request } from "siyuan";        // 或 this.app 提供的请求方法
import pathResolver from "./utils";      // 见下方：解析插件工作空间路径

// 0. 组装数据 & 写入隐藏字段（单字段 JSON → base64，见 4.7(1)）
const dataB64 = btoa(unescape(encodeURIComponent(JSON.stringify(customPaperData))));
await request("/api/attr/setBlockAttrs", { id: docId, attrs: { "custom-paper-data": dataB64, "custom-citekey": ..., "custom-doi": ... } });

// 1. 读取模板内容（模板随插件打包，位于插件安装目录；走内核 API，禁止 fs）
//    两种读法：① URL /plugins/{插件名}/templates/xxx.md（前端 fetch）；② /api/file/getFile 按 data/plugins/{插件名}/templates/xxx.md
const metaMd = (await request("/api/file/getFile", { path: `/data/plugins/${pluginName}/templates/paper-meta.md` })).data;
const noteMd = (await request("/api/file/getFile", { path: `/data/plugins/${pluginName}/templates/paper-note.md` })).data;

// 2. 渲染模板：传模板绝对路径 + JSON 数据，思源返回渲染后的 Markdown
const render = async (path:string, data:object) =>
  (await request("/api/template/render", { path, data: JSON.stringify(data) })).data;

// 注意：render 需要模板文件的《绝对路径》（含工作空间前缀）。
// 插件安装目录在 {工作空间}/data/plugins/{插件名}/templates/，需先取工作空间绝对路径再拼。
const wsAbsPath = (await request("/api/system/getWorkspaceInfo", {})).data?.workspaceDir;
//   ↑ 官方内核 API，返回 data.workspaceDir = 工作空间根目录绝对路径（需管理员权限/Token）。再拼 /data/plugins/…
const metaRendered = await render(`${wsAbsPath}/data/plugins/${pluginName}/templates/paper-meta.md`, zoteroData);
const noteRendered = await render(`${wsAbsPath}/data/plugins/${pluginName}/templates/paper-note.md`, zoteroData);

// 3. 创建文档（正文 = 元数据区 + 笔记区）
await request("/api/filetree/createDocWithMd", {
  notebook, path: "/文献库/xxx", markdown: `${metaRendered}\n\n${noteRendered}`, title: docTitle,
});
```

> **模板内容读取**：模板随插件打包，故用 `/api/file/getFile` 按插件目录路径读取；`render` 渲染时需要 `{工作空间}/data/plugins/{插件名}/templates/xxx.md` 的**绝对路径**（含工作空间前缀），需先获取工作空间绝对路径。
> **`zoteroData` 的来源**：读取隐藏字段 `custom-paper-data` 的 base64 → 解码 → `JSON.parse` → 归一化成模板变量结构（见 4.4）。渲染前才做这种映射。

> **`render` 接口细节**（重要）：
> - `data` 必须是 **JSON 字符串**，模板内用 `{{.key}}` 或 `.action{.key}` 访问；
> - 模板引擎支持 Go 模板 + Sprig：条件 `if`、循环 `range`、`now` 日期、`list` 等；
> - 用 `.action{...}` 而非 `{{...}}` 避免与嵌入块语法冲突；
> - 该接口有管理员权限校验，且需思源版本 ≥ 3.1.16（规避 renderSprig SSTI 漏洞）。
> - **渲染路径是绝对路径**（含工作空间前缀），而 `createDocWithMd` 的 `path` 是仓库内相对 hpath（`/` 开头），两者不要混。

### 4.4 模板变量协议（给 Zotero item → 模板的上下文）

> **双层字段设计**：
> - **存储层（`custom-paper-data`）**：保留 **Zotero 全字段**（见下方盘点），忠实记录，不裁剪。
> - **模板层（喂给 `render`）**：**只需字段子集**——仅挑模板展示需要的字段，不要求覆盖全部 Zotero 字段。缺失的字段在模板变量里留空，模板用 `{{if}}` 条件渲染避免出现空行。

**Zotero 字段盘点（存储层全量保留）**：Zotero 条目字段按类型有差异，通用字段覆盖绝大多数场景。核心字段如下（`/api/itemFields` 全量，此处列常用）：
`itemType`、`title`、`shortTitle`、`creators[]`（firstName/lastName/name/creatorType）、`date`、`accessDate`、`abstractNote`、`language`、`url`、`extra`、`tags`、`bookTitle`、`publicationTitle`（期刊）、`journalAbbreviation`、`volume`、`issue`、`pages`、`numPages`、`edition`、`publisher`、`place`、`series`、`seriesNumber`、`DOI`、`ISBN`、`ISSN`、`citationKey`、`archive`、`libraryCatalog`、`rights`、`dateAdded`、`dateModified`。

**模板所需字段子集**（模板层，按"文献元数据页展示"所需挑选）：

| 模板字段 | 来源 Zotero 字段 | 说明 |
|---|---|---|
| `itemType` | itemType | 条目类型 |
| `title` | title | 标题 |
| `authors[]` | creators | 归一化为 `{family,given,creatorType}` |
| `date` / `dateParts` | date | 日期（原始+结构化） |
| `journal` | publicationTitle / bookTitle | 期刊/书名 |
| `volume` `issue` `pages` | 同名 | 卷期页码 |
| `doi` | DOI | 标识符 |
| `isbn` `issn` | ISBN/ISSN | 标识符 |
| `url` | url | 链接 |
| `publisher` | publisher | 出版社 |
| `abstract` | abstractNote | 摘要 |
| `tags[]` | tags | 标签 |
| `attachments[]` | 附件位置 | 由插件填充 |
| `translationMono/Dual` | 翻译版 | 由插件填充 |
| `citekey` | citationKey/生成 | 引用键 |

> 字段取舍原则：**模板层只放"文献元数据页"实际要显示的**，其余 Zotero 字段（`extra`、`archive`、`rights` 等）完整保留在存储层 `custom-paper-data`，作为隐藏字段存档、供查重/扩展，不强制渲染。

**来源**：模板变量实际是**从隐藏字段 `custom-paper-data` 的 base64 JSON 解析后归一化得到**的视图，用于喂给 `/api/template/render`。核心字段名沿用 Zotero 原始名（便于与 Zotero 数据对齐），渲染前再做一次"Zotero 原始字段 → 模板友好字段"的映射（如 `creators`→`authors`、`abstractNote`→`abstract`、`DOI`→`doi`）。

```jsonc
{
  "itemType": "journalArticle",          // 条目类型
  "title": "……",
  "authors": [                            // 由 creators 归一化
    { "family": "Smith", "given": "Alice", "creatorType": "author" }
  ],
  "date": "2024-06-15",
  "dateParts": [2024, 6, 15],
  "abstract": "……",
  "doi": "10.xxxx/xxxxx",
  "isbn": "……",
  "issn": "……",
  "url": "https://……",
  "journal": "……",                        // publicationTitle
  "volume": "12",
  "issue": "3",
  "pages": "123-145",
  "publisher": "……",
  "tags": ["tag1", "tag2"],
  "attachments": [                        // 已上传的附件地址
    { "title": "PDF", "url": "assets/xxx.pdf", "mimeType": "application/pdf" }
  ],
  "translationMono": "assets/xxx-mono.pdf",   // 单语翻译版地址（pdf2zh 生成后回填，可空）
  "translationDual": "assets/xxx-dual.pdf",   // 双语对照版地址（pdf2zh 生成后回填，可空）
  "citekey": "smith2024alice"             // 引用键（可选，生成）
}
```

> 存储时（`custom-paper-data`）保留 Zotero 原始字段名；渲染模板前再映射成上面的模板变量结构。参见 4.7(1) 的 JSON 结构。

模板示例——元数据区（`data/plugins/{插件名}/templates/paper-meta.md`）：

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

模板示例——笔记区（`data/plugins/{插件名}/templates/paper-note.md`，仅创建时渲染一次）：

```markdown
## 阅读笔记
<!-- 在这里记录你的阅读/思考，此区域不会被自动覆盖 -->

- 一句话总结：
- 关键论点：
- 启发：
```

### 4.5 引用键（citekey）生成与文档命名

**决策（已确认）**：从 `firstAuthor family` + `year` + `title首词` 拼，如 `smith2024alice`，存入隐藏字段 `citekey`。**不处理 citekey 冲突**（两个不同论文生成相同 citekey 时，不主动规避，靠文档路径/标题区分）。

**文档命名**：**`citekey - 论文标题`**（如 `smith2024alice - Example Article Title`）。作为 `createDocWithMd` 的文档名（hpath 末级）与标题。

### 4.6 去重 / 复用已有文档

`createDocWithMd` 用相同 `path` 重复调用**不会覆盖**（会新建带随机后缀的文档）。为避免重复导入同一篇文献：

- 先按 `citekey` 或 DOI 查重（用 `/api/query/sql` 查 `blocks` 的属性，或用 `/api/filetree/getIDsByHPath` 按路径查）；
- 已存在时，可选：跳过 / 追加 `/api/block/appendBlock` / 弹窗询问。
- 注：只在导入前主动查重提示；不做 citekey 冲突自动规避（见 4.5）。

### 4.7 隐藏字段区 + 元数据自动更新的实现方案（关键：可行的边界）

#### (1) 隐藏字段区——存所有元数据（单字段 JSON + base64）

**设计决策（已确认）**：**不要一个插件占用多个隐藏字段**。把所有论文元数据、附件位置、插件辅助字段打包成一个 **JSON 对象，转 base64 后存入单个自定义属性**。这样避免占用大量 `custom-*` 属性（思源自定义属性名仅允许英文字母数字，且多字段难一致），也便于 JSON 结构扩展。

**字段名约定**：
- **主字段**：`custom-paper-data` —— 存 base64 编码的整包 JSON（论文全部元数据 + 附件 + 辅助字段）。
- **索引字段**（可选，但强烈建议保留少数几个固定字段供 SQL 查询/去重/模板简化引用）：
  - `custom-citekey`：引用键
  - `custom-doi`：DOI
  - `custom-attachment-pdf`：主 PDF 附件地址（pdf2zh 定位用）
  - `custom-translation-mono` / `custom-translation-dual`：翻译版地址
- **命名空间前缀**：全部用 `custom-paper-` 统一前缀，避免与其他插件（如属性管家、番茄钟等用 `custom-*` 的插件）冲突。若将来担心不同用户自定义属性名撞车，可把前缀中的 `paper` 换成更独特的插件标识（如 `custom-si-paper-...`）。

> **版本字段**：建议在 JSON 里加 `version`（如 `schemaVersion: 1`），便于后续结构演进与迁移。

**为什么不是纯单一字段**：若所有信息都塞进一个 base64 字段，思源的 SQL（`/api/query/sql` 查 `attributes` 表）就无法直接按 citekey/DOI 检索或去重。因此**主字段存完整包，另保留少量固定索引字段**供查询与定位——"少占字段"不是"只用一个"，而是避免为每个元数据项都开一个字段。

**base64 编码**：JS 可用 `btoa(unescape(encodeURIComponent(json)))` 处理含中文/UTF-8 的 JSON；读取时 `decodeURIComponent(escape(atob(b64)))`。因整体是 ASCII 字符串，存入思源块属性时也避开转义问题（但仍需注意 Issue #6198 的转义 bug）。

> **属性值长度上限（已调研）**：思源属性的 `value` 存于 SQLite `attributes` 表，字段类型 TEXT，受 SQLite `SQLITE_MAX_LENGTH` 限制，默认约 **1GB**。思源未对块属性值额外设置更小的硬上限；base64 膨胀后的 JSON 长度对实际论文元数据而言远低于该上限，**不存在长度瓶颈**。唯一需留意的是界面内输入超长值体验不佳，但本方案走 API 写入不受此影响。

**存取流程**：
```
写：JSON.stringify(custom-paper-data 对象) → base64 编码 → setBlockAttrs(custom-paper-data, b64)
读：getBlockAttrs → b64 → base64 解码 → JSON.parse → 得到完整结构化元数据
```

**custom-paper-data 的 JSON 结构**（详细字段见 4.4）：
```jsonc
{
  // —— Zotero 网页端原始字段（尽量保留原始键名） ——
  "itemType": "journalArticle",
  "title": "……",
  "creators": [ { "firstName": "……", "lastName": "……", "creatorType": "author" } ],
  "date": "……",
  "abstractNote": "……",
  "dois": "10.xxxx",
  "isbn": "……",
  "issn": "……",
  "url": "……",
  "journalAbbreviation": "……",
  "volume": "……", "issue": "……", "pages": "……",
  "publisher": "……",
  "language": "……",
  "tags": [ { "tag": "……" } ],
  "extra": "……",
  // —— 附件位置 ——
  "attachments": [ { "title": "PDF", "url": "assets/xxx.pdf", "mimeType": "application/pdf", "localPath": "……" } ],
  // —— 插件辅助字段 ——
  "citekey": "smith2024alice",
  "noteSection": "……",
  "translation": {
    "mono": "assets/xxx-mono.pdf",
    "dual": "assets/xxx-dual.pdf"
  },
  "importedAt": "2026-08-27T00:00:00.000Z",
  "source": "zotero-connector"   // 或 "pdf-import" / "manual"
}
```

> 保留 Zotero 原始字段名（`creators`、`abstractNote`、`dois`）是为了兼容 Zotero 数据，`4.4` 模板变量用的归一化字段在渲染前再映射（`authors`、`abstract` 等）。

#### (1.5) 索引字段与主字段的分工

| 字段 | 用途 | 是否冗余主字段 |
|---|---|---|
| `custom-paper-data` | 完整数据包（base64 JSON） | 是（唯一权威来源） |
| `custom-citekey` | 去重 / 引用 / SQL 查询 | 冗余（作索引） |
| `custom-doi` | 去重 / 查重 / 模板 | 冗余（作索引） |
| `custom-attachment-pdf` | pdf2zh 定位原 PDF | 冗余（作索引） |
| `custom-translation-mono` / `-dual` | 翻译链接快速引用 | 冗余（作索引） |

> 冗余字段以主字段为准，插件修改数据后同步更新索引字段；避免主字段与索引字段不一致时以主字段为权威源。

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

**兜底策略（已确认）**：若元数据提取失败/不完整（如纯扫描 PDF、公开 API 无匹配、中文未被识别），仍**自动创建一篇只有"标题 + DOI"（若识别到）的元数据页**，不丢弃。标题缺省时用文件名占位；其余字段留空，模板用条件渲染避免空行；用户可稍后通过"编辑元数据"补全。

## 六、能力 4：论文翻译（调用本地 pdf2zh 命令行工具）

### 6.A 原理与目标

依赖用户本地额外安装的 **pdf2zh**（PDFMathTranslate）命令行工具，对论文 PDF 进行翻译。功能目标：

- 通过**隐藏字段**定位论文的 PDF 附件位置；
- 调用 `pdf2zh` 对 PDF 翻译，生成**单语翻译版**（`…-mono.pdf`）与**双语版**（`…-dual.pdf`）；
- 重新格式化论文的元数据模板区，**更新/新增翻译文档的链接**。

### 6.B pdf2zh 关键信息（来自其 README）

**安装方式**（任选其一，需 Python 3.11–3.12）：

```bash
# uv
uv tool install --python 3.12 pdf2zh
# pip
pip install pdf2zh
```

**基本用法**——默认生成 `example-mono.pdf`（单语译版）和 `example-dual.pdf`（双语版）到当前目录：

```bash
pdf2zh document.pdf
```

**常用 CLI 选项**（插件需用到的）：

| 选项 | 作用 | 示例 |
|---|---|---|
| `files` | 本地文件路径 | `pdf2zh ~/local.pdf` |
| `-o` | 输出目录 | `pdf2zh example.pdf -o output` |
| `-li` | 源语言（默认 en） | `pdf2zh example.pdf -li en` |
| `-lo` | 目标语言（默认 zh） | `pdf2zh example.pdf -lo zh` |
| `-s` | 翻译服务（默认 google） | `pdf2zh example.pdf -s deepl` |
| `-p` | 部分翻译（页码） | `pdf2zh example.pdf -p 1` |
| `-t` | 多线程数 | `pdf2zh example.pdf -t 1` |
| `--dir` | 批量翻译目录 | `pdf2zh --dir /path/to/` |
| `--config` | 配置文件 | `pdf2zh --config config.json` |
| `--mode` | `fast`(默认 v1) / `precise`(v2 实验) | `pdf2zh --mode precise example.pdf` |

**输出文件命名规则**：
- `{原文件名}-mono.pdf` —— 纯翻译版
- `{原文件名}-dual.pdf` —— 双语对照版

**注意**：依赖下载 AI 模型（DocLayout-YOLO），国内网络需设 `HF_ENDPOINT=https://hf-mirror.com`。默认 Google 翻译服务，可换 deepel/openai 等。

### 6.C 插件如何调用 pdf2zh

pdf2zh 是**独立 CLI 子进程**，与插件是两个进程。插件用 Node 的 `child_process` 执行：

```ts
import { execFile } from "child_process";
import { promisify } from "util";
const execFileP = promisify(execFile);

// 1. 根据隐藏字段定位 PDF 附件路径
const pdfPath = await resolvePdfFromHiddenField(paperDocId);   // 见 6.D

// 2. 调 pdf2zh，输出到临时/指定目录
const opts = ["-o", outputDir, ...(settings.pdf2zhArgs || []), pdfPath];
// 例如默认：["-o", outputDir, pdfPath]  → 生成 {name}-mono.pdf / {name}-dual.pdf
const { stdout, stderr } = await execFileP(settings.pdf2zhPath || "pdf2zh", opts);
```

**要点**：
- 插件不会打包 pdf2zh（体积大、需 Python），只**检测本地是否安装**（`which pdf2zh` / 可执行路径设置），未安装时提示用户按 README 安装。
- **中间文件存系统临时目录**（决策）：pdf2zh 生成的 `-mono.pdf`/`-dual.pdf` 先写入**系统临时目录**（Node `os.tmpdir()`，跨平台自动处理：macOS/Linux `/tmp`、Windows `%TEMP%`、用户缓存目录等；注意不同系统路径分隔符与返回路径的处理）。翻译完成后从 tmp 读回，再 `/api/asset/upload` 转存到思源 `assets/`。**不担心遗留临时文件**——tmp 目录会被系统/下次运行清理；若需可配置翻译工作子目录（如 `${os.tmpdir()}/siyuan-paper-manager/`）做隔离。
- CLI 是**同步阻塞**的（翻译耗时），插件侧需放入异步任务（后台执行），完成后用事件/通知回填元数据模板区，避免卡死 UI。

### 6.D 通过隐藏字段定位 PDF 附件

从论文元数据页的隐藏字段读取 PDF 附件地址。**权威源是主字段 `custom-paper-data` 里的 `attachments` / `translation`；索引字段只是冗余，便于快速读取与 SQL 定位**：

| 字段 | 含义 |
|---|---|
| `custom-paper-data`（权威） | 主包 JSON，内含 `attachments`（原 PDF 位置）、`translation.mono` / `translation.dual` |
| `custom-attachment-pdf`（索引） | 论文主 PDF 地址（冗余，pdf2zh 定位用） |
| `custom-translation-mono`（索引） | 单语翻译版地址（冗余） |
| `custom-translation-dual`（索引） | 双语翻译版地址（冗余） |

定位流程：
1. 读取主字段 `custom-paper-data`（base64 解码→JSON），取 `attachments` 找到原 PDF 地址（或直接读索引 `custom-attachment-pdf`）；
2. 转成磁盘路径（思源工作空间 + 相对地址），交给 pdf2zh；
3. 翻译完成后，`/api/asset/upload` 把 `…-mono.pdf` / `…-dual.pdf` 上传回思源，得到 `assets/….pdf` 地址；
4. **更新主字段**（把 `translation.mono`/`translation.dual` 写入 `custom-paper-data` 的 JSON 并重新 base64），同时**同步索引字段** `custom-translation-mono` / `custom-translation-dual`；
5. 重渲染元数据模板区。

> 主字段与索引字段的一致性：以主字段为权威，写数据时一并更新索引字段，避免不一致。

### 6.E 重渲染元数据模板区，更新翻译链接

翻译生成、回填隐藏字段后，把新的翻译链接写入元数据模板区：

- 把 `custom-translation-mono` / `custom-translation-dual` 作为模板变量传入 `/api/template/render`；
- `paper-meta.md` 里对应新增"翻译版本"区块，如：

```markdown
## 翻译版本
{{if .translationMono}}- [单语翻译版]({{.translationMono}})
{{end}}{{if .translationDual}}- [双语对照版]({{.translationDual}})
{{end}}
```

- 用 `/api/block/updateBlock` 刷新元数据区区块（注意用 `getBlockKramdown` 保留块属性，见能力 2 的 4.7）。

### 6.F 翻译功能触发入口

- 在论文元数据页文档块菜单/右键，或插件命令面板提供"翻译本文档"命令；
- 翻译是长耗时异步任务，需显示进度/完成通知，翻译完成后自动回填链接并刷新模板区。

## 七、需要用户配置项（设置面板）

| 设置项 | 说明 | 默认值 |
|---|---|---|
| Zotero 端口 | 监听端口 | `23119` |
| 目标笔记本 | 文献保存到哪个笔记本 | 用户选择（`/api/notebook/lsNotebooks` 列出） |
| 存放路径 | 笔记本内文档树相对路径（hpath） | `/文献库` |
| 附件目录 | `assetsDirPath` | `/assets/` |
| 元数据模板容器 | 只读说明（模板随插件打包） | — |
| 编辑元数据 UI | 插件自建"编辑元数据"对话框（隐藏字段的唯一修改入口） | 开启（必需） |
| PDF 元数据回退顺序 | 直接导入 PDF 时的提取顺序 | XMP → DOI/Citoid → 中文检索 |
| 中文检索（知网） | 是否启用中文（知网）元数据增强；默认关闭 | 关闭（默认） |
| pdf2zh 路径 | 本地 pdf2zh 可执行文件路径 | `pdf2zh`（PATH 中） |
| pdf2zh 翻译参数 | 传给 pdf2zh 的 CLI 参数（如 `-s deepl -li en -lo zh`） | 空（用默认） |
| pdf2zh 源/目标语言 | `-li` / `-lo` | `en` / `zh` |
| 翻译输出目录 | 生成 mono/dual 的临时/落盘目录 | `/assets/` |
| 是否生成双语版 | 是否需要 `…-dual.pdf` | 开启 |

## 八、工作流（完整时序）

**入口 A：浏览器 Connector**
1. **插件 onload**：读取设置 → 启动 ConnectorServer（监听 23119）。模板随插件打包，无需写入。
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

**入口 C：论文翻译（PDF → pdf2zh）**
1. 用户在论文元数据页触发"翻译本文档"，插件读取隐藏字段 `custom-attachment-pdf` 定位原 PDF；
2. 后端异步执行 `pdf2zh`（参数见设置），生成 `…-mono.pdf` / `…-dual.pdf`；
3. 翻译完成后 `/api/asset/upload` 回传思源，写 `custom-translation-mono` / `custom-translation-dual`；
4. 用新翻译链接重渲染元数据模板区（`/api/template/render` + `updateBlock`），更新"翻译版本"区块；
5. 通知用户完成。

> 三条入口 (A/B/C) 最终都落点于同一套元数据页与模板刷新逻辑。

## 九、关键风险与注意

1. **端口冲突**：23119 与 Zotero 桌面版冲突，使用插件时须关闭 Zotero；只绑定 `127.0.0.1`，禁公网。
2. **`window.require` 可用性**：思源桌面版（Electron）是否能像 Obsidian 一样在渲染进程用 `window.require` 取 Node 模块，**需实测确认**；若不可用，需另找在思源里启动本地 http server 的方法。
3. **模板 `render` 需要绝对路径**：已确认用官方内核 API `POST /api/system/getWorkspaceInfo`（返回 `data.workspaceDir`，需管理员 Token），再拼 `/data/plugins/{插件名}/templates/xxx.md`。注意该 API 需管理员权限，前端插件需带 Token 调用。
4. **附件子目录 bug**（issue #7454）：`/api/asset/upload` 用子文件夹时返回地址不含子文件夹名，需代码拼接。
5. **版本安全**：思源 ≥ 3.1.16，规避 renderSprig / asset upload 的历史漏洞。
6. **PDF 文本提取依赖**：直接导入 PDF 需要从 PDF 提取前几页文本，需引入 PDF 解析库（`pdf-parse`/`pdfjs-dist`）；纯扫描/图片型 PDF 无文字层，提取会失败，需提示用户手动或改用 Connector。
7. **知网反爬**：若实现中文知网检索（茉莉花式），无官方 API、依赖浏览器模拟 + cookie 处理，易受知网前端改版影响，不建议放入第一版核心路径。
8. **`setBlockAttrs` 无属性变更事件**：Issue #17179 —— 修改块属性不会触发 `savedoc`。**但这不影响本插件**：因隐藏字段唯一修改入口是插件 UI，改动必经过插件，插件主动刷新模板区即可（见 4.7(2)）。仅当未来允许用户直接在思源面板改属性时才需兜底。
9. **`updateBlock` 会清空块属性**：直接 `updateBlock` 更新元数据区会丢该块原有属性，需 `getBlockKramdown` 取回内联属性一并传回，或用 `/api/transactions` / `protyle` 事务。
10. **`setBlockAttrs` 的转义 bug**（Issue #6198）：API 写入的属性值读取时可能被 HTML 转义，某些值需 `htmlDecode` 处理。
11. **pdf2zh 依赖本地环境**：插件不打包 pdf2zh，需用户自行安装（Python 3.11–3.12 + `pip install pdf2zh`）。未安装或路径不对时需给出明确提示。
12. **pdf2zh 首次运行需下载 AI 模型**：依赖 DocLayout-YOLO 模型，国内网络可能失败，需设 `HF_ENDPOINT=https://hf-mirror.com` 或配置镜像。
13. **翻译是长耗时 CLI**：`pdf2zh` 同步阻塞、耗时较长，插件需在后台/异步执行并显示进度，避免卡死 UI；同时注意同一时间不宜并发多个翻译任务。
14. **模型/服务键**：若配置非默认翻译服务（`-s openai` 等）需相应 API key，插件只透传参数不落地管理 key。

## 十、待办（实现前的 confirm 项）

- [ ] **确认 `window.require` / Node 子进程能力**：(这是整个插件技术地基，最优先) 在思源桌面版插件运行时实测能否用 `window.require` 拿 Node 模块（`http`、`child_process`），从而启动监听 23119 的本地服务器 + 调 pdf2zh。**验证方法**：在插件 `onload` 写入 `console.log(typeof window.require)`，或直接 `window.require('child_process')` 试 `execFile`；若为 undefined，需改用思源是否暴露的其他通道（如内核插件 `kernel.js` 在 Node 侧运行）。
- [x] 思源**工作空间绝对路径** → 已确认：`POST /api/system/getWorkspaceInfo` 返回 `data.workspaceDir`（需管理员 Token）。
- [x] 思源**块属性值长度上限** → 已确认：SQLite TEXT 类型，受 `SQLITE_MAX_LENGTH` 限制约 1GB，无额外小上限，base64 后无长度瓶颈。
- [ ] 用 curl 验证 `/api/template/render` 在本机思源可用、字段映射正确；
- [ ] 在思源插件运行环境里实测 Node 的 PDF 解析库能否提取文本（决定直接导入 PDF 的可行性）；
- [ ] 实测"插件 UI 改隐藏字段 → 重渲染元数据模板区 → updateBlock 刷新"这条链路是否顺畅（这是元数据自动更新的核心路径）；
- [ ] 实测 `updateBlock` 更新元数据区时，如何用 `getBlockKramdown` 保留块属性（避免数据丢失）；
- [ ] 在插件运行环境实测能否用 Node `child_process` 调 `pdf2zh` CLI，并确认生成 `-mono.pdf` / `-dual.pdf` 的命名与路径（决定翻译功能的可行性与落盘方式）。

## 参考

- `../docs/zotero-connector-protocol.md` — Zotero Connector 协议
- `../docs/biblib-zotero-connector-core.md` — BibLib 实现参考
- `../docs/siyuan-kernel-api.md` — 思源内核 API（createDocWithMd 等）
- `../docs/siyuan-plugin-dev-guide.md` — 思源插件开发指南
- https://github.com/l0o0/jasminum — 茉莉花（中文文献元数据增强）源码参考
- https://www.zotero.org/support/adding_items_to_zotero — Zotero PDF 元数据提取说明
- https://github.com/Byaidu/PDFMathTranslate — pdf2zh（本地论文翻译 CLI 工具）
