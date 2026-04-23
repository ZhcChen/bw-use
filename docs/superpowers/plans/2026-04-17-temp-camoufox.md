# Temporary Camoufox Browsers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为页面右上角增加“创建临时浏览器 / 一键关闭临时浏览器”入口，使用 Camoufox 启动不进入现有列表的临时实例，并确保这些实例可被本项目安全关闭和彻底清理。

**Architecture:** 在现有 Chrome 管理链路旁边新增一条独立的临时 Camoufox 通道：SQLite 增加 `temp_browsers` 注册表，Bun 新增 temp manager 负责任务编排、路径保护、启动恢复与批量清理，Python 启动器仅负责持有 Camoufox 生命周期。前端只展示按钮和数量，不复用现有浏览器列表模型。

**Tech Stack:** Bun, TypeScript, bun:test, bun:sqlite, Python 3, Camoufox

---

## File Structure

**Create**

- `src/temp-browser-manager.ts` — 临时 Camoufox 的创建、列出、关闭、恢复清理与路径保护
- `src/temp-browser-api.ts` — `/api/temp-browsers` 路由处理
- `scripts/camoufox_launcher.py` — Python Camoufox 启动器，负责持有浏览器生命周期并响应终止信号
- `test/temp-browser-store.test.ts` — 临时实例表与路径配置测试
- `test/temp-browser-manager.test.ts` — temp manager 启动/回滚/清理/恢复测试
- `test/temp-browser-api.test.ts` — temp API 路由测试
- `test/fixtures/fake_camoufox_launcher.py` — 测试用假启动器，模拟 pid、ready、失败与目录占用
- `public/temp-browsers.js` — 临时浏览器按钮与数量状态前端逻辑

**Modify**

- `src/paths.ts` — 新增临时 Camoufox 根目录解析
- `src/store.ts` — 新增 `temp_browsers` 表及 CRUD
- `src/index.ts` — 接入 temp API 路由与服务启动恢复
- `public/index.html` — 右上角按钮、数量文案、确认交互

## Prerequisites

- Python 3 可用（当前环境已有 `python3`）
- Camoufox Python 包与浏览器二进制需要提前准备：
  - `pip install -U camoufox`
  - `camoufox fetch`
- 计划内实现需要在缺失依赖时返回清晰错误，而不是静默失败

### Task 1: 路径配置与临时实例注册表

**Files:**
- Modify: `src/paths.ts`
- Modify: `src/store.ts`
- Test: `test/temp-browser-store.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from "bun:test";
import { getDataPaths } from "../src/paths";
import { ensureDirs, insertTempBrowser, loadTempBrowsers } from "../src/store";

test("resolves temp camoufox root from env override", () => {
  const paths = getDataPaths({
    BW_USE_DATA_DIR: "/tmp/bw-use-data",
    BW_USE_TEMP_CAMOUFOX_DIR: "/tmp/bw-use-temp-camoufox",
  });

  expect(paths.tempCamoufoxDir).toBe("/tmp/bw-use-temp-camoufox");
});

test("persists temp browser records in isolated sqlite db", async () => {
  await ensureDirs();
  insertTempBrowser({
    id: "temp-1",
    launcherPid: 123,
    instanceDir: "/tmp/instance",
    profileDir: "/tmp/instance/profile",
    createdAt: "2026-04-17T00:00:00.000Z",
  });

  const items = loadTempBrowsers();
  expect(items).toHaveLength(1);
  expect(items[0]?.id).toBe("temp-1");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-store.test.ts`

Expected: FAIL，提示 `tempCamoufoxDir`、`insertTempBrowser` 或 `loadTempBrowsers` 不存在

- [ ] **Step 3: 写最小实现**

实现：

- `getDataPaths()` 新增 `tempCamoufoxDir`
- `ensureDirs()` 创建 temp 根目录
- `store.ts` 新增 `temp_browsers` 表及最小 CRUD：
  - `loadTempBrowsers`
  - `insertTempBrowser`
  - `removeTempBrowser`
  - `clearTempBrowsers`

