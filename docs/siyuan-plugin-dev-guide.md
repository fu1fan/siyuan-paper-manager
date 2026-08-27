# 思源笔记插件开发指南要点

来源：思源官方文档与仓库资料整理（见文末链接）。

## 一、主流官方资源

| 资源 | 地址 | 说明 |
|---|---|---|
| **官方插件示例** | https://github.com/siyuan-note/plugin-sample | webpack 打包，含中文 README |
| **前端插件 API 声明** | https://github.com/siyuan-note/petal | `siyuan.d.ts` 类型声明（Plugin 类等） |
| **后端内核 API 文档（中文）** | https://github.com/siyuan-note/siyuan/blob/master/API_zh_CN.md | RESTful API 完整中文文档 |
| **社区集市** | https://github.com/siyuan-note/bazaar | 上架需 PR 登记 plugins.json |
| **社区文档站** | https://docs.siyuan-note.club/zh-Hans/guide/plugin/startup.html | 插件开发入门教程 |
| **社区模板** | https://github.com/frostime/sy-plugin-template-vite | vite + svelte，支持热加载 |

## 二、环境要求

- Node.js + pnpm（`npm install -g pnpm`）、VS Code；
- 基础：JavaScript/HTML/CSS；进阶：TypeScript、Svelte、SASS。

起步步骤：Use this template 复制（**库名必须与插件 `name` 一致**）→ clone 到 `{工作空间}/data/plugins/` 便于调试 → `pnpm i` → `pnpm run dev` → 在思源「设置 → 集市 → 下载」启用。

关键依赖：`siyuan` npm 包（实际生效的是其中的 `siyuan.d.ts`，仅做 API 类型声明）。

## 三、打包后目录结构

```
├── plugin.json      # 插件配置文件（必填）
├── index.js         # 插件代码（src/*.ts 编译而来）
├── index.css        # 样式
├── icon.png         # 建议 160×160，≤20KB
├── preview.png      # 建议 1024×768，≤200KB
├── README*.md
└── i18n/*           # 国际化语言文件（可选）
```

## 四、plugin.json 示例

```json
{
  "name": "plugin-sample",
  "author": "Vanessa",
  "url": "https://github.com/siyuan-note/plugin-sample",
  "version": "0.4.2",
  "minAppVersion": "3.3.0",
  "kernels": ["all"],
  "backends": ["all"],
  "frontends": ["all"],
  "disabledInPublish": false,
  "displayName": { "default": "Plugin Sample", "zh-CN": "插件示例" },
  "description": { "default": "...", "zh-CN": "..." },
  "readme": { "default": "README.md", "zh-CN": "README.zh-CN.md" },
  "funding": { "custom": ["https://ld246.com/sponsor"] },
  "keywords": ["开发者参考", "示例插件"]
}
```

关键字段：
- `name`：插件包名，必须与仓库名一致且集市内唯一；
- `version`：semver 语义化版本，集市仅在版本变化时才拉取更新；
- `minAppVersion`：支持的最低思源版本号；
- `backends`：`windows`/`linux`/`darwin`/`docker`/`android`/`ios`/`harmony`/`all`；
- `frontends`：`desktop`/`desktop-window`/`mobile`/`browser-desktop`/`browser-mobile`/`all`；
- `displayName`/`description`/`readme`：多语言，`default` 必填，语言标签为 BCP 47。

## 五、前端插件 API（require('siyuan')）

核心是 `Plugin` 抽象类，生命周期钩子：
- `onload()`：插件启用/应用启动时；
- `onLayoutReady()`：界面加载完毕；
- `onunload()`：插件停用/应用关闭，用于清理；
- `uninstall()`：卸载。

常用属性/方法：
- `this.app`：全局应用实例；`this.i18n`：国际化文本；`this.eventBus`：订阅系统事件；
- UI 集成：`addCommand()`、`addDock()`、`addTopBar()`、`addStatusBar()`、`openTab()`、`openWindow()`；
- 网络请求：`fetchPost(url, data, callback)`、`fetchSyncPost(url, data)`；
- UI 组件：`Dialog`、`Setting`。

## 六、后端内核 API

思源内置 HTTP 接口（B/S 架构），中文文档在 `API_zh_CN.md`。所有内核 API 均需携带 Token，返回结构统一（`code == 0` 表示成功）。

```python
import requests
API_URL = "http://127.0.0.1:6806/api/notebook/lsNotebooks"
API_TOKEN = "你的Token"
headers = {"Authorization": f"Token {API_TOKEN}", "Content-Type": "application/json"}
resp = requests.post(API_URL, headers=headers, timeout=10)
```

## 七、开发者须知

1. **读写文件**：插件如需读写 `data` 下文件，必须通过内核 API（如 `/api/file/getFile`），**禁止自行调用 `fs` 或其他 electron/nodejs API**，否则可能导致数据同步时块丢失、云端数据损坏。
2. **Daily Note 属性**：用 `createDocWithMd` 手动创建日记需手动补 `custom-dailynote-yyyymmdd` 属性（Issue #9807）。

## 八、打包与上架

1. `pnpm run build` 生成 `package.zip`；
2. GitHub 创建 Release，Tag version = 插件版本号，上传 `package.zip`；
3. 首次上架需向 `siyuan-note/bazaar` 提交 PR，在 `plugins.json` 登记 `{"repos": ["username/reponame"]}`；
4. 集市约每 1 小时自动更新索引；
5. 后续发新版只需发 Release，无需再 PR。

## 参考链接

- https://github.com/siyuan-note/plugin-sample
- https://github.com/siyuan-note/petal
- https://github.com/siyuan-note/siyuan/blob/master/API_zh_CN.md
- https://docs.siyuan-note.club/zh-Hans/guide/plugin/startup.html
- https://github.com/frostime/sy-plugin-template-vite
- https://deepwiki.com/siyuan-note/siyuan/7.1-plugin-api-and-lifecycle
- https://www.npmjs.com/package/@frostime/siyuan-plugin-kits
