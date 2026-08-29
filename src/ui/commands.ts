import { Menu, Plugin, showMessage } from "siyuan";
import type { KernelClient } from "../core/kernel";
import { ATTR } from "../constants";
import type { PluginStatus } from "../types/status";
import { currentDocumentId } from "./dom";

export interface PaperUiActions {
  importPdf: () => Promise<void>;
  editMetadata: (docId: string) => Promise<void>;
  translate: (docId: string) => Promise<void>;
  repair: (docId: string) => Promise<void>;
  exportLibrary: (docId: string) => Promise<void>;
  openSettings: () => void;
  selfCheck: () => Promise<void>;
  toggleConnector: () => Promise<void>;
  getStatus: () => PluginStatus;
}

export function registerPaperUi(
  plugin: Plugin,
  kernel: KernelClient,
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
    langText: "论文管理：导出当前文献库引用",
    callback: () => { void withCurrentDoc(actions.exportLibrary); },
  });
  plugin.addCommand({
    langKey: "edit-paper-metadata",
    langText: "论文管理：编辑当前论文元数据",
    hotkey: "⌥E",
    callback: () => { void withCurrentDoc(actions.editMetadata); },
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
    if (docId) void addPaperItems(event.detail.menu, docId, kernel, actions);
  };
  const treeListener = (event: CustomEvent<any>) => {
    if (event.detail.type !== "doc" || event.detail.items?.length !== 1) return;
    const docId = event.detail.items[0]?.id as string | undefined;
    if (docId) void addPaperItems(event.detail.menu, docId, kernel, actions);
  };
  plugin.eventBus.on("open-menu-content", contentListener);
  plugin.eventBus.on("open-menu-doctree", treeListener);
  return () => {
    plugin.eventBus.off("open-menu-content", contentListener);
    plugin.eventBus.off("open-menu-doctree", treeListener);
  };
}

function openQuickMenu(event: MouseEvent, actions: PaperUiActions): void {
  const menu = new Menu("paper-manager-quick-menu");
  menu.addItem({ icon: "iconUpload", label: "导入本地 PDF", click: () => run(actions.importPdf) });
  menu.addItem({ icon: "iconEdit", label: "编辑当前论文元数据", click: () => withCurrentDoc(actions.editMetadata) });
  menu.addItem({ icon: "iconLanguage", label: "翻译当前论文", click: () => withCurrentDoc(actions.translate) });
  menu.addItem({ icon: "iconDownload", label: "导出当前文献库引用", click: () => withCurrentDoc(actions.exportLibrary) });
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

async function addPaperItems(menu: { addItem: (item: any) => unknown; addSeparator?: () => unknown }, docId: string, kernel: KernelClient, actions: PaperUiActions): Promise<void> {
  try {
    const attrs = await kernel.getBlockAttrs(docId);
    if (attrs[ATTR.libraryData]) {
      menu.addSeparator?.();
      menu.addItem({ icon: "iconDownload", label: "导出文献库引用", click: () => run(() => actions.exportLibrary(docId)) });
      return;
    }
    if (!attrs[ATTR.data]) return;
    menu.addSeparator?.();
    menu.addItem({ icon: "iconEdit", label: "编辑论文元数据", click: () => run(() => actions.editMetadata(docId)) });
    menu.addItem({ icon: "iconLanguage", label: "翻译本文档", click: () => run(() => actions.translate(docId)) });
    if (attrs[ATTR.state] === "failed") {
      menu.addItem({ icon: "iconRefresh", label: "修复导入", click: () => run(() => actions.repair(docId)) });
    }
  } catch (error) {
    console.debug("[paper-manager] 右键菜单论文识别失败", error);
  }
}

async function withCurrentDoc(action: (docId: string) => Promise<void>): Promise<void> {
  const docId = currentDocumentId();
  if (!docId) {
    showMessage("请先打开一篇论文元数据页", 4000, "error");
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
