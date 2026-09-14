vi.mock("../src/core/env", () => ({ canUseNode: vi.fn(() => true) }));
import { canUseNode } from "../src/core/env";
import { Menu } from "siyuan";

import { topBarMenuPosition } from "../src/ui/commands";

describe("top bar quick menu positioning", () => {
  it("right-aligns the menu below the top-bar button", () => {
    const anchor = {
      getBoundingClientRect: () => ({ right: 1880, bottom: 42 }),
    };
    const event = {
      currentTarget: anchor,
      clientX: 1868,
      clientY: 24,
    } as unknown as MouseEvent;

    expect(topBarMenuPosition(event)).toEqual({
      x: 1880,
      y: 42,
      isLeft: true,
    });
  });

  it("falls back to pointer coordinates when no button bounds are available", () => {
    const event = {
      currentTarget: null,
      clientX: 1868,
      clientY: 24,
    } as MouseEvent;

    expect(topBarMenuPosition(event)).toEqual({
      x: 1868,
      y: 24,
      isLeft: true,
    });
  });
});

it("adds synchronous document-scoped submenus only for saved papers and unregisters listeners", async () => {
  const { registerPaperUi } = await import('../src/ui/commands');
  const listeners = new Map<string, (event: any) => void>();
  const plugin = { addCommand: vi.fn(), addTopBar: vi.fn(), eventBus: {
    on: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    off: (name: string) => listeners.delete(name),
  } };
  const editMetadata = vi.fn(async () => {});
  const translate = vi.fn(async () => {});
  const repair = vi.fn(async () => {});
  const dispose = registerPaperUi(plugin as never, { editMetadata, translate, repair,
    detectDocKind: (id: string) => id === 'saved-paper' ? 'paper' : null,
  } as never);
  for (const event of ['open-menu-breadcrumbmore', 'click-editortitleicon', 'open-menu-content', 'open-menu-doctree']) {
    const menu = { addItem: vi.fn(), addSeparator: vi.fn() };
    const detail = { menu, protyle: { block: { rootID: 'saved-paper' } }, type: 'doc', items: [{ id: 'saved-paper' }] };
    listeners.get(event)!({ detail });
    expect(menu.addItem).toHaveBeenCalledTimes(3);
    const items = menu.addItem.mock.calls.map(([item]) => item);
    expect(items.map((item: any) => item.label)).toEqual(["文献·元数据编辑", "文献·翻译本文档", "文献·刷新元数据摘要"]);
    for (const item of items) await item.click();
    for (const action of [editMetadata, translate, repair]) expect(action).toHaveBeenLastCalledWith('saved-paper');
    menu.addItem.mockClear();
    detail.protyle.block.rootID = 'ordinary'; detail.items[0]!.id = 'ordinary';
    listeners.get(event)!({ detail });
    expect(menu.addItem).not.toHaveBeenCalled();
  }
  dispose(); expect(listeners.size).toBe(0);
});


it("omits desktop actions from mobile commands and menus while retaining paper operations", async () => {
  vi.mocked(canUseNode).mockReturnValue(false);
  const { registerPaperUi } = await import("../src/ui/commands");
  const listeners = new Map<string, (event: any) => void>();
  const plugin = { addCommand: vi.fn(), addTopBar: vi.fn(), eventBus: {
    on: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    off: (name: string) => listeners.delete(name),
  } };
  const actions = { detectDocKind: () => "paper", getStatus: () => ({ connector: { state: "stopped" } }) };
  const dispose = registerPaperUi(plugin as never, actions as never);
  expect(plugin.addCommand.mock.calls.map(([command]) => command.langKey)).not.toContain("translate-current-paper");
  expect(plugin.addCommand.mock.calls.map(([command]) => command.langKey)).toContain("import-local-pdf");
  const menu = { addItem: vi.fn(), addSeparator: vi.fn() };
  listeners.get("click-editortitleicon")!({ detail: { menu, protyle: { block: { rootID: "paper" } } } });
  expect(menu.addItem.mock.calls.map(([item]) => item.label)).toEqual(["文献·元数据编辑", "文献·刷新元数据摘要"]);
  const addItem = vi.spyOn(Menu.prototype, "addItem");
  plugin.addTopBar.mock.calls[0]![0].callback({ clientX: 20, clientY: 20 });
  expect(addItem.mock.calls.map((args) => (args[0] as any)?.label)).not.toContain("启动 Zotero 接收");
  dispose();
  vi.restoreAllMocks();
  vi.mocked(canUseNode).mockReturnValue(true);
});

it("offers batch translation for libraries from editor and file-tree menus", async () => {
  vi.mocked(canUseNode).mockReturnValue(true);
  const { registerPaperUi } = await import("../src/ui/commands");
  const listeners = new Map<string, (event: any) => void>();
  const plugin = { addCommand: vi.fn(), addTopBar: vi.fn(), eventBus: {
    on: (name: string, listener: (event: any) => void) => listeners.set(name, listener), off: vi.fn(),
  } };
  const translateLibrary = vi.fn(async () => {});
  registerPaperUi(plugin as never, { detectDocKind: () => "library", translateLibrary } as never);
  for (const name of ["open-menu-content", "open-menu-breadcrumbmore", "click-editortitleicon", "open-menu-doctree"]) {
    const menu = { addItem: vi.fn(), addSeparator: vi.fn() };
    listeners.get(name)!({ detail: { menu, protyle: { block: { rootID: "library" } }, type: "doc", items: [{ id: "library" }] } });
    const action = menu.addItem.mock.calls.find(([item]) => item.label === "文献·批量翻译未翻译论文")![0];
    await action.click();
    expect(translateLibrary).toHaveBeenLastCalledWith("library");
  }
  vi.mocked(canUseNode).mockReturnValue(false);
  const mobileMenu = { addItem: vi.fn() };
  listeners.get("open-menu-content")!({ detail: { menu: mobileMenu, protyle: { block: { rootID: "library" } } } });
  expect(mobileMenu.addItem.mock.calls.map(([item]) => item.label)).toEqual(["文献·导出文献库引用"]);
  vi.mocked(canUseNode).mockReturnValue(true);
});
