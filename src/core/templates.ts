import { ATTR, PLUGIN_NAME, SECTION } from "../constants";
import type { PaperData } from "../types/paper";
import type { PluginStatus } from "../types/status";
import { KernelClient } from "./kernel";
import { safeAssetUrl, safeExternalUrl } from "./normalize";
import { renderTemplateText } from "./template-engine";
import { newNodeId } from "./node-id";

export type TemplateName = "paper-meta" | "paper-note";
export type TemplateMode = PluginStatus["templateMode"];

export interface RenderedTemplate {
  dataType: "markdown" | "dom";
  content: string;
  mode: Exclude<TemplateMode, "unknown">;
}

export interface PaperSectionIds {
  meta: string;
  note: string;
}

export interface TemplateServiceOptions {
  pluginName?: string;
  loadTemplate?: (name: TemplateName) => Promise<string>;
  onModeChange?: (mode: TemplateMode) => void;
}

export class TemplateService {
  private readonly pluginName: string;
  private mode: TemplateMode = "unknown";
  private readonly cache = new Map<TemplateName, string>();

  constructor(private readonly kernel: KernelClient, private readonly options: TemplateServiceOptions = {}) {
    this.pluginName = options.pluginName ?? PLUGIN_NAME;
  }

  getMode(): TemplateMode {
    return this.mode;
  }

  async renderBuiltin(name: TemplateName, data: PaperData): Promise<string> {
    this.setMode("builtin");
    return renderTemplateText(await this.template(name), templateContext(data));
  }

  async render(name: TemplateName, data: PaperData, _hostDocId: string): Promise<RenderedTemplate> {
    return {
      dataType: "markdown",
      content: await this.renderBuiltin(name, data),
      mode: "builtin",
    };
  }

  async ensureSections(docId: string, data: PaperData): Promise<PaperSectionIds> {
    let meta = await retry(() => this.kernel.findSectionBlock(docId, SECTION.meta), 4, 120);
    let note = await retry(() => this.kernel.findSectionBlock(docId, SECTION.note), 4, 120);

    // SiYuan 3.8.x may create the super blocks before their trailing custom IAL
    // is queryable. Adopt those containers instead of appending duplicates.
    if (!meta || !note) {
      const claimed = new Set([meta, note].filter((id): id is string => Boolean(id)));
      const available = (await this.kernel.listTopLevelSuperBlocks(docId)).filter((id) => !claimed.has(id));
      if (!meta && available.length) {
        meta = available.shift()!;
        await this.kernel.setBlockAttrs(meta, { [ATTR.section]: SECTION.meta });
      }
      if (!note && available.length) {
        note = available.shift()!;
        await this.kernel.setBlockAttrs(note, { [ATTR.section]: SECTION.note });
      }
    }

    meta ||= await this.appendSection(docId, SECTION.meta, "paper-meta", data);
    note ||= await this.appendSection(docId, SECTION.note, "paper-note", data);
    return { meta, note };
  }

  async refreshMeta(docId: string, data: PaperData, knownBlockId?: string): Promise<void> {
    await this.refreshSection(docId, SECTION.meta, "paper-meta", data, knownBlockId);
  }

  async refreshSection(
    docId: string,
    section: "meta" | "note",
    name: TemplateName,
    data: PaperData,
    knownBlockId?: string,
  ): Promise<void> {
    const blockId = knownBlockId ?? await retry(() => this.kernel.findSectionBlock(docId, section), 8, 250);
    if (!blockId) throw new Error(`未找到 ${section} 模板容器`);
    const rendered = await this.render(name, data, docId);
    const previous = await this.kernel.getBlockKramdown(blockId);
    if (!previous.kramdown) throw new Error(`无法读取 ${section} 容器 Kramdown`);
    if (rendered.dataType === "markdown") {
      await this.kernel.updateBlock(blockId, preserveRootIal(rendered.content, blockId, section), "markdown", true);
    } else {
      await this.kernel.updateBlock(blockId, preserveRootDom(rendered.content, blockId, section), "dom", true);
    }
    await this.kernel.setBlockAttrs(blockId, { [ATTR.section]: section });
    const attrs = await this.kernel.getBlockAttrs(blockId);
    if (attrs[ATTR.section] !== section) throw new Error(`${section} 容器标记在刷新后丢失`);
  }

