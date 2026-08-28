# siyuan-paper-manager

面向思源笔记桌面端的论文管理插件：接收 Zotero Connector 文献与附件、创建可维护的论文元数据页、导入本地 PDF 提取元数据，并调用本地 pdf2zh 生成翻译版本。

## 功能

- **Zotero Connector 接收**：仅监听 `127.0.0.1:23119`，支持 `ping`、`saveItems`、网页快照、附件、会话进度等端点。
- **论文元数据页**：完整数据保存在 `custom-paper-data`，正文分为可自动刷新的元数据超级块和永不自动覆盖的阅读笔记超级块。
- **重复导入合并**：优先按 DOI，其次按 citekey 与标题查重；默认保留现有非空字段，附件按 SHA-256 去重。
- **本地 PDF 导入**：读取 PDF 信息/XMP 和前三页文本，依次尝试 DOI、Crossref、Citoid；识别失败仍用文件名创建。
- **中文检索**：实验性 CNKI 候选检索，默认关闭，多候选由用户选择。
- **pdf2zh 翻译**：单任务队列调用本地 CLI，生成 mono/dual PDF，上传思源并自动刷新元数据区。
- **原生模板探针**：优先尝试思源 `/api/template/render`；字段绑定失败时提示并切换内置受限模板引擎。

## 系统要求

- 思源笔记 `>= 3.1.16`
- 桌面端或桌面窗口端；移动端、浏览器端不启动 Connector 和 pdf2zh
- Node.js 22+ 与 pnpm（仅开发时需要）
- 可选：Python 3.11–3.12 与 [pdf2zh](https://github.com/Byaidu/PDFMathTranslate)

> Zotero 桌面版与本插件默认使用同一个 `23119` 端口，接收 Connector 数据时需关闭 Zotero，或在插件设置中修改端口。

## 开发与构建

```bash
pnpm install
pnpm run check          # 类型、Lint、测试、构建与产物校验
pnpm run dev            # Vite watch 构建
pnpm run make-link      # 将 dist 软链到默认思源插件目录
pnpm run package        # 生成 package.zip
```

构建产物位于 `dist/`，包含 `plugin.json`、`index.js`、`index.css`、i18n、图标、README 和两份模板。

## 初次配置

1. 在“设置 → 集市 → 已下载”启用“论文管理”。
2. 打开插件设置，在“导入与接收”选择目标笔记本；插件不会静默选择第一个笔记本。
3. 确认状态栏显示 `Zotero 23119`，然后在浏览器点击 Zotero Connector。
4. 本地 PDF 可通过 `⌥I` 或顶栏“论文管理 → 导入本地 PDF”导入。

### 命令

| 命令 | 默认快捷键 |
|---|---|
| 导入本地 PDF | `⌥I` |
| 编辑当前论文元数据 | `⌥E` |
| 翻译当前论文 | `⌥T` |
| 环境自检 | 无 |

论文页右键菜单还提供编辑、翻译，以及失败页面的“修复导入”。

## 数据结构

文档根块属性：

- `custom-paper-data`：base64 编码的 schema v1 JSON，包含 `canonical`、`sources[]`、`attachments[]`、`translation`、citekey 与时间戳。
- `custom-paper-citekey` / `custom-paper-doi`：查重索引。
- `custom-paper-attachment-pdf`：原始 PDF 索引。
- `custom-paper-translation-mono` / `custom-paper-translation-dual`：翻译资源索引。
- `custom-paper-state`：`ready` 或 `failed`。

元数据区与笔记区是两个顶层超级块，分别标记 `custom-section=meta/note`。编辑或翻译只更新 meta 超级块；note 超级块及其块 ID不参与刷新。

## PDF 元数据策略

1. 读取 PDF Document Info/XMP。
2. 从前三页文本中识别 DOI。
3. DOI 精确查询 Crossref；失败时使用 Citoid。
4. 没有 DOI 时用标题查询 Crossref，并按标题、年份、作者评分。
5. 可选 CNKI 候选检索。
6. 全部失败时，以文件名作为标题创建元数据页。

网络服务均有超时、有限重试和 429 退避；离线不会阻断 PDF 导入。第一版不包含 OCR。

## pdf2zh

```bash
uv tool install --python 3.12 pdf2zh
# 国内首次下载模型时可设置：
export HF_ENDPOINT=https://hf-mirror.com
```

在插件“翻译”设置中配置可执行路径、语言、翻译服务和额外参数。插件使用 `spawn(..., { shell: false })`，中间文件只写系统临时目录；成功后才上传思源。重新翻译只替换链接，不自动删除旧资源。

## 故障排查

- **端口被占用**：关闭 Zotero，或修改插件端口。
- **没有目标笔记本**：在插件设置中明确选择笔记本。
- **模板回退提示**：打开“环境自检”查看当前引擎；回退引擎支持字段、`if/else` 和 `range`。
- **找不到 pdf2zh**：填写绝对路径；macOS GUI 环境也会检查 `~/.local/bin/pdf2zh`。
- **模型下载失败**：设置 `HF_ENDPOINT=https://hf-mirror.com` 后重试。
- **导入状态为 failed**：在论文页右键选择“修复导入”。

更完整的架构、测试和发布说明见 [docs/development.md](docs/development.md)。
