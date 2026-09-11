import { Menu, Plugin, showMessage } from "siyuan";
import type { PluginStatus } from "../types/status";
import { currentDocumentId } from "./dom";

export type DocKind = "library" | "paper" | null;

export interface PaperUiActions {
  importPdf: () => Promise<void>;
  translate: (docId: string) => Promise<void>;
  editMetadata: (docId: string) => Promise<void>;
  repair: (docId: string) => Promise<void>;
  exportLibrary: (docId?: string) => Promise<void>;
  openSettings: () => void;
  selfCheck: () => Promise<void>;
  toggleConnector: () => Promise<void>;
  getStatus: () => PluginStatus;
  /** 同步读取文档索引：仅带插件文献属性的文档返回 paper。 */
  detectDocKind: (docId: string) => DocKind;
}

export function registerPaperUi(
  plugin: Plugin,
  actions: PaperUiActions,
): () => void {
  plugin.addCommand({
    langKey: "import-local-pdf",
    langText: "论文管理：导入本地 PDF",
    hotkey: "⌥I",
    callback: () => { void run(actions.importPdf); },
  });
  plugin.addCommand({
    langKey: "export-library-citations",
    langText: "论文管理：导出文献库引用",
    callback: () => { void run(() => actions.exportLibrary(currentDocumentId() ?? undefined)); },
  });
  plugin.addCommand({
    langKey: "edit-paper-metadata",
    langText: "论文管理：元数据编辑",
    callback: () => { void withCurrentDoc(actions.editMetadata); },
  });
  plugin.addCommand({
    langKey: "refresh-paper-meta",
    langText: "论文管理：刷新当前论文元数据摘要",
    hotkey: "⌥E",
    callback: () => { void withCurrentDoc(actions.repair); },
  });
  plugin.addCommand({
    langKey: "translate-current-paper",
    langText: "论文管理：翻译当前论文",
    hotkey: "⌥T",
    callback: () => { void withCurrentDoc(actions.translate); },
  });
  plugin.addCommand({
    langKey: "paper-manager-status",
    langText: "论文管理：环境自检",
    callback: () => { void run(actions.selfCheck); },
  });

  plugin.addTopBar({
    icon: "iconFiles",
    title: "论文管理",
    position: "right",
    callback: (event) => openQuickMenu(event, actions),
  });

  const contentListener = (event: CustomEvent<any>) => {
    const docId = event.detail.protyle?.block?.rootID as string | undefined;
    if (docId) void addPaperItems(event.detail.menu, docId, actions);
  };
  const treeListener = (event: CustomEvent<any>) => {
    if (event.detail.type !== "doc" || event.detail.items?.length !== 1) return;
    const docId = event.detail.items[0]?.id as string | undefined;
    if (docId) void addPaperItems(event.detail.menu, docId, actions);
  };
  plugin.eventBus.on("open-menu-content", contentListener);
  plugin.eventBus.on("open-menu-breadcrumbmore", contentListener);
  plugin.eventBus.on("click-editortitleicon", contentListener);
  plugin.eventBus.on("open-menu-doctree", treeListener);
  return () => {
    plugin.eventBus.off("open-menu-content", contentListener);
    plugin.eventBus.off("open-menu-breadcrumbmore", contentListener);
    plugin.eventBus.off("click-editortitleicon", contentListener);
    plugin.eventBus.off("open-menu-doctree", treeListener);
  };
}

function openQuickMenu(event: MouseEvent, actions: PaperUiActions): void {
  const menu = new Menu("paper-manager-quick-menu");
  menu.addItem({ icon: "iconDownload", label: "导入本地 PDF", click: () => run(actions.importPdf) });
  menu.addItem({ icon: "iconUpload", label: "导出文献库引用", click: () => run(() => actions.exportLibrary(currentDocumentId() ?? undefined)) });
  menu.addSeparator();
  const status = actions.getStatus().connector;
  menu.addItem({
    icon: status.state === "listening" ? "iconPause" : "iconPlay",
    label: status.state === "listening" ? "停止 Zotero 接收" : "启动 Zotero 接收",
    click: () => run(actions.toggleConnector),
  });
  menu.addItem({ icon: "iconInfo", label: "环境自检", click: () => run(actions.selfCheck) });
  menu.addItem({ icon: "iconSettings", label: "插件设置", click: actions.openSettings });
  menu.open(topBarMenuPosition(event));
}

/**
 * Anchor a right-side top-bar menu to the button rather than the pointer.
 *
 * SiYuan positions a menu's left edge at `x` by default.  A menu opened near
 * the right viewport edge can therefore be moved to an incorrect fallback
 * position.  `isLeft` makes `x` the menu's right edge, while the button bounds
 * keep the placement stable regardless of where inside the icon was clicked.
 */
export function topBarMenuPosition(event: MouseEvent): {
  x: number;
  y: number;
  isLeft: true;
} {
  const anchor = event.currentTarget as Partial<HTMLElement> | null;
  const rect = anchor?.getBoundingClientRect?.();
  if (rect && Number.isFinite(rect.right) && Number.isFinite(rect.bottom)) {
    return { x: rect.right, y: rect.bottom, isLeft: true };
  }
  return { x: event.clientX, y: event.clientY, isLeft: true };
}

function addPaperItems(
  menu: { addItem: (item: any) => unknown; addSeparator?: () => unknown },
  docId: string,
  actions: PaperUiActions,
): void {
  try {
    const kind = actions.detectDocKind(docId);
    if (kind === "library") {
      menu.addSeparator?.();
      menu.addItem({ icon: "iconUpload", label: "导出文献库引用", click: () => run(() => actions.exportLibrary(docId)) });
      return;
    }
    if (kind !== "paper") return;
    menu.addSeparator?.();
    menu.addItem({ icon: "iconFiles", label: "文献操作", type: "submenu", submenu: [
      { icon: "iconEdit", label: "元数据编辑", click: () => run(() => actions.editMetadata(docId)) },
      { icon: "iconLanguage", label: "翻译本文档", click: () => run(() => actions.translate(docId)) },
      { icon: "iconRefresh", label: "刷新元数据摘要", click: () => run(() => actions.repair(docId)) },
    ] });
  } catch (error) {
    console.debug("[paper-manager] 右键菜单论文识别失败", error);
  }
}

async function withCurrentDoc(action: (docId: string) => Promise<void>): Promise<void> {
  const docId = currentDocumentId();
  if (!docId) {
    showMessage("请先打开一篇论文页", 4000, "error");
    return;
  }
  await run(() => action(docId));
}

async function run(action: (() => Promise<void>) | Promise<void>): Promise<void> {
  try {
    await (typeof action === "function" ? action() : action);
  } catch (error) {
    showMessage(`论文管理操作失败：${error instanceof Error ? error.message : String(error)}`, 6000, "error");
  }
}
