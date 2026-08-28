export function getFrontend(): string {
  return "desktop";
}

export async function fetchSyncPost(): Promise<never> {
  throw new Error("fetchSyncPost mock was not configured");
}

export function showMessage(): void {}

export function confirm(
  _title: string,
  _text: string,
  confirmCallback?: (dialog: Dialog) => void,
): void {
  confirmCallback?.(new Dialog({ content: "" }));
}

export class Plugin {}

export class Dialog {
  element = typeof document === "undefined" ? ({} as HTMLElement) : document.createElement("div");
  constructor(_options: { content: string }) {}
  destroy(): void {}
}

export class Menu {
  addItem(): void {}
  addSeparator(): void {}
  open(): void {}
}

export class Setting {
  constructor(_options: unknown) {}
  addItem(): void {}
  open(): void {}
}
