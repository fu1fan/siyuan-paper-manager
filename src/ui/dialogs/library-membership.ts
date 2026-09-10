import { Dialog } from "siyuan";
import type { MembershipDifference, MembershipScan } from "../../services/library-membership";
import { differenceKey } from "../../services/library-membership";
import { button, escapeHtml } from "../dom";

export function openMembershipDialog(initial: MembershipScan,
  resolve: (selected: MembershipDifference[], action: "apply" | "mute") => Promise<string>,
  rescan: () => Promise<MembershipScan | null>,
  onClose: () => void): Dialog {
  let entries = initial.differences;
  const ignoredThisTime = new Set<string>();
  let busy = false;
  const dialog = new Dialog({ title: "文献库成员核对", width: "760px", destroyCallback: onClose,
    content: `<div class="b3-dialog__content paper-manager-dialog"><div class="paper-manager-dialog-scroll">
      <h3>${escapeHtml(initial.title)}</h3><p class="paper-manager-hint">以数据库为权威核对直属子笔记。勾选删除会通过思源文档历史可恢复的删除流程删除笔记及全部下级笔记；创建笔记仅恢复数据库中现有的信息，不恢复已丢失的阅读记录或附件。</p>
      <div data-membership-list></div><p class="paper-manager-hint">“本次忽略”下次打开仍会提醒。“不再提醒”保存到对应文档的隐藏属性；文档已删除时保存在文献库隐藏属性中。</p>
      <p data-membership-message role="status"></p></div><div class="paper-manager-dialog-footer"><div class="paper-manager-actions" data-membership-actions></div></div></div>` });
  const root = dialog.element;
  const list = root.querySelector<HTMLElement>("[data-membership-list]")!;
  const message = root.querySelector<HTMLElement>("[data-membership-message]")!;
  const render = () => {
    const labels = { "delete-note": "待删除笔记（数据库无对应成员）", "create-note": "待创建笔记（数据库成员缺失笔记）", "outside-note": "库外笔记（选择处理方式）" };
    list.innerHTML = (["delete-note", "create-note", "outside-note"] as const).map(kind => {
      const group = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === kind);
      return `<h4>${labels[kind]} · ${group.length}</h4>` + (group.length ? group.map(({ entry, index }) =>
        `<div style="margin:10px 0"><label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" data-member="${index}"><span>${escapeHtml(entry.title)}<small style="display:block;opacity:.65">${escapeHtml(entry.docId || `数据库行 ${entry.itemId}`)}</small></span></label>
        ${kind === "delete-note" ? `<p class="paper-manager-hint">将删除此笔记及 ${entry.descendantIds?.length ?? 0} 篇下级笔记（整棵子树）。</p>` : ""}
        ${entry.blockedReason ? `<p class="paper-manager-hint">${escapeHtml(entry.blockedReason)}</p>` : ""}
        ${entry.pending ? '<p class="paper-manager-hint">上次创建尚未完成，将复用已分配的笔记继续处理。</p>' : ""}
        ${kind === "outside-note" && !entry.pending ? `<select class="b3-select" data-outside="${index}" aria-label="${escapeHtml(entry.title)}的处理方式"><option value="move" ${entry.outsideAction !== "copy" ? "selected" : ""}>移回原笔记（保留正文与文档 ID）</option><option value="copy" ${entry.outsideAction === "copy" ? "selected" : ""}>按数据库新建副本并换绑（保留库外原笔记）</option></select>` : ""}</div>`).join("") : '<p class="paper-manager-hint">无</p>');
    }).join("");
    list.querySelectorAll<HTMLSelectElement>("[data-outside]").forEach(select => {
      select.onchange = () => { entries[Number(select.dataset.outside)]!.outsideAction = select.value as "move" | "copy"; };
    });
  };
  const apply = button("应用勾选更改", true);
  const ignore = button("本次忽略勾选项");
  const mute = button("勾选项不再提醒");
  const close = button("关闭");
  const all = button("全选");
  root.querySelector("[data-membership-actions]")!.append(all, ignore, mute, apply, close);
  const selected = () => Array.from(list.querySelectorAll<HTMLInputElement>("[data-member]:checked"))
    .map(input => entries[Number(input.dataset.member)]!).filter(Boolean);
  all.onclick = () => list.querySelectorAll<HTMLInputElement>("[data-member]").forEach(input => { input.checked = true; });
  ignore.onclick = () => {
    const chosen = new Set(selected());
    if (!chosen.size) { message.textContent = "请先勾选需要忽略的条目。"; return; }
    for (const entry of chosen) ignoredThisTime.add(differenceKey(entry));
    entries = entries.filter(entry => !chosen.has(entry));
    if (!entries.length) dialog.destroy(); else render();
  };
  close.onclick = () => { if (!busy) dialog.destroy(); };
  const run = async (action: "apply" | "mute") => {
    const chosen = selected();
    if (!chosen.length || busy) { message.textContent = "请先勾选需要处理的条目。"; return; }
    busy = true;
    root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select").forEach(control => { control.disabled = true; });
    message.textContent = "正在重新核对并处理勾选项…";
    try {
      message.textContent = await resolve(chosen, action);
      const scan = await rescan();
      entries = (scan?.differences ?? []).filter(entry => !ignoredThisTime.has(differenceKey(entry)));
      render();
    } catch (error) { message.textContent = `处理未完成：${error instanceof Error ? error.message : String(error)}`; }
    finally {
      busy = false;
      root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select").forEach(control => { control.disabled = false; });
    }
  };
  apply.onclick = () => { void run("apply"); };
  mute.onclick = () => { void run("mute"); };
  render();
  return dialog;
}