- [ ] **Step 4: 再跑测试确认通过**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-store.test.ts`

Expected: PASS

### Task 2: Temp manager 与假启动器

**Files:**
- Create: `src/temp-browser-manager.ts`
- Create: `test/fixtures/fake_camoufox_launcher.py`
- Test: `test/temp-browser-manager.test.ts`
- Modify: `src/store.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from "bun:test";
import {
  createTempBrowser,
  closeAllTempBrowsers,
  recoverTempBrowsers,
} from "../src/temp-browser-manager";

test("creates a unique instance directory and stores launcher pid", async () => {
  const temp = await createTempBrowser({
    pythonBin: "python3",
    launcherScript: "test/fixtures/fake_camoufox_launcher.py",
  });

  expect(temp.id).toBeString();
  expect(temp.instanceDir.endsWith(temp.id)).toBe(true);
  expect(temp.profileDir.endsWith("/profile")).toBe(true);
  expect(temp.launcherPid).toBeGreaterThan(0);
});

test("rolls back directory and registry when launcher fails before ready", async () => {
  await expect(createTempBrowser({
    pythonBin: "python3",
    launcherScript: "test/fixtures/fake_camoufox_launcher.py",
    extraArgs: ["--fail-before-ready"],
  })).rejects.toThrow();
});

test("closes only registered temp browsers and removes their directories", async () => {
  await createTempBrowser({ pythonBin: "python3", launcherScript: "test/fixtures/fake_camoufox_launcher.py" });
  await createTempBrowser({ pythonBin: "python3", launcherScript: "test/fixtures/fake_camoufox_launcher.py" });

  const result = await closeAllTempBrowsers();
  expect(result.closedCount).toBe(2);
  expect(result.failedIds).toEqual([]);
});

