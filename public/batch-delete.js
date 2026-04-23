window.runBatchDelete = async function runBatchDelete(ids, remove, concurrency = 10) {
  const limit = Math.max(1, concurrency);
  const successIds = [];
  const failedIds = [];
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
};