  private async appendSection(
    docId: string,
    section: "meta" | "note",
    name: TemplateName,
    data: PaperData,
  ): Promise<string> {
    const requestedId = newNodeId();
    const markdown = preserveRootIal(await this.renderBuiltin(name, data), requestedId, section);
    const operationIds = await this.kernel.appendBlock(docId, markdown, "markdown");
    const blockId = operationIds.includes(requestedId) ? requestedId : operationIds[0] ?? requestedId;
    await this.kernel.setBlockAttrs(blockId, { [ATTR.section]: section });
    const attrs = await this.kernel.getBlockAttrs(blockId);
    if (attrs[ATTR.section] !== section) throw new Error(`创建 ${section} 模板容器失败`);
    return blockId;
  }

  private async template(name: TemplateName): Promise<string> {
    const existing = this.cache.get(name);
    if (existing) return existing;
    const content = this.options.loadTemplate
      ? await this.options.loadTemplate(name)
      : await this.kernel.readPluginFile(`/data/plugins/${this.pluginName}/templates/${name}.md`);
    this.cache.set(name, content);
    return content;
  }

  private setMode(mode: TemplateMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.options.onModeChange?.(mode);
  }
}

export function templateContext(data: PaperData): Record<string, unknown> {
  const canonical = data.canonical;
  return {
    itemType: markdownText(canonical.itemType),
    title: markdownText(canonical.title),
    authors: canonical.creators.map((creator, index) => ({
      display: markdownText([creator.family, creator.given].filter(Boolean).join(", ")),
      separator: index < canonical.creators.length - 1 ? "；" : "",
    })),
    date: markdownText(canonical.date),
    journal: markdownText(canonical.journal),
    volume: markdownText(canonical.volume),
    issue: markdownText(canonical.issue),
    pages: markdownText(canonical.pages),
    doi: markdownText(canonical.doi),
    isbn: markdownText(canonical.isbn),
    issn: markdownText(canonical.issn),
    publisher: markdownText(canonical.publisher),
    url: safeExternalUrl(canonical.url),
    abstract: markdownText(canonical.abstract),
    tags: canonical.tags.map((tag, index) => ({
      display: markdownText(tag),
      separator: index < canonical.tags.length - 1 ? "、" : "",
    })),
    attachments: data.attachments.flatMap((attachment) => {
      const url = safeAssetUrl(attachment.assetAddress);
      return url ? [{ title: markdownText(attachment.title), url }] : [];
    }),
    translationMono: safeAssetUrl(data.translation.mono),
    translationDual: safeAssetUrl(data.translation.dual),
    hasTranslation: Boolean(data.translation.mono || data.translation.dual),
    citekey: markdownText(data.citekey),
  };
}

function markdownText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\r/g, "")
    .trim();
}

function preserveRootIal(markdown: string, blockId: string, section: string): string {
  const ial = `{: id="${blockId}" custom-section="${section}"}`;
  const trimmed = markdown.trimEnd();
  if (/\{:\s+[^\n]*\}\s*$/.test(trimmed)) {
    return `${trimmed.replace(/\{:\s+[^\n]*\}\s*$/, ial)}\n`;
  }
  return `${trimmed}\n${ial}\n`;
}

function preserveRootDom(dom: string, blockId: string, section: string): string {
  let output = dom.trim();
  output = output.replace(/data-node-id="[^"]+"/, `data-node-id="${blockId}"`);
  const rootEnd = output.indexOf(">");
  if (rootEnd >= 0) {
    const root = output.slice(0, rootEnd);
    const marked = /custom-section=/.test(root)
      ? root.replace(/custom-section="[^"]*"/, `custom-section="${section}"`)
      : `${root} custom-section="${section}"`;
    output = `${marked}${output.slice(rootEnd)}`;
  }
  return output;
}

async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let last: T;
  for (let index = 0; index < attempts; index += 1) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last!;
}
