import { ArxivClient, retryAfterMs } from '../src/services/arxiv-client';
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
it('spaces different requests and reuses duplicate results', async () => {
  const client = new ArxivClient();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('<feed><entry><title>Paper</title></entry></feed>'));
  const a = client.query('2302.11665', fetcher);
  const b = client.query('2302.11665', fetcher);
  const c = client.query('2302.11666', fetcher);
  await vi.advanceTimersByTimeAsync(0);
  expect(await a).toBe(await b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await c;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([429, 200])('stops on rate exceeded with status %s and honors long Retry-After', async status => {
  const client = new ArxivClient();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Rate exceeded.', { status, headers: { 'Retry-After': '120' } }));
  const first = expect(client.query('1', fetcher)).rejects.toThrow('频率受限');
  await vi.advanceTimersByTimeAsync(0); await first;
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(client.query('2', fetcher)).rejects.toThrow('冷却');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not retry resets, including a second lookup', async () => {
  const client = new ArxivClient();
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('ERR_CONNECTION_RESET'));
  const first = expect(client.query('1', fetcher)).rejects.toThrow('RESET');
  await vi.advanceTimersByTimeAsync(0); await first;
  await expect(client.query('1', fetcher)).rejects.toThrow('冷却');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('cancels queued requests before sending', async () => {
  const client = new ArxivClient();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('<entry>paper</entry>'));
  const first = client.query('1', fetcher);
  await vi.advanceTimersByTimeAsync(0); await first;
  const controller = new AbortController();
  const second = expect(client.query('2', fetcher, controller.signal)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1); controller.abort(); await second;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('parses both Retry-After forms without a five second cap', () => {
  expect(retryAfterMs('120')).toBe(120_000);
  expect(retryAfterMs(new Date(Date.now() + 120_000).toUTCString())).toBeGreaterThan(119_000);
  expect(retryAfterMs('invalid')).toBe(0);
});
