/** Bounds apply before copying files or expanding PDF text into layout objects. */
export const MAX_LOCAL_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_TEXT_ITEMS = 20_000;
export const MAX_PDF_TEXT_CHARS = 1_000_000;
export const MAX_RECOGNIZER_WORDS = 10_000;

export function assertPdfSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LOCAL_PDF_BYTES) {
    throw new Error("PDF 文件超过 64 MiB，无法导入；请压缩或拆分后重试");
  }
}

export async function readLocalPdf(file: Pick<File, "size" | "arrayBuffer">): Promise<Uint8Array> {
  assertPdfSize(file.size);
  const buffer = await file.arrayBuffer();
  assertPdfSize(buffer.byteLength);
  return new Uint8Array(buffer);
}

export function assertPdfTextBudget(items: readonly { str: string }[], signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (items.length > MAX_PDF_TEXT_ITEMS) throw new Error("PDF 单页文字项超过 20000，已停止解析");
  let length = 0;
  for (const item of items) {
    length += item.str.length;
    if (length > MAX_PDF_TEXT_CHARS) throw new Error("PDF 单页文字超过 100 万字符，已停止解析");
  }
}
