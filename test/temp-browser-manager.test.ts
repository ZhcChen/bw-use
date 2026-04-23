import { access, mkdir, mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import {
  createTempBrowser,
  closeAllTempBrowsers,
  recoverTempBrowsers,
  isChromeInstalled,
} from "../src/temp-browser-manager";
import { ensureDirs, insertTempBrowser, loadTempBrowsers } from "../src/store";

const FAKE_CHROME = join(import.meta.dir, "fixtures", "fake_chrome.sh");

async function withIsolatedEnv<T>(
  label: string,
  run: (ctx: { rootDir: string; dataDir: string; tempChromeDir: string }) => Promise<T>,
) {
  const rootDir = await mkdtemp(join(tmpdir(), `bw-use-temp-chrome-${label}-`));
  const dataDir = join(rootDir, "data");
  const tempChromeDir = join(rootDir, "temp");
  const originalDataDir = process.env.BW_USE_DATA_DIR;
  const originalTempDir = process.env.BW_USE_TEMP_CHROME_DIR;
  const originalChromePath = process.env.CHROME_PATH;

  process.env.BW_USE_DATA_DIR = dataDir;
  process.env.BW_USE_TEMP_CHROME_DIR = tempChromeDir;
  process.env.CHROME_PATH = FAKE_CHROME;

  try {
    return await run({ rootDir, dataDir, tempChromeDir });
  } finally {
    if (originalDataDir === undefined) delete process.env.BW_USE_DATA_DIR;
    else process.env.BW_USE_DATA_DIR = originalDataDir;

    if (originalTempDir === undefined) delete process.env.BW_USE_TEMP_CHROME_DIR;
    else process.env.BW_USE_TEMP_CHROME_DIR = originalTempDir;

    if (originalChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = originalChromePath;

    await rm(rootDir, { recursive: true, force: true });
  }
}

async function pathExists(path: string) {
  return access(path).then(() => true, () => false);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isProcessAlive(pid)) return;
    await Bun.sleep(100);
  }
  throw new Error(`process ${pid} did not exit in time`);
}

test("isChromeInstalled 检测可执行文件存在时返回 true", async () => {
  await withIsolatedEnv("chrome-detect", async () => {
    expect(await isChromeInstalled()).toBe(true);
    process.env.CHROME_PATH = "/definitely/not/a/real/path/chrome";
    expect(await isChromeInstalled()).toBe(false);
  });
});

test("创建临时浏览器：目录、DB 记录、pid 存活", async () => {
  await withIsolatedEnv("create", async () => {
    const temp = await createTempBrowser();

    try {
      expect(temp.id).toBeString();
      expect(temp.instanceDir.endsWith(temp.id)).toBe(true);
      expect(temp.profileDir.endsWith("/profile")).toBe(true);
      expect(temp.launcherPid).toBeGreaterThan(0);
      expect(await pathExists(temp.instanceDir)).toBe(true);
      expect(await pathExists(join(temp.profileDir, "fingerprint-ext", "manifest.json"))).toBe(true);
      expect(isProcessAlive(temp.launcherPid)).toBe(true);

      const items = loadTempBrowsers();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(temp.id);
      expect(items[0].launcherPid).toBe(temp.launcherPid);
    } finally {
      await closeAllTempBrowsers();
    }
  });
});

test("启动立即失败时回滚 DB 记录与目录", async () => {
  await withIsolatedEnv("fail-start", async ({ tempChromeDir }) => {
    await expect(
      createTempBrowser({ extraArgs: ["--bw-fail-start"], readyTimeoutMs: 800 }),
    ).rejects.toThrow(/simulated startup failure|Chrome/);

    expect(loadTempBrowsers()).toEqual([]);
    expect(await readdir(tempChromeDir)).toEqual([]);
  });
});

test("启动后立即退出视为失败并回滚", async () => {
  await withIsolatedEnv("exit-after", async ({ tempChromeDir }) => {
    await expect(
      createTempBrowser({ extraArgs: ["--bw-exit-after=50"], readyTimeoutMs: 800 }),
    ).rejects.toThrow();

    expect(loadTempBrowsers()).toEqual([]);
    expect(await readdir(tempChromeDir)).toEqual([]);
  });
});

test("chromeBin 不存在时启动失败且回滚", async () => {
  await withIsolatedEnv("missing-chrome", async ({ tempChromeDir }) => {
    await expect(
      createTempBrowser({ chromeBin: "/definitely/not/a/real/path/chrome", readyTimeoutMs: 500 }),
    ).rejects.toThrow();
    expect(loadTempBrowsers()).toEqual([]);
    expect(await readdir(tempChromeDir)).toEqual([]);
  });
});

test("一键关闭：终止进程、清理目录、DB 清空", async () => {
  await withIsolatedEnv("close-all", async () => {
    const first = await createTempBrowser();
    const second = await createTempBrowser();

    const result = await closeAllTempBrowsers();
    expect(result.closedCount).toBe(2);
    expect(result.failedIds).toEqual([]);
    expect(await pathExists(first.instanceDir)).toBe(false);
    expect(await pathExists(second.instanceDir)).toBe(false);
    expect(loadTempBrowsers()).toEqual([]);
  });
});

test("用户主动关闭进程后自动清理目录与 DB 记录", async () => {
  await withIsolatedEnv("user-close", async () => {
    const temp = await createTempBrowser();
    process.kill(temp.launcherPid, "SIGTERM");
    await waitForProcessExit(temp.launcherPid);

    // cleanupAfterExit 是异步的，轮询等待
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (loadTempBrowsers().length === 0) break;
      await Bun.sleep(100);
    }

    expect(loadTempBrowsers()).toEqual([]);
    expect(await pathExists(temp.instanceDir)).toBe(false);
  });
});

test("recoverTempBrowsers 清理 pid 已死的 stale 记录", async () => {
  await withIsolatedEnv("recover-dead", async ({ tempChromeDir }) => {
    await ensureDirs();
    const staleId = "stale-dead";
    const instanceDir = join(tempChromeDir, staleId);
    const profileDir = join(instanceDir, "profile");
    await mkdir(profileDir, { recursive: true });
    insertTempBrowser({
      id: staleId,
      launcherPid: 999_999,
      instanceDir,
      profileDir,
      createdAt: "2026-04-17T00:00:00.000Z",
    });

    await recoverTempBrowsers();

    expect(loadTempBrowsers()).toEqual([]);
    expect(await pathExists(instanceDir)).toBe(false);
  });
});

test("路径防御：拒绝清理 tempChromeDir 之外的 instanceDir", async () => {
  await withIsolatedEnv("path-guard", async ({ rootDir, tempChromeDir }) => {
    await ensureDirs();
    const outsideDir = join(rootDir, "outside-instance");
    await mkdir(outsideDir, { recursive: true });
    insertTempBrowser({
      id: "outside-record",
      launcherPid: 999_999,
      instanceDir: outsideDir,
      profileDir: join(outsideDir, "profile"),
      createdAt: "2026-04-17T00:00:00.000Z",
    });

    const result = await closeAllTempBrowsers();
    expect(result.closedCount).toBe(0);
    expect(result.failedIds).toEqual(["outside-record"]);
    expect(await pathExists(outsideDir)).toBe(true);
    expect(tempChromeDir.endsWith("/temp")).toBe(true);
  });
});
