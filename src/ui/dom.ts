export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One creator per line as "姓, 名"; the inverse of `parseCreatorLines`. */
export function creatorLines(creators: readonly { family: string; given: string }[]): string {
  return creators.map(creator => [creator.family, creator.given].filter(Boolean).join(", ")).join("\n");
}

/**
 * Parse the "姓, 名" textarea format.  A name without a comma is treated as a
 * surname so a single-token Chinese name still becomes one creator.
 */
export function parseCreatorLines(value: string): Array<{ family: string; given: string; creatorType: "author" }> {
  return value.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const [family, ...given] = line.split(",");
    return { family: (family ?? "").trim(), given: given.join(",").trim(), creatorType: "author" as const };
  });
}

/** Shared dialog footer with the standard scrollable-content wrapper. */
export function dialogFooter(attributes = ""): string {
  return `<div class="paper-manager-dialog-footer"><div class="paper-manager-actions"${attributes ? ` ${attributes}` : ""}></div></div>`;
}

export function button(label: string, primary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = primary ? "b3-button b3-button--text" : "b3-button b3-button--cancel";
  element.textContent = label;
  return element;
}

export function currentDocumentId(): string | null {
  const selectors = [
    ".layout__wnd--active .protyle-title[data-node-id]",
    ".layout__wnd--active .protyle-wysiwyg[data-doc-type]",
    ".protyle:not(.fn__none) .protyle-title[data-node-id]",
  ];
  for (const selector of selectors) {
    // Inactive tabs remain in the active layout window's DOM. Skip hidden
    // editors (including hidden ancestors), rather than taking its first title.
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (element.closest(".fn__none, [hidden]") || !element.getClientRects().length) continue;
      const id = element.dataset.nodeId;
      if (id) return id;
    }
  }
  return null;
}

export function inputValue(root: ParentNode, selector: string): string {
  return (root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)?.value ?? "").trim();
}
