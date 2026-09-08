# siyuan-paper-manager（论文管理）

面向思源笔记桌面端的论文管理插件：接收 Zotero Connector 文献与附件，以**思源原生数据库**管理多个论文文献库，直接在数据库中维护元数据，一键导出 GB/T 7714 / APA / BibTeX / Typst 等引用，导入本地 PDF 自动识别元数据，并调用本地 pdf2zh 生成单语/双语翻译版。

![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)
![SiYuan](https://img.shields.io/badge/SiYuan-%3E%3D3.8.1-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)

> 文献库就是一个真实文档，数据库就是它的正文——没有隐藏的黑盒存储，所有数据都在你的笔记本里，可搜索、可排序、可同步。

## 功能特性

- 📚 **原生数据库文献库**：每个文献库都是一个真实思源文档，内含原生数据库（表格视图）；每篇论文是库文档的子文档，数据库行与论文页一一绑定。
- 🗂️ **多文献库 + 项目分组**：可建多个库并指定默认库；论文可属于多个项目，项目还能绑定一个思源项目文档，一键跳转。
- ✏️ **数据库即编辑入口**：标题、作者、年份、DOI、标签、摘要等 18 个元数据列全部就绪，直接在数据库里编辑；论文页的元数据摘要一键以数据库内容重建，绝不反向覆盖你的修改。
- 🌐 **Zotero Connector 接收**：监听 `127.0.0.1:23119`，浏览器里点一下 Zotero Connector，条目、PDF、网页快照、附件全部入库，自动查重（DOI / 引用键 + 标题相似度），支持合并、新建副本。
- 📄 **本地 PDF 导入**：提取 PDF 内嵌 XMP/文档属性，结合 DOI → Crossref → Citoid 逐级识别，可选中文（知网）检索增强；多个识别候选任你挑。
- 🌍 **pdf2zh 翻译**：调用本地 pdf2zh 生成单语/双语对照 PDF，状态栏实时显示进度，多篇排队串行执行，重新翻译后可自动清理旧版本。
- 🔖 **引用导出**：GB/T 7714—2015（顺序编码 / 著者—出版年）、APA 7、IEEE、BibTeX、BibLaTeX、Typst Hayagriva，以及 LaTeX `\cite`/`\parencite`/`\textcite`、Typst `@key`/`#cite`；支持搜索、按项目过滤、复制或下载 `.txt`/`.bib`/`.yaml`。

## 界面预览

| 文献库数据库 | 论文页 |
|---|---|
| ![文献库数据库](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/library-database.png) | ![论文页](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/paper-page.png) |

| 导入本地 PDF | 引用导出 |
|---|---|
| ![导入本地 PDF](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/import-pdf.png) | ![引用导出](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/export-citations.png) |

| 顶栏快速菜单 | 插件设置 |
|---|---|
| ![顶栏快速菜单](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/quick-menu.png) | ![插件设置](https://raw.githubusercontent.com/fu1fan/siyuan-paper-manager/main/docs/assets/settings.png) |

## 安装

### 集市安装（推荐）

思源笔记 → 设置 → 集市 → 插件，搜索「论文管理」，下载并启用。

### 手动安装

1. 在 [Releases](https://github.com/fu1fan/siyuan-paper-manager/releases) 下载最新 `package.zip`；
2. 解压到 `{工作空间}/data/plugins/siyuan-paper-manager/`；
3. 重启思源，在 设置 → 集市 → 已下载 中启用。

## 系统要求

- 思源笔记 `>= 3.8.1`，**桌面端**（Windows / macOS / Linux；移动端与浏览器伺服模式不支持，因为需要 Node 集成来监听端口和调用子进程）
- 可选：Python 3.11–3.12 与 [pdf2zh](https://github.com/PDFMathTranslate/PDFMathTranslate)（仅翻译功能需要）
- Node.js 22+ 与 pnpm（仅开发时需要）

> ⚠️ Zotero 桌面版默认也占用 `23119` 端口。用本插件接收 Connector 数据时请关闭 Zotero 桌面版，或在插件设置中把端口改成其他值（同时修改 Zotero Connector 扩展的服务器地址）。

## 快速上手

1. **启用插件**，初始化向导自动打开：选择笔记本，填写文献库名称和路径；
2. 插件创建文献库文档、插入原生数据库并设为默认库（已有文献库时会自动认领，不重复打扰）；
3. 浏览器安装 [Zotero Connector](https://www.zotero.org/download/connectors)，在文献页面点击扩展图标，文献即进入默认库；
4. 或按 `⌥I`（macOS）/ `Alt+I` 导入本地 PDF，自动识别元数据后一键入库。

## 使用

### 命令与快捷键

| 命令 | 默认快捷键 | 说明 |
|---|---|---|
| 导入本地 PDF | `⌥I` | 识别元数据，多候选可选，导入默认库 |
| 刷新当前论文元数据摘要 | `⌥E` | 以数据库行为权威重建摘要区 |
| 翻译当前论文 | `⌥T` | 调用 pdf2zh，已有翻译时会先确认 |
| 导出文献库引用 | 无 | 搜索/过滤后复制或下载引用 |
| 环境自检 | 无 | 检查 Node、Connector、pdf2zh、模板环境 |

快捷键均可在 设置 → 快捷键 中修改；Windows/Linux 下 `⌥` 对应 `Alt`。

### 菜单入口

- **顶栏图标**（右侧 📄）：导入、翻译、刷新、导出、启停 Zotero 接收、环境自检、设置；
- **论文页右键**：翻译本文档、刷新元数据摘要；
- **文献库页右键**：导出文献库引用；
- **状态栏**（左下）：翻译进度与队列长度。

### 翻译配置（pdf2zh）

```bash
# 安装（任选其一）
uv tool install --python 3.12 pdf2zh
pip install pdf2zh
```

- 首次运行需下载排版模型，国内网络建议先设 `HF_ENDPOINT=https://hf-mirror.com`；
- 在 插件设置 → 翻译 中可配置路径、源/目标语言、翻译服务（google/deepl/openai…）、额外 CLI 参数、是否保留双语版、是否自动删除旧版本。

### Windows使用说明

Windows思源桌面端支持通过pip／uv安装的`pdf2zh.exe`；不支持将`.cmd`／`.bat`脚本作为翻译入口。

```powershell
# 安装（任选其一）
uv tool install --python 3.12 pdf2zh
py -3.12 -m pip install pdf2zh
# 查找入口
where.exe pdf2zh
```

安装或修改PATH后，请完全退出并重新启动思源。若自动检测失败，在“pdf2zh路径”填入查到的完整exe路径，例如`C:\Users\Alice\.local\bin\pdf2zh.exe`。路径包含空格也无需自行转义；外围成对引号会自动去除。

“额外CLI参数”支持中文、空格及Windows反斜杠路径，例如：

```text
--config "C:\Users\Alice\My Config\config.json"
```

参数保存后重新打开设置会自动补充必要的引号。普通反斜杠按字面保留；双引号前连续反斜杠采用Windows参数规则（若路径末尾为反斜杠，应在结束双引号前写成两个反斜杠），也可以用单引号包裹路径，内部反斜杠全部保留。旧版本已经吞掉反斜杠并保存的参数无法自动恢复，需要重新填写。

如果需要模型下载镜像，可在PowerShell中设置当前用户环境变量，然后完全退出并重新启动思源：

```powershell
[Environment]::SetEnvironmentVariable("HF_ENDPOINT", "https://hf-mirror.com", "User")
```

仅设置`$env:HF_ENDPOINT`只影响当前PowerShell及其之后启动的子进程，不能改变已经运行的思源环境。环境自检会运行`pdf2zh --help`，最多等待15秒；“启动检查通过”只说明CLI能启动，不代表模型下载、翻译服务或真实PDF翻译已验证。

## 数据与同步规则

**文献库文档属性** `custom-paper-library-data`：明文 JSON（schema v3），记录数据库 ID、全部字段列 ID、项目定义和时间戳。

**论文文档属性**（均为机器状态，用户无需编辑）：

- `custom-paper-attachments`：附件清单（JSON，含 SHA-256）；
- `custom-paper-translation-mono` / `-dual`：翻译产物地址；
- `custom-paper-state` / `-error`：处理状态；
- `custom-paper-library-id`：所属文献库；`custom-paper-library-sync` / `-error`：同步状态。

**权威方向**：用户可见元数据以**数据库行**为唯一权威。插件只在导入/合并时写入数据库列；修复、翻译后刷新只更新机器状态属性，绝不覆盖你在数据库中的编辑。论文页的元数据摘要区是只读展示，用 `⌥E` 随时按数据库重建。

**数据库维护**：直接删除数据库行不影响论文页，「重新同步」会按归属关系恢复缺失行、移除失效绑定并回填空标题；数据库块损坏时用「修复数据库」按记录结构重建（注意：原单元格内容随损坏的数据库一并丢失）。真正移除论文请删除论文页文档。

## 常见问题

**Q：Connector 提示连接失败 / 端口被占用？**
关闭 Zotero 桌面版（它同样监听 23119），或在插件设置中修改端口。可用「环境自检」查看监听状态。

**Q：重复导入同一篇会怎样？**
插件按 DOI、引用键 + 标题相似度查重并弹窗：取消 / 新建副本 / 合并（默认只补空字段，勾选字段才覆盖）。

**Q：移动端能用吗？**
不能。监听端口和调用 pdf2zh 都依赖桌面端的 Node 集成。通过同步把文献库带到移动端查看是没有问题的。

**Q：中文文献识别不准？**
在 设置 → PDF 元数据 中开启「中文检索（实验性）」。该功能抓取知网检索页，有反爬与失效风险，默认关闭。

**Q：翻译失败提示模型下载失败？**
设置环境变量 `HF_ENDPOINT=https://hf-mirror.com` 后重启思源再试；或在「额外 CLI 参数」中调整翻译服务。

## 开发与构建

```bash
pnpm install
pnpm run check        # typecheck + lint + test + build + 包校验
pnpm run dev          # watch 构建
pnpm run make-link    # 软链到思源插件目录调试
pnpm run package      # 产出 package.zip
```

所有思源文档和数据库写入都通过内核 API；插件不会直接修改 `.sy` 文件或数据库 JSON。架构与实现细节见 [docs/development.md](docs/development.md)，设计推导见 [docs/implementation-design.md](docs/implementation-design.md)。

## 致谢

- [SiYuan](https://github.com/siyuan-note/siyuan) — 本地优先的个人知识管理系统
- [Zotero](https://www.zotero.org/) 与 Zotero Connector 协议
- [PDFMathTranslate (pdf2zh)](https://github.com/PDFMathTranslate/PDFMathTranslate) — 本地论文翻译工具
- [BibLib](https://github.com/PassionPenguin/BibLib) — Connector 协议实现参考
- [茉莉花 Jasminum](https://github.com/l0o0/jasminum) — 中文文献元数据思路参考

## License

[PolyForm Noncommercial 1.0.0](LICENSE)（禁止商用，其余用途自由）

---

如果这个插件对你有帮助，欢迎 ⭐ Star 支持一下；有问题请到 [Issues](https://github.com/fu1fan/siyuan-paper-manager/issues) 反馈。
