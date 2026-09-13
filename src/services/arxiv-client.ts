/** Shared by all extractors in this plugin window. Never retry an arXiv failure immediately. */
export class ArxivClient {
  private tail: Promise<unknown> = Promise.resolve();
  private nextStart = 0;
  private cooldown = 0;
  private cache = new Map<string, { text: string; expires: number }>();

  query(id: string, fetchImpl: typeof fetch, signal?: AbortSignal, timeoutMs = 10_000, onProgress?: (status: string) => void): Promise<string> {
    const work = this.tail.then(async () => {
      signal?.throwIfAborted();
      const cached = this.cache.get(id);
      if (cached && cached.expires > Date.now()) { onProgress?.(`正在使用 arXiv 缓存：${id}（不重复请求）`); return cached.text; }
      const checkCooldown = () => {
        if (this.cooldown > Date.now()) throw new Error(`arXiv 请求冷却中，请在 ${Math.ceil((this.cooldown - Date.now()) / 1000)} 秒后重试`);
      };
      checkCooldown();
      const delay = Math.max(0, this.nextStart - Date.now());
      if (delay) onProgress?.(`正在等待 arXiv API 请求间隔：${Math.ceil(delay / 1000)} 秒`);
      await wait(delay, signal);
      signal?.throwIfAborted();
      checkCooldown();
      this.nextStart = Date.now() + 3_000;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, timeoutMs);
      try {
        onProgress?.(`正在请求 arXiv API（export.arxiv.org/api/query）：${id}，超时上限 ${timeoutMs / 1000} 秒`);
        const response = await fetchImpl(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { signal: controller.signal });
        const text = await response.text();
        if (response.status === 429 || /rate\s+exceeded/i.test(text)) {
          this.cooldown = Date.now() + Math.max(60_000, retryAfterMs(response.headers.get('Retry-After')));
          throw new Error('arXiv 请求频率受限，已暂停请求，请稍后重试');
        }
        if (!response.ok) {
          this.cooldown = Date.now() + Math.max(60_000, retryAfterMs(response.headers.get('Retry-After')));
          throw new Error(`HTTP ${response.status}`);
        }
        if (/<entry[\s>]/i.test(text) && !/arxiv\.org\/api\/errors/.test(text)) {
          if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(id, { text, expires: Date.now() + 10 * 60_000 });
        }
        return text;
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        this.cooldown = Math.max(this.cooldown, Date.now() + 60_000);
        if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs / 1000}秒）`);
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
}

export function retryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export const arxivClient = new ArxivClient();
