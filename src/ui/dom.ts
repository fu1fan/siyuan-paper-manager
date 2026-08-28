export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function button(label: string, primary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = primary ? "b3-button b3-button--text" : "b3-button b3-button--cancel";
  element.textContent = label;
  return element;
}

export function field(label: string, control: HTMLElement, description?: string): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "paper-manager-field";
  const title = document.createElement("span");
  title.textContent = label;
  if (description) title.title = description;
  wrapper.append(title, control);
  return wrapper;
}

export function currentDocumentId(): string | null {
  const selectors = [
    ".layout__wnd--active .protyle-title[data-node-id]",
    ".layout__wnd--active .protyle-wysiwyg[data-doc-type]",
    ".protyle:not(.fn__none) .protyle-title[data-node-id]",
  ];
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    const id = element?.dataset.nodeId;
    if (id) return id;
  }
  return null;
}

export function inputValue(root: ParentNode, selector: string): string {
  return (root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)?.value ?? "").trim();
}
