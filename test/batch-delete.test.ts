import { expect, test } from "bun:test";
import { runBatchDelete } from "../src/batch-delete";

test("limits concurrency to 10 and collects failures", async () => {
  let active = 0;
  let maxActive = 0;

  const result = await runBatchDelete(
    Array.from({ length: 12 }, (_, index) => String(index + 1)),
    async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;

      if (id === "3" || id === "11") {
        throw new Error("fail");
      }
    },
    10,
  );

  expect(maxActive).toBeLessThanOrEqual(10);
  expect(result.successIds).toHaveLength(10);
  expect(result.failedIds).toEqual(["3", "11"]);
});
