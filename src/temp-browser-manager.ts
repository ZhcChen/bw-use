import { spawn, type Subprocess } from "bun";
import { access, mkdir, rm } from "fs/promises";
import { constants as fsConstants } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { getDataPaths } from "./paths";
import {
  ensureDirs,
  insertTempBrowser,
  loadTempBrowsers,
  removeTempBrowser,
  type TempBrowser,
} from "./store";
import { generateFingerprint } from "./fingerprint";
import { buildExtension } from "./extension-builder";
import { log } from "./logger";
import { formatProxyServer, summarizeProxy, type ProxyConfig } from "./proxy";

const DEFAULT_CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_LAUNCH_CHECK_MS = 1_000;

export interface CreateTempBrowserOptions {
  chromeBin?: string;
  extraArgs?: string[];
  proxy?: ProxyConfig | null;
  readyTimeoutMs?: number;
}

export interface CloseAllTempBrowsersResult {
  closedCount: number;
  failedIds: string[];
}

interface RunningState {
  pid: number;
  instanceDir: string;
  suppressAutoClean: boolean;
}

const runningTemp = new Map<string, RunningState>();

function resolveChromeBin(env: Record<string, string | undefined> = process.env): string {
  return env.CHROME_PATH || DEFAULT_CHROME_BIN;
}

