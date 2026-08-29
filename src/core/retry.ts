/**
 * 反复调用直到结果满足断言。attempts 为满足断言失败后的额外重试次数，
 * 即最多调用 attempts + 1 次；返回最后一次结果（可能仍不满足断言）。
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  attempts = 5,
  delayMs = 120,
): Promise<T> {
  let value = await fn();
  for (let attempt = 0; attempt < attempts && !predicate(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    value = await fn();
  }
  return value;
}
