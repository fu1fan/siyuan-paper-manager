import { fontPathExists, scanSystemFonts, type SystemFont } from "../services/system-fonts";
import { escapeHtml } from "./dom";

export function fontPickerHtml(): string {
  return `<div class="paper-manager-font-picker" data-font-picker>
    <button type="button" class="b3-select paper-manager-font-trigger" data-font-trigger aria-haspopup="listbox" aria-expanded="false"><span data-font-name>自动选择字体</span><span aria-hidden="true">⌄</span></button>
    <span class="paper-manager-font-status" data-font-status></span>
    <details class="paper-manager-font-manual"><summary>手动填写路径</summary><input class="b3-text-field" data-config-key="NOTO_FONT_PATH" aria-label="字体文件路径" placeholder="留空由 pdf2zh 自动选择"></details>
  </div>`;
}

const RECENT_KEY = "paper-manager-recent-fonts";
let pickerSequence = 0;

/** Small Word-style menu; the saved value is always a file path, not a CSS name. */
export class FontPicker {
  private readonly trigger: HTMLButtonElement;
  private readonly input: HTMLInputElement;
  private readonly name: HTMLElement;
  private readonly status: HTMLElement;
  private readonly controller = new AbortController();
  private readonly id = `paper-font-${++pickerSequence}`;
  private menu?: HTMLDivElement;
  private fonts?: SystemFont[];
  private loading?: Promise<void>;
  private active = -1;
  private previews = new Map<string, { family: string; face: FontFace }>();
  private rows: HTMLButtonElement[] = [];
  private observer?: IntersectionObserver;
  private recent: string[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly scan: () => Promise<SystemFont[]> = scanSystemFonts,
    private readonly exists: (path: string) => boolean = fontPathExists,
  ) {
    this.trigger = root.querySelector<HTMLButtonElement>("[data-font-trigger]")!;
    this.input = root.querySelector<HTMLInputElement>("[data-config-key=NOTO_FONT_PATH]")!;
    this.name = root.querySelector<HTMLElement>("[data-font-name]")!;
    this.status = root.querySelector<HTMLElement>("[data-font-status]")!;
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (Array.isArray(stored)) this.recent = stored.filter((value): value is string => typeof value === "string").slice(0, 5);
    } catch { /* Storage is optional. */ }
    const options = { signal: this.controller.signal };
    this.trigger.addEventListener("click", () => this.menu ? this.close() : this.open(), options);
    this.trigger.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.open(); }
    }, options);
    this.input.addEventListener("input", () => this.update(), options);
    this.update();
    if (this.input.value.trim() && this.exists(this.input.value.trim())) void this.load();
  }

  update(): void {
    const value = this.input.value.trim();
    const font = this.fonts?.find(item => item.path === value);
    this.name.textContent = font?.name || (value ? value.split(/[\\/]/).pop()!.replace(/\.(ttf|otf|ttc|otc)$/i, "") : "自动选择字体");
    this.name.style.fontFamily = font ? this.preview(font) : "";
    this.trigger.title = value || "留空由 pdf2zh 自动选择字体";
    const missing = Boolean(value && !this.exists(value));
    this.status.textContent = missing ? "路径不存在，请重新选择字体" : "";
    this.status.hidden = !missing;
    this.root.dataset.invalid = String(missing);
    if (this.menu) this.renderRows();
  }

  private preview(font: SystemFont): string {
    const cached = this.previews.get(font.path);
    if (cached) return JSON.stringify(cached.family);
    // local() resolves the installed face without loading every font file into memory.
    if (typeof FontFace !== "undefined") {
      const family = `${this.id}-${this.previews.size}`;
      const sources = [...new Set([font.postscriptName, font.name, font.family].filter(Boolean))];
      try {
        const face = new FontFace(family, sources.map(value => `local(${JSON.stringify(value)})`).join(", "));
        document.fonts.add(face);
        this.previews.set(font.path, { family, face });
        void face.load().catch(() => { /* Fall back to the host UI font. */ });
        return JSON.stringify(family);
      } catch { /* FontFace unavailable in this host. */ }
    }
    return `${JSON.stringify(font.family)}, sans-serif`;
  }

  private open(): void {
    if (this.menu || this.controller.signal.aborted) return;
    const menu = document.createElement("div");
    menu.className = "paper-manager-font-menu";
    menu.setAttribute("popover", "manual");
    menu.innerHTML = `<div class="paper-manager-font-search"><input class="b3-text-field" data-font-search role="combobox" aria-label="搜索字体" aria-autocomplete="list" aria-expanded="true" aria-controls="${this.id}-list" placeholder="搜索字体…"><button type="button" class="b3-button b3-button--text" data-font-refresh aria-label="刷新字体列表" title="刷新字体列表">↻</button></div><div class="paper-manager-font-list" id="${this.id}-list" role="listbox" aria-label="本机字体" data-font-list></div><div class="paper-manager-font-footer" data-font-footer>正在读取本机字体…</div>`;
    this.menu = menu;
    document.body.append(menu);
    if (typeof menu.showPopover === "function") menu.showPopover();
    this.trigger.setAttribute("aria-expanded", "true");
    const search = menu.querySelector<HTMLInputElement>("[data-font-search]")!;
    search.addEventListener("input", () => this.renderRows());
    menu.addEventListener("keydown", event => this.onKey(event));
    menu.querySelector("[data-font-refresh]")!.addEventListener("click", () => { this.fonts = undefined; void this.load(); });
    const closeOutside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !this.root.contains(event.target as Node)) this.close();
    };
    const closeOnScroll = (event: Event) => { if (!(event.target instanceof Node && menu.contains(event.target))) this.close(); };
    const closeOnFocus = (event: FocusEvent) => { if (!menu.contains(event.target as Node) && event.target !== this.trigger) this.close(); };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("scroll", closeOnScroll, true);
    document.addEventListener("focusin", closeOnFocus);
    window.addEventListener("resize", this.closeOnResize);
    this.removeMenuListeners = () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("scroll", closeOnScroll, true);
      document.removeEventListener("focusin", closeOnFocus);
      window.removeEventListener("resize", this.closeOnResize);
    };
    this.renderRows();
    const rect = this.trigger.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const down = below >= 220 || below >= above;
    const height = Math.min(340, down ? below : above);
    menu.style.maxHeight = `${height}px`;
    if (down) menu.style.top = `${rect.bottom + 4}px`;
    else menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    search.focus();
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.fonts) { this.update(); return; }
    if (this.loading) return this.loading;
    this.renderRows();
    this.loading = (async () => {
      try {
        const fonts = await this.scan();
        if (this.controller.signal.aborted) return;
        this.fonts = fonts;
        this.update();
      } catch {
        if (this.menu) this.menu.querySelector<HTMLElement>("[data-font-footer]")!.textContent = "读取失败，可刷新或手动填写路径";
      } finally { this.loading = undefined; }
    })();
    return this.loading;
  }

  private renderRows(): void {
    if (!this.menu) return;
    const search = this.menu.querySelector<HTMLInputElement>("[data-font-search]")!;
    const query = search.value.trim().toLocaleLowerCase();
    const list = this.menu.querySelector<HTMLElement>("[data-font-list]")!;
    this.observer?.disconnect();
    const pending = new Map<Element, SystemFont>();
    this.observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver(entries => {
      for (const entry of entries) {
        const font = pending.get(entry.target);
        if (entry.isIntersecting && font) {
          (entry.target as HTMLElement).style.fontFamily = this.preview(font);
          this.observer?.unobserve(entry.target);
          pending.delete(entry.target);
        }
      }
    }, { root: list, rootMargin: "64px" });
    list.replaceChildren();
    this.rows = [];
    this.active = -1;
    search.removeAttribute("aria-activedescendant");
    const value = this.input.value.trim();
    const add = (font?: SystemFont) => {
      const row = document.createElement("button");
      const selected = value === (font?.path || "");
      row.type = "button";
      row.tabIndex = -1;
      row.className = "paper-manager-font-option";
      row.id = `${this.id}-option-${this.rows.length}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(selected));
      row.innerHTML = `<span class="paper-manager-font-check" aria-hidden="true">${selected ? "✓" : ""}</span><span class="paper-manager-font-option-name">${escapeHtml(font?.name || "自动选择字体")}</span>`;
      if (font) {
        const label = row.querySelector<HTMLElement>(".paper-manager-font-option-name")!;
        if (this.observer) { pending.set(label, font); this.observer.observe(label); }
        else label.style.fontFamily = `${JSON.stringify(font.family)}, sans-serif`;
        row.title = font.path;
      }
      row.addEventListener("click", () => this.select(font));
      this.rows.push(row);
      list.append(row);
    };
    const heading = (text: string) => {
      const element = document.createElement("div");
      element.className = "paper-manager-font-group";
      element.textContent = text;
      list.append(element);
    };
    if (!query) add();
    const matches = (font: SystemFont) => `${font.name} ${font.family} ${font.postscriptName} ${font.path}`.toLocaleLowerCase().includes(query);
    const recent = this.recent.map(path => this.fonts?.find(font => font.path === path)).filter((font): font is SystemFont => Boolean(font && matches(font)));
    if (recent.length) { heading("最近使用"); recent.forEach(add); }
    const fonts = this.fonts?.filter(matches) ?? [];
    if (fonts.length) { heading("本机字体"); fonts.forEach(add); }
    else if (this.fonts) heading(query ? "没有匹配的字体" : "未找到字体，可手动填写路径");
    this.menu.querySelector<HTMLElement>("[data-font-footer]")!.textContent = this.fonts ? `${fonts.length} 款字体 · 选择后使用对应文件` : "正在读取本机字体…";
  }

  private select(font?: SystemFont): void {
    if (font && !this.exists(font.path)) { this.status.hidden = false; this.status.textContent = "字体文件已移除，请刷新列表"; return; }
    this.input.value = font?.path || "";
    if (font) {
      this.recent = [font.path, ...this.recent.filter(path => path !== font.path)].slice(0, 5);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent)); } catch { /* Storage is optional. */ }
    }
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    this.update();
    this.close();
    this.trigger.focus();
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); this.trigger.focus(); return; }
    if (event.key === "Tab") { this.close(); this.trigger.focus(); return; }
    if (event.key === "Enter") { event.preventDefault(); if (this.active >= 0) this.rows[this.active]?.click(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!this.rows.length) return;
    event.preventDefault();
    this.active = event.key === "Home" ? 0 : event.key === "End" ? this.rows.length - 1 : (this.active + (event.key === "ArrowDown" ? 1 : -1) + this.rows.length) % this.rows.length;
    for (const [index, row] of this.rows.entries()) row.dataset.active = String(index === this.active);
    const row = this.rows[this.active]!;
    this.menu?.querySelector("[data-font-search]")?.setAttribute("aria-activedescendant", row.id);
    row.scrollIntoView({ block: "nearest" });
  }

  private removeMenuListeners?: () => void;
  private readonly closeOnResize = () => this.close();

  close(): void {
    this.observer?.disconnect();
    this.removeMenuListeners?.();
    this.removeMenuListeners = undefined;
    this.menu?.remove();
    this.menu = undefined;
    this.rows = [];
    this.trigger.setAttribute("aria-expanded", "false");
  }

  destroy(): void {
    this.close();
    this.controller.abort();
    for (const { face } of this.previews.values()) document.fonts.delete(face);
    this.previews.clear();
  }
}
