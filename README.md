# siyuan-paper-manager

面向思源笔记桌面端的论文管理插件：接收 Zotero Connector 文献与附件，以思源原生数据库管理多个论文文献库，编辑论文元数据、导出引用、导入本地 PDF，并调用本地 pdf2zh 生成翻译版本。

## 功能

- **原生数据库文献库**：每个文献库都是一个真实思源文档，内含原生数据库；数据库行绑定对应论文元数据页。
- **多个文献库**：可新建多个库并指定默认库，Connector 与本地 PDF 始终导入默认库。
- **可配置元数据列**：每个库独立选择作者、年份、来源、DOI、标签、摘要等投影字段；调整后从论文 base64 元数据全量重建。
- **项目管理**：论文可属于多个项目；项目可为纯文本，也可映射到一个思源项目文档。
- **引用导出**：支持单篇搜索或按项目导出 GB/T 7714—2015、APA 7、IEEE、BibTeX、BibLaTeX、Typst Hayagriva，以及 LaTeX/Typst 引用语法。
- **Zotero Connector 接收**：监听 `127.0.0.1:23119`，保存条目、PDF、网页快照和其他附件。
- **论文元数据页**：完整数据保存在 `custom-paper-data`；元数据摘要可刷新，阅读笔记区不会被自动覆盖。
- **本地 PDF 与翻译**：提取 PDF/XMP、Crossref、Citoid 和可选 CNKI 元数据，并可调用 pdf2zh 生成 mono/dual PDF；可选择在重新翻译成功后自动删除旧翻译资源。

## 系统要求

- 思源笔记 `>= 3.8.1`
- 桌面端或桌面窗口端
- Node.js 22+ 与 pnpm（仅开发时需要）
- 可选：Python 3.11–3.12 与 [pdf2zh](https://github.com/Byaidu/PDFMathTranslate)

> Zotero 桌面版默认也使用 `23119`，接收 Connector 数据时需关闭 Zotero，或在插件设置中修改端口。

## 首次初始化

1. 启用插件后，初始化向导自动打开。
2. 选择笔记本，填写文献库名称和路径。
3. 插件创建文献库文档、插入原生数据库并将其设为默认库。
4. 在“插件设置 → 文献库”中可新建更多库、切换默认库、配置字段和项目。

如果暂时关闭向导，下一次启动仍会提示。未设置默认文献库时，导入操作不会创建散落的论文页。

## 使用

| 命令 | 默认快捷键 |
|---|---|
| 导入本地 PDF | `⌥I` |
| 编辑当前论文元数据 | `⌥E` |
| 翻译当前论文 | `⌥T` |
| 导出当前文献库引用 | 无 |
| 环境自检 | 无 |

论文页右键菜单提供编辑、翻译和失败修复；文献库页面右键菜单提供引用导出。导出页面支持搜索标题、作者、DOI、citekey，按项目过滤，复制结果或下载 `.txt`、`.bib`、`.yaml`。

## 数据与同步规则

论文元数据页属性：

- `custom-paper-data`：base64 编码的 schema v2 JSON，是论文元数据唯一权威源。
- `custom-paper-library-id`：所属文献库文档 ID。
- `custom-paper-library-item-id`：最近一次解析到的数据库 item ID，仅作缓存。
- `custom-paper-library-sync` / `-error`：数据库投影同步状态。
- `custom-paper-citekey` / `custom-paper-doi`：查重索引。

文献库文档属性：

- `custom-paper-library-data`：base64 编码的文献库配置，包含 AV ID、数据库块 ID、字段 ID、项目映射和时间戳。

数据库是可重建投影，不是元数据编辑入口。直接删除数据库行后，“重新同步”会根据论文页恢复；真正移除论文应删除论文元数据页。数据库块损坏或被删除时，可在设置中运行“修复数据库”。

## 开发与构建

```bash
pnpm install
pnpm run check
pnpm run dev
pnpm run make-link
pnpm run package
```

构建产物位于 `dist/`。所有思源文档和数据库写入都通过 Kernel API；插件不会直接修改 `.sy` 文件或 AV 存储 JSON。

更多实现与验收说明见 [docs/development.md](docs/development.md)。
