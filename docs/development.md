# 开发与维护说明

## 架构

- `src/core`：环境门控、内核 API、schema 编解码、命名、合并、模板与状态。
- `src/server`：Zotero Connector HTTP 服务及 30 分钟会话生命周期。
- `src/services`：设置存储、统一导入编排、PDF 元数据提取、pdf2zh 翻译。
- `src/ui`：四组设置、命令、顶栏、状态栏、右键菜单和对话框。
- `templates`：元数据与阅读笔记超级块模板。
- `tests`：纯函数测试、模板能力测试、Connector 回放与假 pdf2zh 集成测试。

所有思源数据写入均通过内核 API。Node `fs` 只读写 Connector、PDF 翻译所需的系统临时文件和现有工作空间资源，不直接修改 `.sy` 文档或思源数据库。

## 核心流程

### Connector

1. 绑定 `127.0.0.1`，检查 Connector API 版本。
2. `saveItems` 建立多条目会话；附件按 `parentItemID` 关联。
3. 有预期附件时等待附件完成，最长等待五分钟；无附件时使用短暂 grace period。
4. 逐条生成 `ImportCandidate`，串行交给统一 ItemProcessor。
5. 会话和幂等记录 30 分钟后清理。

### 创建与合并

1. 归一化 DOI、标题、作者等字段并生成 citekey。
2. 按 DOI 或 citekey+标题查重。
3. 用户选择取消、合并或创建副本。
4. 附件计算 SHA-256 后走 `/api/asset/upload`。
5. 渲染两个超级块并调用 `createDocWithMd`。
6. 写 `custom-paper-data` 和索引属性。
7. 用真实文档执行原生模板探针，必要时切换回退引擎。

合并时现有非空字段优先，只有用户勾选的冲突字段会覆盖；新的原始响应追加到 `sources[]`；阅读笔记区不参与操作。

### 模板刷新

模板文件自身只有一个超级块根节点。刷新时：

1. 通过 `custom-section=meta` 定位块。
2. 回读其 Kramdown。
3. 原生模式使用 DOM；回退模式使用 Markdown。
4. 强制保留目标块 ID与 `custom-section`。
5. 更新后再次读取属性验证标记。

### 翻译

翻译服务一次只运行一个子进程，始终使用 argv 数组及 `shell:false`。输出先进入 `os.tmpdir()` 独立目录，校验 `%PDF-` 文件头后上传；元数据与模板刷新成功后任务才算完成。插件卸载会向子进程发送 `SIGTERM`。

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

- UTF-8 base64、schema 和索引同步。
- DOI/citekey、标题相似度、路径清洗。
- 默认合并、显式覆盖、附件去重。
- 模板字段、条件、循环、原生探针和单次回退提示。
- Connector ping、API 版本、两条目附件关联和 501。
- 不可读 PDF 的文件名兜底、CNKI HTML 固定样本。
- 假 pdf2zh 子进程、PDF 校验、资源上传和元数据持久化。

真实思源发布验收还需在最低支持版本和当前稳定版本完成：创建、合并、编辑、模板刷新、重启读取、Connector 真机、pdf2zh 真机、Windows/Linux 路径 smoke test。

## 发布

- `0.1.x`：Connector 与元数据页基础。
- `0.2.x`：本地 PDF 元数据提取。
- `0.3.x`：pdf2zh、完整 UI、测试和发布门禁。
- 完成真实思源与跨平台验收后升级 `1.0.0`。

`pnpm run package` 会生产 `package.zip` 并验证清单名称、版本和必需文件。发布前同时更新 `package.json` 与 `plugin.json`，构建脚本会拒绝版本不一致。
