import { showMessage, type Dialog, type Plugin } from "siyuan";
import type { ItemProcessor } from "../services/item-processor";
import type { LibraryMembershipService } from "../services/library-membership";
import { currentDocumentId } from "./dom";
import { openMembershipDialog } from "./dialogs/library-membership";

/** One check per document activation, with a delay to let imports finish binding. */
export function monitorLibraryMembership(plugin: Plugin, service: LibraryMembershipService, processor: ItemProcessor): () => void {
  let lastDoc = "";
  let generation = 0;
  let disposed = false;
  let dialog: Dialog | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (docId: string, reopened = false) => {
    if (!docId || disposed || (!reopened && docId === lastDoc)) return;
    lastDoc = docId;
    const request = ++generation;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (dialog || disposed) return;
      void processor.runMembershipChange(() => service.scan(docId)).then(scan => {
        if (disposed || request !== generation || dialog || currentDocumentId() !== docId || !scan?.differences.length) return;
        dialog = openMembershipDialog(scan, async (entries, action) => {
          const result = await processor.runMembershipChange(() => service.resolve(docId, entries, action));
          return `已${action === "mute" ? "设为不再提醒" : "应用"} ${result.changed} 项；状态已变化，跳过 ${result.skipped} 项。`
            + (result.failures.length ? ` 失败：${result.failures.join("；")}` : "");
        }, () => service.scan(docId), () => { dialog = undefined; });
      }).catch(error => {
        if (!disposed && request === generation) showMessage(`文献库成员核对失败：${error instanceof Error ? error.message : String(error)}`, 6000, "error");
      });
    }, 1200);
  };
  const listener = (event: CustomEvent<{ protyle?: { block?: { rootID?: string } } }>) => {
    const id = event.detail.protyle?.block?.rootID;
    // Background restored tabs must not supersede the visible document.
    if (id && currentDocumentId() === id) check(id);
  };
  const loaded = (event: CustomEvent<{ protyle?: { block?: { rootID?: string } } }>) => {
    const id = event.detail.protyle?.block?.rootID;
    if (id && currentDocumentId() === id) check(id, true);
  };
  plugin.eventBus.on("switch-protyle", listener);
  plugin.eventBus.on("loaded-protyle-static", loaded);
  const startup = setTimeout(() => check(currentDocumentId() ?? ""), 1500);
  return () => {
    disposed = true; generation++;
    clearTimeout(timer); clearTimeout(startup);
    plugin.eventBus.off("switch-protyle", listener);
    plugin.eventBus.off("loaded-protyle-static", loaded);
    dialog?.destroy();
  };
}
