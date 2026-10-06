import { Dialog, showMessage } from "siyuan";
import { canUseNode } from "../../core/env";
import { errorMessage } from "../../core/errors";
import { escapeHtml } from "../dom";

export interface IntroductionActions {
  onDismiss: () => Promise<void>;
  createLibrary: () => Promise<void>;
  openTranslation: () => void;
}

const STEPS = [
  { label: "收集", title: "把论文带进思源", description: "选择本地 PDF，或粘贴 DOI、arXiv 链接和 BibTeX。核对识别结果后，一次导入论文、元数据和附件。桌面端还可以接收 Zotero Connector。", image: "import.jpg", alt: "临时思源工作空间中，导入论文并核对元数据的真实界面", tip: "从顶栏「论文管理 → 导入本地 PDF」开始。", flow: ["PDF / DOI", "核对元数据", "导入文献库"] },
  { label: "整理", title: "你的文献库，就是思源数据库", description: "在原生数据库中查看标题、作者、年份和处理状态。使用思源的筛选、排序和视图整理文献，也可以建立多个文献库。", image: "library.jpg", alt: "临时思源工作空间中的论文文献库原生数据库", tip: "每篇论文都是文献库下的独立文档，元数据可在数据库中直接修改。", flow: ["论文文档", "原生数据库", "筛选与整理"] },
  { label: "使用", title: "从阅读笔记，到参考文献", description: "在论文页打开原文、记录阅读笔记。写作时导出 GB/T 7714、APA、BibTeX 或 Typst 等格式的引用，复制或保存后直接使用。", image: "citations.jpg", alt: "临时思源工作空间中选择论文并预览引用导出的真实界面", tip: "文献库右键菜单中可导出引用，也可批量翻译未翻译论文（桌面端）。", flow: ["阅读与笔记", "选择论文", "导出引用"] },
  { label: "翻译", title: "准备 PDF2ZH 翻译", description: "翻译是可选功能。桌面端使用 PDF2ZH 生成单语或双语 PDF；安装并配置服务后即可使用。", image: "translation.jpg", alt: "临时思源工作空间中的 pdf2zh 服务、模型与密钥名称配置", tip: "「测试密钥」检查名称是否可读取；服务连接和翻译结果需要用真实 PDF 验证。", flow: ["安装 pdf2zh", "映射密钥", "翻译 PDF"] },
] as const;

