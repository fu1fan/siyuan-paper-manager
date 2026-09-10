import { openMetadataEditor } from "./ui/dialogs/edit-metadata";
import { disposeCnkiClient } from "./services/cnki-desktop";
import { Dialog, Plugin, confirm, getFrontend, showMessage } from "siyuan";
import { ATTR, PLUGIN_NAME } from "./constants";
import { canUseNode, getPluginTempDir } from "./core/env";
import { KernelClient } from "./core/kernel";
import { StatusStore } from "./core/status";
import { TemplateService } from "./core/templates";
import { ConnectorServer } from "./server/connector-server";
import { buildEnvironmentReport } from "./services/environment-check";
import { ItemProcessor } from "./services/item-processor";
import { SettingsStore } from "./services/settings-store";
import { TranslatorService } from "./services/translator";
import { LibraryService } from "./services/library-service";
import type { PluginSettings } from "./types/settings";
import { resolveDuplicateDialog } from "./ui/dialogs/duplicate";
import { openImportPdfDialog } from "./ui/dialogs/import-pdf";
import { registerPaperUi } from "./ui/commands";
import { escapeHtml } from "./ui/dom";
import { SettingsPanel } from "./ui/settings";
import { mountTranslationStatusBar } from "./ui/statusbar";
import { openOnboardingDialog } from "./ui/dialogs/onboarding";
import { openCitationExportDialog } from "./ui/dialogs/export-citations";
import { LibraryMembershipService } from "./services/library-membership";
import { monitorLibraryMembership } from "./ui/library-membership-monitor";

export default class PaperManagerPlugin extends Plugin {
  private readonly kernelClient = new KernelClient();
  private readonly statusStore = new StatusStore();
  private settingsStore!: SettingsStore;
  private settings!: PluginSettings;
  private settingsPanel!: SettingsPanel;
  private templates!: TemplateService;
  private processor!: ItemProcessor;
  private libraries!: LibraryService;
  private translator: TranslatorService | null = null;
  private connector: ConnectorServer | null = null;
  private cleanup: Array<() => void> = [];

  async onload(): Promise<void> {
    console.log(`[paper-manager] onload (${getFrontend()})`);
    this.settingsStore = new SettingsStore(this);
    this.settings = await this.settingsStore.load();
    this.templates = new TemplateService(this.kernelClient, {
      onModeChange: (templateMode) => this.statusStore.update({ templateMode }),
    });
    this.libraries = new LibraryService(this.kernelClient);
    this.processor = new ItemProcessor(
      this.kernelClient,
      this.templates,
      () => this.settings,
      resolveDuplicateDialog,
      this.libraries,
    );
    if (canUseNode()) {
      this.translator = new TranslatorService(this.kernelClient, {
        onState: (translation) => this.statusStore.update({ translation }),
        readPaper: (docId) => this.libraries.readPaper(docId),
        persist: (docId, paper) => this.processor.persistAndRefresh(docId, paper),
      });
    }
    this.settingsPanel = new SettingsPanel(
      "论文管理",
      () => this.settings,
      this.kernelClient,
      this.libraries,
      (settings) => this.updateSettings(settings),
    );
    this.setting = this.settingsPanel.setting;
    this.cleanup.push(registerPaperUi(this, {
      importPdf: () => openImportPdfDialog(this.processor, () => this.settings),
      translate: (docId) => this.translate(docId),
      repair: (docId) => this.repair(docId),
      editMetadata: async (docId) => {
        const paper = await this.libraries.readPaper(docId);
        await openMetadataEditor(paper, () => this.settings,
          (draft, citekey) => this.processor.editMetadata(docId, paper.canonical, draft, { baseline: paper.citekey, value: citekey }),
          await this.libraries.citekeys(paper.libraryId, docId));
      },
      exportLibrary: (docId) => openCitationExportDialog(this.libraries, docId),
      openSettings: () => this.settingsPanel.open(),
      selfCheck: () => this.selfCheck(),
      toggleConnector: () => this.toggleConnector(),
      getStatus: () => this.statusStore.get(),
      detectDocKind: (docId) => this.detectDocKind(docId),
    }));
    this.cleanup.push(mountTranslationStatusBar(this, this.statusStore));
    this.cleanup.push(monitorLibraryMembership(this, new LibraryMembershipService(this.kernelClient, this.templates), this.processor));
    if (this.settings.autoListen) void this.startConnector();
  }

  onLayoutReady(): void {
    setTimeout(() => { void this.ensureOnboarding(); }, 500);
  }

  onunload(): void {
    disposeCnkiClient();
    console.log("[paper-manager] onunload");
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.translator?.cancel();
    if (this.connector) void this.connector.stop();
    this.connector = null;
  }

  private async updateSettings(next: PluginSettings): Promise<void> {
    const restart = next.zoteroPort !== this.settings.zoteroPort || next.autoListen !== this.settings.autoListen;
    await this.settingsStore.save(next);
    this.settings = next;
    if (restart) {
      await this.stopConnector();
      if (next.autoListen) await this.startConnector();
    }
  }

