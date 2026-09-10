import { vi } from "vitest";
import { currentDocumentId } from "../src/ui/dom";

function title(id: string, hidden = false, rendered = true) {
  return {
    dataset: { nodeId: id },
    closest: () => hidden ? {} : null,
    getClientRects: () => rendered ? [{}] : [],
  };
}

describe("current document in retained editor tabs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips a hidden earlier tab in the active window", () => {
    vi.stubGlobal("document", {
      querySelectorAll: () => [title("old-document", true), title("current-paper")],
    });
    expect(currentDocumentId()).toBe("current-paper");
  });

  it("skips editors hidden by layout CSS", () => {
    vi.stubGlobal("document", {
      querySelectorAll: () => [title("old-document", false, false), title("current-paper")],
    });
    expect(currentDocumentId()).toBe("current-paper");
  });

  it("prioritizes the active split over another visible editor", () => {
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) => selector.startsWith(".layout__wnd--active")
        ? [title("active-paper")] : [title("other-split")],
    });
    expect(currentDocumentId()).toBe("active-paper");
  });

  it("falls back to a visible editor when a menu has taken layout focus", () => {
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) => selector.startsWith(".layout__wnd--active")
        ? [] : [title("current-paper")],
    });
    expect(currentDocumentId()).toBe("current-paper");
  });

  it("returns null when all retained editors are hidden", () => {
    vi.stubGlobal("document", { querySelectorAll: () => [title("old-document", true)] });
    expect(currentDocumentId()).toBeNull();
  });
});
