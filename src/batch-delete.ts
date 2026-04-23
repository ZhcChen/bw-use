export interface BatchDeleteResult {
  successIds: string[];
  failedIds: string[];
}

export async function runBatchDelete(
  ids: string[],
  remove: (id: string) => Promise<void>,
  concurrency = 10,
): Promise<BatchDeleteResult> {
  const limit = Math.max(1, concurrency);
  const successIds: string[] = [];
  const failedIds: string[] = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= ids.length) {
        return;
      }

      const id = ids[currentIndex];
      if (!id) {
        continue;
      }

      try {
        await remove(id);
        successIds.push(id);
      } catch {
        failedIds.push(id);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, ids.length) }, () => worker());
  await Promise.all(workers);

  return { successIds, failedIds };
}