/** A replayable introduction; it never starts an installation or asks for a secret value. */
export function openIntroductionDialog(actions: IntroductionActions): Dialog {
  let index = 0;
  let dismissed = false;
  let dismissPromise: Promise<void> | undefined;
  let preview: Dialog | undefined;
  let busy = false;
  let closed = false;
  const markDismissed = async () => {
    if (dismissed) return;
    dismissPromise ??= actions.onDismiss().then(() => { dismissed = true; }).catch(error => { dismissPromise = undefined; throw error; });
    await dismissPromise;
  };
  const dialog = new Dialog({
    title: "欢迎使用论文管理",
    width: "min(960px, calc(100vw - 24px))",
    content: `<div class="paper-manager-intro"><nav class="paper-manager-intro-steps" aria-label="使用指南步骤">${STEPS.map((step, i) => `<button type="button" data-intro-step="${i}"><span>${i + 1}</span>${step.label}</button>`).join("")}</nav><div class="paper-manager-intro-body" data-intro-body></div><footer class="paper-manager-intro-footer"><button type="button" class="b3-button b3-button--text" data-intro-later>稍后再看</button><span class="paper-manager-intro-page" data-intro-page aria-live="polite"></span><button type="button" class="b3-button b3-button--outline" data-intro-back>上一步</button><button type="button" class="b3-button" data-intro-next>下一步</button></footer></div>`,
    destroyCallback: () => { closed = true; preview?.destroy(); void markDismissed().catch(error => showMessage(`使用指南状态保存失败：${errorMessage(error)}`, 5000, "error")); },
  });
  dialog.element.querySelector(".b3-dialog__container")?.classList.add("paper-manager-intro-dialog");
  const root = dialog.element;
  const body = root.querySelector<HTMLElement>("[data-intro-body]")!;
  const back = root.querySelector<HTMLButtonElement>("[data-intro-back]")!;
  const next = root.querySelector<HTMLButtonElement>("[data-intro-next]")!;
  const finish = async (action?: () => void | Promise<void>) => {
    if (busy) return;
    busy = true;
    root.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    try {
      await markDismissed();
      if (closed) return;
      dialog.destroy();
      await action?.();
    } catch (error) {
      showMessage(`使用指南：${errorMessage(error)}`, 7000, "error");
    } finally {
      busy = false;
      if (!closed) { root.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; }); render(); }
    }
  };
  const render = () => {
    const step = STEPS[index]!;
    const last = index === STEPS.length - 1;
    const desktop = canUseNode();
    root.querySelector(".paper-manager-intro")!.classList.toggle("paper-manager-intro--setup", last);
    const copy = `<div class="paper-manager-intro-copy"><div class="paper-manager-intro-eyebrow">论文管理 · ${index + 1} / ${STEPS.length}</div><h2>${step.title}</h2><p>${step.description}</p></div>`;
    const screenshot = `<figure class="paper-manager-intro-screenshot"><button type="button" class="paper-manager-intro-image" data-intro-image aria-label="查看${step.label}截图大图"><img src="/plugins/siyuan-paper-manager/onboarding/${step.image}" alt="${escapeHtml(step.alt)}" draggable="false"></button><figcaption><span>思源笔记 · 真实使用截图</span><span>点击放大 ↗</span></figcaption></figure>`;
    const tip = `<p class="paper-manager-intro-tip">${step.tip}</p>`;
    const workflow = `<ol class="paper-manager-intro-flow" aria-hidden="true">${step.flow.map((label, i) => `<li class="paper-manager-intro-chip" style="--intro-delay:${i * 90}ms"><span>${i + 1}</span>${label}</li>`).join("")}</ol>`;
    body.innerHTML = last
      ? `<section class="paper-manager-intro-slide paper-manager-intro-slide--setup">
          <div class="paper-manager-intro-setup-heading">${copy}${screenshot}</div>
          <div class="paper-manager-intro-setup">
            <div class="paper-manager-intro-setup-card"><h3><span>1</span> 安装 PDF2ZH</h3>
              <p>在「插件设置 → 翻译」中扫描已有安装，或：</p>
              <ol><li>点击安装，自动准备 uv 和 Python；可展开自定义下载源。</li><li>安装后保存设置（部署功能测试中）。</li></ol>
              <div class="paper-manager-intro-command"><span>也可手动安装，再填写可执行文件路径</span><code>uv tool install --python 3.12 --with tencentcloud-sdk-python-tmt==3.1.70 pdf2zh</code></div>
              <a href="https://github.com/PDFMathTranslate/PDFMathTranslate#32-local-installation" target="_blank" rel="noopener noreferrer">官方安装说明 ↗</a>
            </div>
            <div class="paper-manager-intro-setup-card"><h3><span>2</span> 配置服务与密钥</h3>
              <ol><li>在思源「设置 → 密钥和变量」中新建密钥，命名为 <code>paper-translation</code>。</li><li>在插件中选择服务与模型，在密钥栏填写这个<strong>名称</strong>。</li><li>测试密钥后，保存设置。</li></ol>
              <p class="paper-manager-hint">密钥值保存在思源中；插件只保存名称。Google 等服务无需密钥。</p>
            </div>
          </div>
          <div class="paper-manager-intro-start">${!desktop ? '<p class="paper-manager-intro-device">本地翻译需在思源桌面端安装与配置；网页版仍可管理文献和阅读同步的译文。</p>' : ""}<div class="paper-manager-intro-final"><button type="button" class="b3-button b3-button--outline" data-intro-library>先创建文献库</button><button type="button" class="b3-button" data-intro-translation ${desktop ? "" : "disabled"}>前往翻译设置 ↗</button></div>${tip}</div>
        </section>`
      : `<section class="paper-manager-intro-slide"><div class="paper-manager-intro-overview">${copy}${workflow}${tip}</div>${screenshot}</section>`;
    root.querySelectorAll<HTMLButtonElement>("[data-intro-step]").forEach((button, i) => { button.setAttribute("aria-current", i === index ? "step" : "false"); });
    root.querySelector("[data-intro-page]")!.textContent = `${index + 1} / ${STEPS.length}`;
    back.disabled = index === 0;
    next.textContent = last ? "完成介绍" : "下一步";
    body.scrollTop = 0;
    body.querySelector("[data-intro-image]")?.addEventListener("click", () => {
      if (busy) return;
      preview = new Dialog({ title: `${step.label} · 真实使用截图`, width: "min(1200px, calc(100vw - 24px))",
        content: `<div class="paper-manager-intro-preview"><img src="/plugins/siyuan-paper-manager/onboarding/${step.image}" alt="${escapeHtml(step.alt)}"></div>` });
    });
    body.querySelector("[data-intro-library]")?.addEventListener("click", () => void finish(actions.createLibrary));
    body.querySelector("[data-intro-translation]")?.addEventListener("click", () => void finish(actions.openTranslation));
  };
  root.querySelectorAll<HTMLButtonElement>("[data-intro-step]").forEach((button, i) => button.addEventListener("click", () => { if (!busy) { index = i; render(); } }));
  root.querySelector("[data-intro-later]")!.addEventListener("click", () => void finish());
  back.addEventListener("click", () => { if (!busy && index > 0) { index--; render(); } });
  next.addEventListener("click", () => { if (busy) return; if (index === STEPS.length - 1) void finish(); else { index++; render(); } });
  render();
  return dialog;
}
