const BLOCK = 4096;

/** Disk space a file of this size occupies, assuming the common 4 KiB cluster. */
export const allocated = (size) => Math.ceil(size / BLOCK) * BLOCK;

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(value) : value.toFixed(value >= 100 ? 0 : 1);
  return `${bytes < 0 ? '-' : ''}${text} ${units[unit]}`;
}

/** Runs fn over items with bounded concurrency; a rejection aborts the run. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
