import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import { launchBrowser, closeBrowser } from "../src/browser-manager";
import { generateFingerprint } from "../src/fingerprint";
import { getLogs } from "../src/logger";
import { ensureDirs, getBrowser, insertBrowser, type BrowserInstance } from "../src/store";

const FAKE_CHROME = join(import.meta.dir, "fixtures", "fake_chrome.sh");
const FAKE_OPEN = join(import.meta.dir, "fixtures", "fake_open.sh");
const testOnDarwin: typeof test = process.platform === "darwin" ? test : test.skip;
const browserManagerUrl = new URL("../src/browser-manager.ts", import.meta.url).href;
const storeUrl = new URL("../src/store.ts", import.meta.url).href;

async function withIsolatedBrowserEnv<T>(
  label: string,
  run: (ctx: { rootDir: string; dataDir: string }) => Promise<T>,
  extraEnv: Record<string, string> = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), `bw-use-browser-manager-${label}-`));
  const dataDir = join(rootDir, "data");
  const originalEnv = {
    BW_USE_DATA_DIR: process.env.BW_USE_DATA_DIR,
    CHROME_PATH: process.env.CHROME_PATH,
    BW_USE_OPEN_BIN: process.env.BW_USE_OPEN_BIN,
    BW_USE_OSASCRIPT_BIN: process.env.BW_USE_OSASCRIPT_BIN,
  };

  process.env.BW_USE_DATA_DIR = dataDir;
  process.env.CHROME_PATH = FAKE_CHROME;
  for (const [key, value] of Object.entries(extraEnv)) {
    process.env[key] = value;
  }

  try {
    await ensureDirs();
    return await run({ rootDir, dataDir });
  } finally {
    if (originalEnv.BW_USE_DATA_DIR === undefined) delete process.env.BW_USE_DATA_DIR;
    else process.env.BW_USE_DATA_DIR = originalEnv.BW_USE_DATA_DIR;

    if (originalEnv.CHROME_PATH === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = originalEnv.CHROME_PATH;

    if (originalEnv.BW_USE_OPEN_BIN === undefined) delete process.env.BW_USE_OPEN_BIN;
    else process.env.BW_USE_OPEN_BIN = originalEnv.BW_USE_OPEN_BIN;

    if (originalEnv.BW_USE_OSASCRIPT_BIN === undefined) delete process.env.BW_USE_OSASCRIPT_BIN;
    else process.env.BW_USE_OSASCRIPT_BIN = originalEnv.BW_USE_OSASCRIPT_BIN;

    await ensureDirs();
    await rm(rootDir, { recursive: true, force: true });
  }
}

function createBrowser(overrides: Partial<BrowserInstance> = {}): BrowserInstance {
  return {
    id: crypto.randomUUID(),
    name: "Test Browser",
    groupId: null,
    fingerprint: generateFingerprint(),
    proxy: null,
    enableCustomIcon: false,
    disableCors: false,
    language: "zh-CN",
    status: "stopped",
    pid: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function isProcessAlive(pid: number | null | undefined) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(`process ${pid} did not exit in time`);
}

test("closeBrowser 会真正终止对应 profile 的 Chrome 进程", async () => {
  await withIsolatedBrowserEnv("close", async () => {
    const browser = createBrowser();
    insertBrowser(browser);

    const launched = await launchBrowser(browser.id);
    const pid = launched.pid;

    expect(isProcessAlive(pid)).toBe(true);

    await closeBrowser(browser.id);
    await waitForProcessExit(pid!);

    expect(isProcessAlive(pid)).toBe(false);
    expect(getBrowser(browser.id)?.status).toBe("stopped");
  });
});

test("带账号密码的代理会改为使用本地桥接代理启动 Chrome", async () => {
  await withIsolatedBrowserEnv("auth-proxy", async () => {
    const browser = createBrowser({
      proxy: {
        host: "198.51.100.24",
        port: 8080,
        username: "user-a",
        password: "pass-b",
      },
    });
    insertBrowser(browser);

    const launched = await launchBrowser(browser.id);
    const pid = launched.pid;
    const chromeArgsLog = getLogs(20).find((entry) => entry.source === "launch" && entry.message === "Chrome args");
    const command = chromeArgsLog?.detail || "";

    expect(command).toContain("--proxy-server=http://127.0.0.1:");
    expect(command).not.toContain("--proxy-server=http://198.51.100.24:8080");

    await closeBrowser(browser.id);
    await waitForProcessExit(pid!);
  });
});

testOnDarwin(
  "启用独立图标时也能启动并关闭浏览器实例",
  async () => {
    await withIsolatedBrowserEnv(
      "custom-icon",
      async ({ dataDir }) => {
        const browser = createBrowser({
          name: "Dock Browser",
          enableCustomIcon: true,
        });
        const script = `
          import { launchBrowser, closeBrowser } from ${JSON.stringify(browserManagerUrl)};
          import { ensureDirs, insertBrowser, getBrowser } from ${JSON.stringify(storeUrl)};

          await ensureDirs();
          insertBrowser(${JSON.stringify(browser)});

          const launched = await launchBrowser(${JSON.stringify(browser.id)});
          if (!launched.pid) {
            throw new Error("missing pid");
          }

          await closeBrowser(${JSON.stringify(browser.id)});
          const next = getBrowser(${JSON.stringify(browser.id)});
          if (!next || next.status !== "stopped") {
            throw new Error("browser did not stop cleanly");
          }
        `;

        const proc = Bun.spawn([process.execPath, "-e", script], {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            BW_USE_DATA_DIR: dataDir,
            CHROME_PATH: FAKE_CHROME,
            BW_USE_OPEN_BIN: FAKE_OPEN,
            BW_USE_OSASCRIPT_BIN: "/usr/bin/false",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        expect(exitCode).toBe(0);
        expect(stderr.trim()).toBe("");
        expect(stdout.trim()).toBe("");
      },
    );
  },
  { timeout: 20_000 },
);
