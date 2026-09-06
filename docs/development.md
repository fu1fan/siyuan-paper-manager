# 开发与维护说明

## 架构

- `src/core`：环境门控、内核 API、schema 编解码、命名、合并、模板与状态。
- `src/server`：Zotero Connector HTTP 服务及 30 分钟会话生命周期。
- `src/services`：设置存储、统一导入编排、文献库/数据库同步、引用导出、PDF 元数据提取、pdf2zh 翻译。
- `src/ui`：首次向导、五组设置、命令、顶栏、状态栏、右键菜单、导入/查重合并/引用导出对话框。
- `templates`：元数据与阅读笔记超级块模板。
- `tests`：纯函数测试、模板能力测试、Connector 回放与假 pdf2zh 集成测试。

所有思源数据写入均通过内核 API。Node `fs` 只读写 Connector、PDF 翻译所需的系统临时文件和现有工作空间资源，不直接修改 `.sy` 文档或思源数据库。

## 核心流程

### Connector

1. 绑定 `127.0.0.1`，检查 Connector API 版本。
2. `saveItems` 建立多条目会话；附件按 `parentItemID` 关联。
3. 有预期附件时等待五分钟后结算；正在上传的附件完成后才结算，无附件时使用短暂 grace period。活动和已完成会话均按 session ID 去重；重复附件不覆盖原文件。
4. 逐条生成 `ImportCandidate`，串行交给统一 ItemProcessor。
5. 会话和幂等记录 30 分钟后清理。

### 文献库数据库

- 文献库文档通过 `custom-paper-library-data`（明文 JSON，schema v3）保存 AV ID、数据库块 ID、全部字段列 ID、项目定义和时间戳；读取时容忍 HTML 转义并兼容 v1/v2 数据。
- 数据库行绑定论文文档块，实际绑定决定读取时的文献库归属；`custom-paper-library-id` 保存导入/修复所需的归属提示，不能用它否定已有绑定。
- **数据库行是用户可见元数据的唯一权威**：全部元数据列（18 个）在创建/对齐时一律建全，列的显示与排序交给思源数据库视图；插件不记录 selectedFields/columnOrder。
- 插件只在导入/合并时回写元数据列（`writeMetadata=true`）；修复、翻译后刷新只回写机器状态属性，绝不覆盖用户在数据库中的编辑。
- 「重新同步」按 `custom-paper-library-id` 恢复缺失行，同时保留所有实际绑定的行，不因属性索引缺失而删除元数据；用论文页首个 H1 回填空标题列；「修复数据库」在 AV 损坏时按记录结构重建数据库（原单元格内容随损坏丢失）。
- 数据库结构对齐（`ensureSchemaFields`）以数据库实际列为准：同名列复用、重复列删除、缺失才建；同一文献库的对齐按锁串行。
- 用户自建数据库列不在插件删除范围内。
- 识别与遍历优先读取 `getAttributeView` 的原始 `keyValues`，用 `blockID` 重建条目；不依赖筛选/分组后的视图。已绑定条目暂时未读到时短暂重试。导入同步自动重试两次，持续失败明确报错，不再静默返回成功。

### 创建与合并

1. 归一化 DOI、标题、作者等字段并生成 citekey。
2. 一次读取原始数据库条目，按 DOI 或 citekey+标题查重；只有新建/副本才分配唯一 citekey（重名自动加 `a/b/c…` 后缀）。PDF 和 Connector 在 ItemProcessor 中共用串行队列。
3. 用户选择取消、合并或创建副本。
4. 附件计算 SHA-256 去重后走 `/api/asset/upload`。
5. 以 citekey 为文档名调用 `createDocWithMd` 创建子文档（正文首个 H1 为论文标题）。
6. 写机器状态属性：附件清单（JSON）、翻译产物地址、处理状态、文献库归属。
7. 确保 meta/note 两个超级块存在（认领或新建），渲染元数据摘要。
8. 将论文文档绑定到默认文献库数据库并回写全部元数据列（仅此时 `writeMetadata=true`）。
9. 使用插件内置模板引擎渲染打包模板，不向 `data/templates` 写入文件。

合并前重新读取完整论文（含属性中的附件和译文），相同 SHA-256 的已有附件直接复用。合并时现有非空字段优先，只有用户勾选的冲突字段会覆盖；附件按 SHA-256/地址去重后补充；阅读笔记区不参与操作。

### 模板刷新

模板文件自身只有一个超级块根节点。刷新时：

1. 通过 `custom-section=meta` 定位块。
2. 回读其 Kramdown 和块属性。
3. 使用内置模板引擎生成 Markdown。
4. 保留目标块 ID、原有块属性与 `custom-section`。
5. 更新后再次读取属性验证标记。

### 翻译

翻译服务一次只运行一个子进程，始终使用 argv 数组及 `shell:false`。输出先进入 `os.tmpdir()` 独立目录，校验 `%PDF-` 文件头后上传；元数据与模板刷新成功后任务才算完成。翻译准备阶段即占用队列，重复任务被拒绝，取消会覆盖准备阶段和等待任务；插件卸载会向子进程发送 `SIGTERM`。保存时重新读取论文，保留翻译期间的附件和元数据变更。

## 测试

```bash
pnpm run typecheck
pnpm run lint
pnpm run test:run
pnpm run build
pnpm run verify:package
```

Connector 测试会临时绑定本机回环端口；受限沙箱中运行时需要允许 localhost 监听。

测试覆盖：

- 文献库数据编解码（明文 JSON、schema 版本兼容）、文档命名与 citekey 生成/去重。
- DOI/citekey、标题相似度、路径清洗。
- 默认合并、显式覆盖、附件去重、并发导入串行化、无 DOI 查重、合并保留附件与译文。
- 模板字段、条件、循环、打包模板读取和 Markdown 刷新。
- 数据库行绑定、条目映射确认、文献库同步/修复与引用键收集。
- Connector ping、API 版本、多条目附件关联、重复会话/附件、慢速上传和 501。
- 不可读 PDF 的文件名兜底、CNKI HTML 固定样本。
- 假 pdf2zh 子进程、PDF 校验、资源上传和元数据持久化；准备阶段去重/取消、保存时读取最新论文。
- 引用导出各格式（GB/T 7714、APA、IEEE、BibTeX、Hayagriva 等）。
- 设置归一化与命令注册。

真实思源发布验收还需在最低支持版本和当前稳定版本完成：创建、合并、编辑、模板刷新、重启读取、Connector 真机、pdf2zh 真机、Windows/Linux 路径 smoke test。

## 发布

- `0.1.x`：Connector 与元数据页基础。
- `0.2.x`：本地 PDF 元数据提取。
- `0.3.x`：pdf2zh、完整 UI、测试和发布门禁。
- `0.4.x`：多文献库、思源原生数据库、项目与引用导出。
- 完成真实思源与跨平台验收后升级 `1.0.0`。

`pnpm run package` 会生产 `package.zip` 并验证清单名称、版本和必需文件。发布前同时更新 `package.json` 与 `plugin.json`，构建脚本会拒绝版本不一致。

自动测试使用模拟内核及本地假 pdf2zh；不代表已验证真实思源 UI、在线元数据服务或真实翻译服务。界面回归重点是快速切换 PDF、切换文献库、保存项目定义，以及重开设置后默认库的正确性。
