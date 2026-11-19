// At most `limit` tasks run at once. Later tasks start as earlier ones settle.
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  }
  if (!items.length) return results;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
