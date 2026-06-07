const locks = new Map<string, Promise<unknown>>();

/**
 * Serializes async work by key so concurrent callers with the same key run one-at-a-time.
 * Used to stop two downloads of the same source URL from racing on the same cache file.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}
