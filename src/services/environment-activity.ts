/** Shared by the deployment UI and every single/batch translation entry point. */
export class EnvironmentActivity {
  private translations = 0;
  private mutation = false;

  acquireTranslation(): () => void {
    if (this.mutation) throw new Error("翻译环境正在安装、升级或修复，请完成后再开始翻译");
    this.translations++;
    return this.once(() => { this.translations--; });
  }

  acquireMutation(): () => void {
    if (this.mutation) throw new Error("已有翻译环境操作正在执行");
    if (this.translations) throw new Error("有翻译任务正在执行或排队，请完成后再管理 pdf2zh");
    this.mutation = true;
    return this.once(() => { this.mutation = false; });
  }

  private once(work: () => void): () => void {
    let released = false;
    return () => { if (!released) { released = true; work(); } };
  }
}

export const pdf2zhActivity = new EnvironmentActivity();
