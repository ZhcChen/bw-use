import { access, mkdir, mkdtemp, rm } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import { createTempBrowser, closeAllTempBrowsers } from "../src/temp-browser-manager";
import { handleTempBrowserApi } from "../src/temp-browser-api";
import { ensureDirs, insertTempBrowser, loadTempBrowsers } from "../src/store";

const FAKE_CHROME = join(import.meta.dir, "fixtures", "fake_chrome.sh");

async function withIsolatedEnv<T>(
  label: string,
  run: (ctx: { rootDir: string; dataDir: string; tempChromeDir: string }) => Promise<T>,
  initializeStore = true,
) {
  const rootDir = await mkdtemp(join(tmpdir(), `bw-use-temp-api-${label}-`));
  const dataDir = join(rootDir, "data");
  const tempChromeDir = join(rootDir, "temp");

  const originalDataDir = process.env.BW_USE_DATA_DIR;
  const originalTempDir = process.env.BW_USE_TEMP_CHROME_DIR;
  const originalChromePath = process.env.CHROME_PATH;

  process.env.BW_USE_DATA_DIR = dataDir;
  process.env.BW_USE_TEMP_CHROME_DIR = tempChromeDir;
  process.env.CHROME_PATH = FAKE_CHROME;

  try {
    if (initializeStore) {
      await ensureDirs();
    }
    return await run({ rootDir, dataDir, tempChromeDir });
  } finally {
    await closeAllTempBrowsers().catch(() => {});

    if (originalDataDir === undefined) delete process.env.BW_USE_DATA_DIR;
    else process.env.BW_USE_DATA_DIR = originalDataDir;

    if (originalTempDir === undefined) delete process.env.BW_USE_TEMP_CHROME_DIR;
    else process.env.BW_USE_TEMP_CHROME_DIR = originalTempDir;

    if (originalChromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = originalChromePath;

    await rm(rootDir, { recursive: true, force: true });
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function pathExists(path: string) {
  return access(path).then(() => true, () => false);
}

async function findFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(port);
      });
    });
  });
}

async function waitForServerReady(baseUrl: string, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/temp-browsers`);
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for server at ${baseUrl}`);
}

async function stopServer(proc: ReturnType<typeof Bun.spawn>) {
  try { proc.kill("SIGTERM"); } catch {}
  const gracefully = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (gracefully) return;
  try { proc.kill("SIGKILL"); } catch {}
  await Promise.race([proc.exited, Bun.sleep(2_000)]);
}

async function startServerForTest(env: Record<string, string>) {
  const port = await findFreePort();
  const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...env, BW_USE_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServerReady(baseUrl);
  } catch (error) {
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    const stdout = await new Response(proc.stdout).text().catch(() => "");
    await stopServer(proc);
    throw new Error(`${(error as Error).message}\nstderr: ${stderr.slice(-500)}\nstdout: ${stdout.slice(-500)}`);
  }
  return { proc, baseUrl };
}

test("GET /api/temp-browsers 在未预先 ensureDirs 时也能返回空列表", async () => {
  await withIsolatedEnv("get-empty-without-ensure-dirs", async () => {
    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers", { method: "GET" }),
      "/api/temp-browsers",
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await getJson(response!)).toEqual({ count: 0, items: [] });
  }, false);
});

test("GET /api/temp-browsers 空列表返回 count=0 和 items=[]", async () => {
  await withIsolatedEnv("get-empty", async () => {
    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers", { method: "GET" }),
      "/api/temp-browsers",
    );
    expect(response!.status).toBe(200);
    expect(await getJson(response!)).toEqual({ count: 0, items: [] });
  });
});

test("GET /api/temp-browsers 返回 count 和摘要项（pid 字段）", async () => {
  await withIsolatedEnv("get-items", async ({ tempChromeDir }) => {
    insertTempBrowser({
      id: "temp-a",
      launcherPid: 1001,
      instanceDir: join(tempChromeDir, "temp-a"),
      profileDir: join(tempChromeDir, "temp-a", "profile"),
      createdAt: "2026-04-17T00:00:00.000Z",
    });
    insertTempBrowser({
      id: "temp-b",
      launcherPid: 1002,
      instanceDir: join(tempChromeDir, "temp-b"),
      profileDir: join(tempChromeDir, "temp-b", "profile"),
      createdAt: "2026-04-17T00:00:01.000Z",
    });

    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers", { method: "GET" }),
      "/api/temp-browsers",
    );
    expect(response!.status).toBe(200);
    expect(await getJson(response!)).toEqual({
      count: 2,
      items: [
        { id: "temp-a", createdAt: "2026-04-17T00:00:00.000Z", pid: 1001 },
        { id: "temp-b", createdAt: "2026-04-17T00:00:01.000Z", pid: 1002 },
      ],
    });
  });
});