  private async ensureOnboarding(): Promise<void> {
    try {
      const libraries = await this.libraries.discoverLibraries();
      const current = libraries.find((library) => library.docId === this.settings.defaultLibraryDocId);
      if (current) {
        if (!this.settings.onboardingCompleted) {
          await this.updateSettings({ ...this.settings, onboardingCompleted: true });
        }
        return;
      }
      // 已有文献库但默认库指针丢失（如设置被旧草稿覆盖）：自动认领第一个，不再打扰
      if (libraries.length) {
        await this.updateSettings({
          ...this.settings,
          defaultLibraryDocId: libraries[0]!.docId,
          onboardingCompleted: true,
        });
        return;
      }
      await openOnboardingDialog(this.kernelClient, this.libraries, async (library) => {
        await this.updateSettings({ ...this.settings, defaultLibraryDocId: library.docId, onboardingCompleted: true });
      });
    } catch (error) {
      showMessage(`初始化文献库失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
    }
  }

  private async startConnector(): Promise<void> {
    if (this.connector) return;
    if (!canUseNode()) {
      const message = "Connector 仅支持带 Node 集成的思源桌面端";
      this.statusStore.update({ connector: { state: "error", message } });
      throw new Error(message);
    }
    try {
      const connector = new ConnectorServer({
        port: this.settings.zoteroPort,
        tempDirectory: getPluginTempDir(PLUGIN_NAME),
        onImport: (candidate) => this.enqueueImport(candidate),
        onAdditionalAttachments: (docId, attachments) => this.processor.addAttachments(docId, attachments),
        onStatus: (status) => this.statusStore.update({
          connector: status.error
            ? { state: "error", message: status.error }
            : status.listening
              ? { state: "listening", port: status.port }
              : { state: "stopped" },
        }),
        onProtocolError: (message) => showMessage(`Zotero Connector：${message}`, 5000, "error"),
      });
      await connector.start();
      this.connector = connector;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusStore.update({ connector: { state: "error", message } });
      showMessage(`Connector 启动失败：${message}`, 7000, "error");
    }
  }

  private async stopConnector(): Promise<void> {
    if (!this.connector) {
      this.statusStore.update({ connector: { state: "stopped" } });
      return;
    }
    const connector = this.connector;
    this.connector = null;
    await connector.stop();
  }

  private async toggleConnector(): Promise<void> {
    if (this.connector) await this.stopConnector();
    else await this.startConnector();
  }

  private async enqueueImport(candidate: Parameters<ItemProcessor["process"]>[0]): Promise<string | undefined> {
    try {
      const result = await this.processor.process(candidate);
      if (result.action === "cancelled") throw new Error("用户已取消导入");
      showMessage(`论文${actionLabel(result.action)}：${result.title}`, 5000, "info");
      return result.docId;
    } catch (error) {
      showMessage(`论文导入失败：${error instanceof Error ? error.message : String(error)}`, 7000, "error");
      throw error;
    }
  }

  private async detectDocKind(docId: string): Promise<"library" | "paper" | null> {
    const attrs = await this.kernelClient.getBlockAttrs(docId);
    if (attrs[ATTR.libraryData]) return "library";
    return (await this.libraries.findPaperEntry(docId)) ? "paper" : null;
  }

  private async repair(docId: string): Promise<void> {
    await this.processor.repair(docId);
    showMessage("论文元数据摘要已刷新", 4000, "info");
  }

  private async translate(docId: string): Promise<void> {
    if (!this.translator) throw new Error("当前环境不支持调用 pdf2zh 子进程");
    // 识别失败时抛出带具体环节原因的错误
    const entry = await this.libraries.requirePaperEntry(docId);
    const paper = await this.libraries.readPaper(docId, entry);
    if (paper.translation.mono || paper.translation.dual) {
      const cleanup = this.settings.autoDeleteOldTranslations
        ? "新版本及元数据保存成功后，插件会删除旧翻译资源。"
        : "插件会替换元数据链接，但保留旧翻译资源。";
      const accepted = await confirmAsync("重新翻译", `当前论文已有翻译版本。${cleanup}是否继续？`);
      if (!accepted) return;
    }
    const result = await this.translator.translate(docId, this.settings);
    const cleaned = result.deletedOldAssets.length ? `，已删除 ${result.deletedOldAssets.length} 个旧版本` : "";
    showMessage(`翻译完成，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒${cleaned}`, 6000, "info");
    if (result.cleanupWarnings.length) {
      showMessage(`新翻译已保存，但有 ${result.cleanupWarnings.length} 个旧资源删除失败`, 7000, "error");
    }
  }

  private async selfCheck(): Promise<void> {
    const report = await buildEnvironmentReport(this.settings, this.statusStore.get());
    const rows = Object.entries(report).map(([name, result]) =>
      `<section class="paper-manager-check-row"><div><strong>${escapeHtml(reportLabel(name))}</strong><span class="paper-manager-check-state" data-ok="${result.ok}">${result.ok ? "正常" : name === "template" && this.statusStore.get().templateMode === "unknown" ? "待验证" : "需处理"}</span></div><p>${escapeHtml(result.detail)}</p></section>`).join("");
    const dialog = new Dialog({
      title: "论文管理环境自检",
      width: "680px",
      content: `<div class="b3-dialog__content paper-manager-dialog"><div class="paper-manager-dialog-scroll paper-manager-form">${rows}
        <p class="paper-manager-hint">元数据与阅读笔记模板已内置。</p></div><div class="paper-manager-dialog-footer"><div class="paper-manager-actions"><button class="b3-button b3-button--cancel" data-check-close>关闭</button></div></div></div>`,
    });
    dialog.element.querySelector<HTMLButtonElement>("[data-check-close]")!.onclick = () => dialog.destroy();
  }
}

function confirmAsync(title: string, text: string): Promise<boolean> {
  return new Promise((resolve) => confirm(title, text, () => resolve(true), () => resolve(false)));
}

function actionLabel(action: "created" | "merged" | "copied"): string {
  return action === "created" ? "已创建" : action === "merged" ? "已合并" : "副本已创建";
}

function reportLabel(key: string): string {
  return ({ desktopNode: "桌面 Node 环境", connector: "Zotero Connector", pdf2zh: "pdf2zh", template: "模板引擎" } as Record<string, string>)[key] ?? key;
}
