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
    expect(menu.addItem).toHaveBeenCalledTimes(1);
    const parent = menu.addItem.mock.calls[0]![0];
    expect(parent.label).toBe('文献操作');
    for (const item of parent.submenu) await item.click();
    for (const action of [editMetadata, translate, repair]) expect(action).toHaveBeenLastCalledWith('saved-paper');
    menu.addItem.mockClear();
    detail.protyle.block.rootID = 'ordinary'; detail.items[0]!.id = 'ordinary';
    listeners.get(event)!({ detail });
    expect(menu.addItem).not.toHaveBeenCalled();
  }
  dispose(); expect(listeners.size).toBe(0);
});