test("GET /api/temp-browsers/setup 已安装时 installed=true 并返回 path", async () => {
  await withIsolatedEnv("get-setup-installed", async () => {
    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers/setup", { method: "GET" }),
      "/api/temp-browsers/setup",
    );
    expect(response!.status).toBe(200);
    const payload = await getJson<{ installed: boolean; path: string }>(response!);
    expect(payload.installed).toBe(true);
    expect(payload.path).toBe(FAKE_CHROME);
  });
});

test("GET /api/temp-browsers/setup 未安装时返回 installed=false", async () => {
  await withIsolatedEnv("get-setup-missing", async () => {
    process.env.CHROME_PATH = "/definitely/not/a/real/path/chrome";
    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers/setup", { method: "GET" }),
      "/api/temp-browsers/setup",
    );
    expect(response!.status).toBe(200);
    const payload = await getJson<{ installed: boolean; path: string }>(response!);
    expect(payload.installed).toBe(false);
  });
});

test("POST /api/temp-browsers 创建实例并返回 running=true 与 pid", async () => {
  await withIsolatedEnv("post", async () => {
    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers", { method: "POST" }),
      "/api/temp-browsers",
    );
    expect(response!.status).toBe(201);
    const body = await getJson<{ id: string; createdAt: string; running: boolean; pid: number }>(response!);
    expect(body.id).toBeString();
    expect(body.createdAt).toBeString();
    expect(body.running).toBe(true);
    expect(body.pid).toBeGreaterThan(0);

    const items = loadTempBrowsers();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(body.id);
    expect(isProcessAlive(items[0].launcherPid)).toBe(true);
  });
});

test("DELETE /api/temp-browsers 返回 closedCount/failedIds", async () => {
  await withIsolatedEnv("delete", async () => {
    await createTempBrowser();

    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers", { method: "DELETE" }),
      "/api/temp-browsers",
    );
    expect(response!.status).toBe(200);
    const payload = await getJson<{ closedCount: number; failedIds: string[] }>(response!);
    expect(payload.closedCount).toBe(1);
    expect(payload.failedIds).toEqual([]);
    expect(loadTempBrowsers()).toEqual([]);
  });
});

test("index.ts POST 启动失败时返回 400 和 error", async () => {
  await withIsolatedEnv("index-post-failure", async ({ dataDir, tempChromeDir }) => {
    const server = await startServerForTest({
      BW_USE_DATA_DIR: dataDir,
      BW_USE_TEMP_CHROME_DIR: tempChromeDir,
      CHROME_PATH: "/definitely/not/a/real/path/chrome",
    });
    try {
      const response = await fetch(`${server.baseUrl}/api/temp-browsers`, { method: "POST" });
      expect(response.status).toBe(400);
      const payload = await getJson<{ error?: string }>(response);
      expect(typeof payload.error).toBe("string");
      expect((payload.error || "").length).toBeGreaterThan(0);
    } finally {
      await stopServer(server.proc);
    }
  }, false);
});

test("index.ts 启动时执行恢复，清理 stale temp 记录与目录", async () => {
  await withIsolatedEnv("index-recover-on-startup", async ({ dataDir, tempChromeDir }) => {
    await ensureDirs();

    const staleId = "stale-temp";
    const instanceDir = join(tempChromeDir, staleId);
    const profileDir = join(instanceDir, "profile");
    await mkdir(profileDir, { recursive: true });
    await Bun.write(join(profileDir, "marker.txt"), "stale");

    insertTempBrowser({
      id: staleId,
      launcherPid: 999_999,
      instanceDir,
      profileDir,
      createdAt: "2026-04-17T00:00:00.000Z",
    });
    expect(loadTempBrowsers().map((item) => item.id)).toContain(staleId);
    expect(await pathExists(instanceDir)).toBe(true);

    // 直接调 recoverTempBrowsers，跳过完整 server 进程启动
    const { recoverTempBrowsers: recover } = await import("../src/temp-browser-manager");
    await recover();

    expect(loadTempBrowsers().map((item) => item.id)).not.toContain(staleId);
    expect(await pathExists(instanceDir)).toBe(false);
  });
});

test("DELETE /api/temp-browsers 部分失败时通过 failedIds 暴露失败项", async () => {
  await withIsolatedEnv("delete-failed-ids-contract", async ({ rootDir, tempChromeDir }) => {
    const failedId = "outside-record";
    const outsideInstanceDir = join(rootDir, "outside-instance");

    insertTempBrowser({
      id: failedId,
      launcherPid: 999_999,
      instanceDir: outsideInstanceDir,
      profileDir: join(outsideInstanceDir, "profile"),
      createdAt: "2026-04-17T00:00:00.000Z",
    });

    const response = await handleTempBrowserApi(
      new Request("http://localhost/api/temp-browsers", { method: "DELETE" }),
      "/api/temp-browsers",
    );
    expect(response!.status).toBe(200);
    const payload = await getJson<{ closedCount: number; failedIds: string[] }>(response!);
    expect(payload.closedCount).toBe(0);
    expect(payload.failedIds).toContain(failedId);
    expect(tempChromeDir.endsWith("/temp")).toBe(true);
  });
});