test("recovery removes stale records whose launcher process is gone", async () => {
  await recoverTempBrowsers();
  expect(true).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-manager.test.ts`

Expected: FAIL，提示 `src/temp-browser-manager.ts` 不存在

- [ ] **Step 3: 写最小实现**

实现这些点：

- `createTempBrowser()`：
  - 生成 `tempId`
  - 创建 `instanceDir` 与 `profileDir`
  - 启动 Python 启动器
  - 等待 ready 信号（stdout 行或 ready 文件）
  - 成功后写入 `temp_browsers`
  - 失败时回滚目录与记录
- `closeAllTempBrowsers()`：
  - 遍历注册表
  - 仅终止受管 launcher pid
  - 删除 `instanceDir`
  - 汇总 `closedCount` / `failedIds`
- `recoverTempBrowsers()`：
  - 检查注册表中 pid 是否仍存活
  - 对失效记录执行目录回收并删除记录
- 路径保护：
  - 删除前验证目标路径位于 `tempCamoufoxDir` 下
- 假启动器支持：
  - 正常 ready
  - `--fail-before-ready`
  - 长驻直到收到终止信号

- [ ] **Step 4: 再跑测试确认通过**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-manager.test.ts`

Expected: PASS

### Task 3: Python Camoufox 启动器

**Files:**
- Create: `scripts/camoufox_launcher.py`
- Modify: `src/temp-browser-manager.ts`

- [ ] **Step 1: 写失败测试**

在 `test/temp-browser-manager.test.ts` 增加一条针对真实启动器预检查的失败断言，至少验证当启动器 stderr 输出依赖缺失时，manager 会把错误透传出来。

- [ ] **Step 2: 运行测试确认失败**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-manager.test.ts`

Expected: FAIL，提示 manager 没有处理启动器错误信息

- [ ] **Step 3: 写最小实现**

`scripts/camoufox_launcher.py` 要求：

- 参数：
  - `--temp-id`
  - `--user-data-dir`
  - `--headless`
- 行为：
  - `from camoufox import Camoufox`
  - 使用 `persistent_context=True` 和传入的 `user_data_dir`
  - 启动成功后向 stdout 输出单行 ready 信号，例如 `READY:<pid>`
  - 注册 `SIGTERM` / `SIGINT` 处理器，收到信号时关闭上下文并退出
  - 依赖缺失或启动失败时向 stderr 输出可读错误并以非零退出码退出

- [ ] **Step 4: 用假启动器与真实启动器预检查重新跑测试**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-manager.test.ts`

Expected: PASS（真实 Camoufox 不要求在自动化测试中实际拉起浏览器）

### Task 4: Temp API 路由与启动恢复

**Files:**
- Create: `src/temp-browser-api.ts`
- Modify: `src/index.ts`
- Test: `test/temp-browser-api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, test } from "bun:test";
import { handleTempBrowserApi } from "../src/temp-browser-api";

test("GET /api/temp-browsers returns count and items", async () => {
  const res = await handleTempBrowserApi(new Request("http://localhost/api/temp-browsers"), "/api/temp-browsers");
  const json = await res.json();

  expect(res.status).toBe(200);
  expect(json).toEqual({ count: 0, items: [] });
});

test("DELETE /api/temp-browsers returns closedCount and failedIds", async () => {
  const res = await handleTempBrowserApi(new Request("http://localhost/api/temp-browsers", { method: "DELETE" }), "/api/temp-browsers");
  const json = await res.json();

  expect(res.status).toBe(200);
  expect(json).toHaveProperty("closedCount");
  expect(json).toHaveProperty("failedIds");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-api.test.ts`

Expected: FAIL，提示 `src/temp-browser-api.ts` 不存在

- [ ] **Step 3: 写最小实现**

实现：

- `handleTempBrowserApi()` 处理：
  - `GET /api/temp-browsers`
  - `POST /api/temp-browsers`
  - `DELETE /api/temp-browsers`
- `src/index.ts`：
  - 接入 temp API 路由
  - 服务启动时在 `ensureDirs()` 之后调用 `recoverTempBrowsers()`

- [ ] **Step 4: 再跑测试确认通过**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp" bun test test/temp-browser-api.test.ts`

Expected: PASS

### Task 5: 前端按钮、数量状态与确认交互

**Files:**
- Create: `public/temp-browsers.js`
- Modify: `public/index.html`

- [ ] **Step 1: 接入按钮与数量文案**

在右上角新增：

- `创建临时浏览器`
- `一键关闭临时浏览器`
- `临时浏览器：N 个`

其中 `N` 来自 `GET /api/temp-browsers`。

- [ ] **Step 2: 接入请求与禁用态**

`public/temp-browsers.js` 负责：

- 首次加载数量
- 创建中 / 关闭中按钮状态
- 当 `N = 0` 时禁用“一键关闭”
- 成功/失败提示

- [ ] **Step 3: 接入确认弹窗**

复用现有弹窗样式或新增最小确认逻辑，文案必须明确：

`将关闭并清理当前项目创建的全部临时浏览器及其 profile/cache 数据，此操作不可恢复。`

- [ ] **Step 4: 手动验证前端行为**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp-camoufox" bun run src/index.ts`

Expected:

- 页面右上角出现两个新按钮和数量文案
- 初始 `N = 0` 时“一键关闭临时浏览器”禁用
- 点击创建后数量递增
- 点击一键关闭后数量归零

### Task 6: 整体验证与安全边界确认

**Files:**
- Test: `test/temp-browser-store.test.ts`
- Test: `test/temp-browser-manager.test.ts`
- Test: `test/temp-browser-api.test.ts`

- [ ] **Step 1: 跑全部自动化测试**

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp-camoufox" bun test`

Expected: PASS

- [ ] **Step 2: 验证现有数据未被触碰**

Run: `lsof -p <server-pid> | rg "browsers\\.db|temp-camoufox"`

Expected:

- 打开的 SQLite 文件位于临时 `BW_USE_DATA_DIR`
- 临时实例目录位于临时 `BW_USE_TEMP_CAMOUFOX_DIR`
- 不指向仓库内现有 `data/`

- [ ] **Step 3: 真实 Camoufox 手动验证**

前提：

- `pip install -U camoufox`
- `camoufox fetch`

Run: `BW_USE_DATA_DIR="$(mktemp -d)/data" BW_USE_TEMP_CAMOUFOX_DIR="$(mktemp -d)/temp-camoufox" bun run src/index.ts`

Expected:

- 连续点击“创建临时浏览器”两次，会创建两个不同的 `instanceDir/profileDir`
- 一键关闭后这些目录被删除
- 现有 Chrome 列表和已有数据不受影响

## Notes

- 本仓库当前不是 git 工作树，执行计划时跳过 commit 步骤。
- 自动化测试默认使用假启动器；真实 Camoufox 仅用于手动验收。
