export const MAX_METADATA_BYTES = 8 * 1024 * 1024;

/** Count decoded stream bytes too: Content-Length can be absent, false or compressed. */
export async function readMetadataBody(response: Response, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) { signal?.throwIfAborted(); return new Uint8Array(); }
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    if (Number(response.headers.get("content-length")) > MAX_METADATA_BYTES) throw new Error("元数据响应超过 8 MiB");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_METADATA_BYTES) throw new Error("元数据响应超过 8 MiB");
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    // Do not wait for an untrusted underlying source to acknowledge cancellation.
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