export async function isChromeInstalled(env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const bin = resolveChromeBin(env);
  try {
    await access(bin, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function getChromeBinPath(env: Record<string, string | undefined> = process.env): string {
  return resolveChromeBin(env);
}

export async function createTempBrowser(
  options: CreateTempBrowserOptions = {},
): Promise<TempBrowser> {
  await ensureDirs();

  const { tempChromeDir } = getDataPaths();
  const chromeBin = options.chromeBin || resolveChromeBin();
  const id = crypto.randomUUID();
  const instanceDir = join(tempChromeDir, id);
  const profileDir = join(instanceDir, "profile");
  const createdAt = new Date().toISOString();
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_LAUNCH_CHECK_MS;

  let proc: Subprocess | null = null;

  try {
    await mkdir(profileDir, { recursive: true });

    const fingerprint = generateFingerprint();
    const browserName = `Temp-${id.slice(0, 8)}`;
    const extDir = await buildExtension(profileDir, fingerprint, browserName, options.proxy ?? null);

    const args: string[] = [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extDir}`,
      `--user-agent=${fingerprint.userAgent}`,
      "--lang=zh-CN",
      "--accept-lang=zh-CN",
      "--use-mock-keychain",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--disable-features=InfiniteSessionRestore",
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--enable-gpu-rasterization",
      "--enable-zero-copy",
      "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];

    if (fingerprint.webrtcPolicy === "disable") {
      args.push("--disable-webrtc");
    } else if (fingerprint.webrtcPolicy === "public_only") {
      args.push("--force-webrtc-ip-handling-policy=default_public_interface_only");
    }

    if (options.extraArgs && options.extraArgs.length > 0) {
      args.push(...options.extraArgs);
    }

    if (options.proxy) {
      args.push(`--proxy-server=${formatProxyServer(options.proxy)}`);
      log("info", "temp-chrome", "Using proxy", summarizeProxy(options.proxy));
    }

    proc = spawn([chromeBin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await waitForLaunchSuccess(proc, readyTimeoutMs);

    const browser: TempBrowser = {
      id,
      launcherPid: proc.pid,
      instanceDir,
      profileDir,
      createdAt,
    };

    insertTempBrowser(browser);
    runningTemp.set(id, { pid: proc.pid, instanceDir, suppressAutoClean: false });

    const currentProc = proc;
    currentProc.exited.then(async (exitCode) => {
      const state = runningTemp.get(id);
      if (!state) return;
      if (state.suppressAutoClean) return;
      runningTemp.delete(id);
      log("info", "temp-chrome", `User-closed temp browser`, `id=${id} code=${exitCode}`);
      await cleanupAfterExit(id, instanceDir).catch((err: any) => {
        log("error", "temp-chrome", "Post-exit cleanup failed", `id=${id} error=${err?.message}`);
      });
    });

    log("info", "temp-chrome", "Created temp browser", `id=${id} pid=${proc.pid}`);
    return browser;  } catch (error) {
    if (proc && isProcessAlive(proc.pid)) {
      await terminateProcess(proc.pid).catch(() => {});
    }
    runningTemp.delete(id);
    removeTempBrowser(id);
    await safeRemoveInstanceDir(instanceDir, tempChromeDir).catch(() => {});
    throw error;
  }
}

export async function closeAllTempBrowsers(): Promise<CloseAllTempBrowsersResult> {
  await ensureDirs();

  const browsers = loadTempBrowsers();
  const failedIds: string[] = [];
  let closedCount = 0;
  const { tempChromeDir } = getDataPaths();

  for (const browser of browsers) {
    try {
      assertManagedTempPath(browser.instanceDir, tempChromeDir);
      const state = runningTemp.get(browser.id);
      if (state) state.suppressAutoClean = true;

      await killProcessesByProfileId(browser.id);
      await safeRemoveInstanceDir(browser.instanceDir, tempChromeDir);
      removeTempBrowser(browser.id);
      runningTemp.delete(browser.id);
      closedCount += 1;
    } catch (error) {
      failedIds.push(browser.id);
      log(
        "error",
        "temp-chrome",
        "Failed to close temp browser",
        `id=${browser.id} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { closedCount, failedIds };
}

export async function recoverTempBrowsers(): Promise<void> {
  await ensureDirs();

  const browsers = loadTempBrowsers();
  const { tempChromeDir } = getDataPaths();

  for (const browser of browsers) {
    try {
      assertManagedTempPath(browser.instanceDir, tempChromeDir);
      if (isProcessAlive(browser.launcherPid)) {
        const command = getProcessCommand(browser.launcherPid);
        if (command.includes(browser.id)) {
          await terminateProcess(browser.launcherPid);
        }
      }
      await safeRemoveInstanceDir(browser.instanceDir, tempChromeDir);
      removeTempBrowser(browser.id);
      log("info", "temp-chrome", "Recovered stale temp browser", `id=${browser.id}`);
    } catch (error) {
      log(
        "error",
        "temp-chrome",
        "Failed to recover stale temp browser",
        `id=${browser.id} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function cleanupAfterExit(id: string, instanceDir: string) {
  const { tempChromeDir } = getDataPaths();
  await killProcessesByProfileId(id);
  await safeRemoveInstanceDir(instanceDir, tempChromeDir);
  removeTempBrowser(id);
}

async function killProcessesByProfileId(id: string) {
  try {
    const p1 = spawn(["pkill", "-f", id], { stdout: "ignore", stderr: "ignore" });
    await p1.exited;
  } catch {}

  await Bun.sleep(1_000);

  try {
    const p2 = spawn(["pkill", "-9", "-f", id], { stdout: "ignore", stderr: "ignore" });
    await p2.exited;
  } catch {}

  await Bun.sleep(300);
}

async function waitForLaunchSuccess(proc: Subprocess, windowMs: number) {
  const stderrCapture = captureText(proc.stderr as ReadableStream<Uint8Array> | null | undefined);
  const result = await Promise.race([
    proc.exited.then((code) => ({ type: "exit" as const, code })),
    Bun.sleep(windowMs).then(() => ({ type: "alive" as const })),
  ]);

  if (result.type === "alive" && isProcessAlive(proc.pid)) {
    return;
  }

  const stderr = (await stderrCapture).trim();
  throw new Error(stderr || `Chrome for Testing exited before launch-check window (code=${result.type === "exit" ? result.code : "?"})`);
}

async function captureText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return "";
  const CAPTURE_LIMIT = 8_192;
  let text = "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text = (text + decoder.decode(value, { stream: true })).slice(-CAPTURE_LIMIT);
    }
    text = (text + decoder.decode()).slice(-CAPTURE_LIMIT);
  } catch {
    // ignore
  } finally {
    reader.releaseLock();
  }
  return text;
}

async function safeRemoveInstanceDir(instanceDir: string, tempChromeDir: string) {
  assertManagedTempPath(instanceDir, tempChromeDir);
  await rm(instanceDir, { recursive: true, force: true });
}

function isManagedTempPath(targetPath: string, rootPath: string) {
  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = resolve(targetPath);
  const pathRelative = relative(resolvedRoot, resolvedTarget);
  return pathRelative !== "" && !pathRelative.startsWith("..") && !isAbsolute(pathRelative);
}

function assertManagedTempPath(targetPath: string, rootPath: string) {
  if (!isManagedTempPath(targetPath, rootPath)) {
    throw new Error(`Refusing to operate on unmanaged path: ${targetPath}`);
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

async function terminateProcess(pid: number) {
  if (!isProcessAlive(pid)) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (isMissingProcessError(error)) return;
    throw error;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(pid)) return;
    await Bun.sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (isMissingProcessError(error)) return;
    throw error;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessAlive(pid)) return;
    await Bun.sleep(100);
  }
}

function isMissingProcessError(error: unknown) {
  return error instanceof Error && "code" in error && (error as any).code === "ESRCH";
}

function getProcessCommand(pid: number) {
  const result = Bun.spawnSync(["ps", "-p", pid.toString(), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return "";
  return result.stdout.toString().trim();
}
