# 首次使用指南与网页版验证

验证环境：SiYuan 3.8.6、macOS、2026-09-30。

临时工作空间为 `/private/tmp/siyuan-paper-manager-onboarding-20260930`，使用复制的构建文件，未将开发目录链接到工作空间。测试工作空间中的 `index.js`、`index.css`、`plugin.json` 和四张截图均与 `dist` 的 SHA-256 一致。正式笔记工作空间未用于这些测试。

## 截图来源

`docs/assets/onboarding/` 中的四张 JPEG 均为真实思源界面截图，随构建复制到插件的 `onboarding/` 目录：

- `import.jpg`：在临时工作空间粘贴 FlashAttention 的 BibTeX，解析后核对元数据。
- `library.jpg`：通过插件导入 Attention Is All You Need 和 FlashAttention 后的原生文献数据库。
- `citations.jpg`：这两篇论文的 GB/T 7714 引用导出预览。
- `translation.jpg`：临时工作空间桌面端的 PDF2ZH 服务、模型和密钥名称设置；未填写真实密钥。

## 实测行为

- 首次启用自动显示四步介绍；关闭后保存独立的 `introduction.json` 标记，刷新后不重复显示。
- 顶栏菜单可重播指南；步骤可直接切换；截图可放大，Escape 关闭大图。
- 1280 × 900 和 390 × 844 窗口中，正文可滚动，底部按钮可见，无弹窗横向溢出；测试后恢复浏览器默认尺寸。
- 四步截图均加载成功，浏览器控制台无错误。
- 桌面网页版实际完成 BibTeX 导入、原生文献库查看、GB/T 7714 和 BibTeX 导出预览。
- 使用仓库中文 PDF fixture 实际完成浏览器本地文本提取、候选元数据核对及 PDF 入库；fixture 的虚构 DOI 无法在线补全，仍保留本地提取结果。
- 浏览器未显示 Connector 和本地翻译执行入口，指南末页明确说明桌面端要求，并禁用跳转到本地翻译设置的按钮。

## 验证范围

`pnpm run typecheck`、`pnpm run lint`、`git diff --check`、生产构建及包资源校验通过。完整 Vitest 测试为 359 项通过、2 项原有本地复现测试跳过；Connector 测试需要允许监听本机回环端口。

生成的 `package.zip` 含四张截图，排除开发环境的 `dist/pdf2zh/` 运行配置。此次验证未执行 PDF2ZH 安装、输入真实密钥或调用付费翻译服务。

本次新增 `browser-desktop` 支持标记。该标记表示网页版的文献管理能力；PDF2ZH 子进程、Connector 服务和知网桌面验证仍依赖思源桌面 Node 环境。
