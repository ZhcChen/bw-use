# Batch Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为浏览器列表增加可选中和批量删除能力，并确保测试运行时完全隔离现有 `data/` 数据目录。

**Architecture:** 保持现有单条删除后端接口不变，在前端追加选择状态和批量删除控制逻辑；新增小型纯函数模块承载批量删除执行器，避免把并发控制塞进 HTML 内联脚本中。后端只补一层数据目录配置解析，让测试可切到临时目录。

**Tech Stack:** Bun, TypeScript, 原生 HTML/JS, bun:test, bun:sqlite

---

### Task 1: 数据目录隔离

**Files:**
- Create: `src/paths.ts`
- Modify: `src/store.ts`
- Test: `test/paths.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { test, expect } from "bun:test";
import { getDataPaths } from "../src/paths";

test("uses default data directory when no env override is set", () => {
  const paths = getDataPaths({});
  expect(paths.dataDir.endsWith("/data")).toBe(true);
});

test("uses BW_USE_DATA_DIR when provided", () => {
  const paths = getDataPaths({ BW_USE_DATA_DIR: "/tmp/bw-use-test" });
  expect(paths.dataDir).toBe("/tmp/bw-use-test");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/paths.test.ts`
Expected: FAIL，提示 `../src/paths` 或 `getDataPaths` 不存在

- [ ] **Step 3: 写最小实现**

```ts
export function getDataPaths(env = process.env) {
  const dataDir = env.BW_USE_DATA_DIR || join(import.meta.dir, "..", "data");
  return { dataDir, profilesDir: join(dataDir, "profiles"), dbPath: join(dataDir, "browsers.db") };
}
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `bun test test/paths.test.ts`
Expected: PASS

### Task 2: 批量删除执行器

**Files:**
- Create: `src/batch-delete.ts`
- Test: `test/batch-delete.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { test, expect } from "bun:test";
import { runBatchDelete } from "../src/batch-delete";

test("limits concurrency to 10 and collects failures", async () => {
  let active = 0;
  let maxActive = 0;

  const result = await runBatchDelete(
    Array.from({ length: 12 }, (_, i) => String(i + 1)),
    async (id) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (id === "3" || id === "11") throw new Error("fail");
    },
    10,
  );

  expect(maxActive).toBeLessThanOrEqual(10);
  expect(result.successIds).toHaveLength(10);
  expect(result.failedIds).toEqual(["3", "11"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/batch-delete.test.ts`
Expected: FAIL，提示 `runBatchDelete` 不存在

- [ ] **Step 3: 写最小实现**

实现一个受控并发队列，按传入上限执行删除任务并汇总成功/失败 id。

- [ ] **Step 4: 再跑测试确认通过**

Run: `bun test test/batch-delete.test.ts`
Expected: PASS

### Task 3: 前端多选与批量删除接线

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 接入选择状态**

在工具栏增加选择控制按钮和状态文案；在列表卡片中加入复选框并与 `selectedBrowserIds` 绑定。

- [ ] **Step 2: 接入批量删除确认**

让删除弹窗同时支持单条和批量模式，文案根据待删数量变化。

- [ ] **Step 3: 接入批量删除执行器**

调用 `runBatchDelete`，删除接口仍为 `DELETE /api/browsers/:id`，并发上限固定为 10。

- [ ] **Step 4: 手动检查交互**

Run: `BW_USE_DATA_DIR=$(mktemp -d)/data bun run src/index.ts`
Expected: 服务使用临时数据目录启动，可手动验证选择、全选当前结果、批量删除，而不影响现有数据。

### Task 4: 整体验证

**Files:**
- Test: `test/paths.test.ts`
- Test: `test/batch-delete.test.ts`

- [ ] **Step 1: 跑全部自动化测试**

Run: `bun test`
Expected: PASS

- [ ] **Step 2: 记录验证结论**

确认自动化测试未触碰仓库内现有 `data/`，并在交付说明中明确说明。
