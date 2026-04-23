import { spawn, type Subprocess } from "bun";
import { rm, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { getBrowser, updateBrowserStatus, removeBrowser, getProfileDir, type BrowserInstance } from "./store";
import { buildExtension } from "./extension-builder";
import { getBundleId } from "./app-builder";
import { cleanupMacOS, cleanupMacOSAfterClose, scheduleMacOSCleanupRetries } from "./macos-cleanup";
import { log } from "./logger";
import { ensureProxyBridge, stopProxyBridge } from "./proxy-bridge";
import { formatProxyServer, hasProxyCredentials, summarizeProxy } from "./proxy";

const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BROWSER_STOP_TIMEOUT_MS = 4_000;
const BROWSER_POLL_INTERVAL_MS = 250;

// Track running processes in memory (pid -> id)
const runningBrowsers = new Map<string, number>();
const browserExitMonitors = new Map<string, Promise<void>>();

export async function launchBrowser(id: string): Promise<BrowserInstance> {
  const browser = getBrowser(id);
  if (!browser) throw new Error("Browser not found");
  if (browser.status === "running") {
    const existingPid = await findRunningBrowserPidByProfileId(id);
    if (existingPid) {
      throw new Error("Browser already running");
    }

    log("warn", "launch", "Browser status was running but no process was found, resetting state", `id=${id}`);
    updateBrowserStatus(id, "stopped", null);
    browser.status = "stopped";
  }

  const profileDir = getProfileDir(id);
  await mkdir(profileDir, { recursive: true });

  log("info", "launch", `Starting browser "${browser.name}"`, `id=${id}`);

  const existingPid = await findRunningBrowserPidByProfileId(id);
  if (existingPid) {
    log("info", "launch", "Detected existing browser process, reusing", `id=${id} pid=${existingPid}`);
    runningBrowsers.set(id, existingPid);
    updateBrowserStatus(id, "running", existingPid);
    startBrowserExitMonitor(id);
    return { ...browser, status: "running", pid: existingPid };
  }

  // Build fingerprint extension
  const extDir = await buildExtension(profileDir, browser.fingerprint, browser.name, null);

  const args: string[] = [
    `--user-data-dir=${profileDir}`,
    "--use-mock-keychain",
    "--no-first-run",
    "--no-default-browser-check",
    "--restore-last-session",
    `--user-agent=${browser.fingerprint.userAgent}`,
    `--lang=${browser.language}`,
    `--accept-lang=${browser.language}`,
    `--load-extension=${extDir}`,
    // Performance
    "--enable-gpu-rasterization",
    "--enable-zero-copy",
    "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];

  // WebRTC policy via Chrome flag
  if (browser.fingerprint.webrtcPolicy === "disable") {
    args.push("--disable-webrtc");
  } else if (browser.fingerprint.webrtcPolicy === "public_only") {
    args.push("--force-webrtc-ip-handling-policy=default_public_interface_only");
  }

  if (process.env.CHROME_NO_SANDBOX === "1") {
    args.push("--no-sandbox");
  }

  if (!process.env.DISPLAY && process.platform === "linux") {
    args.push("--headless=new");
    log("warn", "launch", "No DISPLAY detected, running in headless mode");
  }

  if (browser.disableCors) {
    args.push("--disable-web-security", "--disable-site-isolation-trials");
  }

  if (browser.proxy) {
    if (hasProxyCredentials(browser.proxy)) {
      const bridge = await ensureProxyBridge(getProxyBridgeKey(id), browser.proxy);
      args.push(`--proxy-server=http://${bridge.host}:${bridge.port}`);
    } else {
      args.push(`--proxy-server=${formatProxyServer(browser.proxy)}`);
    }
    log("info", "launch", "Using proxy", summarizeProxy(browser.proxy));
  }

  log("info", "launch", `Chrome args`, args.join(" "));

  const proc = spawn([getChromePath(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const pid = proc.pid;
  log("info", "launch", `Chrome spawned`, `pid=${pid}`);

  runningBrowsers.set(id, pid);
  updateBrowserStatus(id, "running", pid);

  proc.exited.then(async (exitCode) => {
    await stopProxyBridge(getProxyBridgeKey(id));
    runningBrowsers.delete(id);
    if (exitCode !== 0 && exitCode !== null) {
      const stderr = await readStream(proc.stderr as ReadableStream<Uint8Array>);
      log("error", "launch", `Chrome exited with code ${exitCode}`, stderr || "(no output)");
    } else {
      log("info", "launch", `Chrome exited normally`, `pid=${pid}`);
    }
    updateBrowserStatus(id, "stopped", null);
  });

  return { ...browser, status: "running", pid };
}

export async function closeBrowser(id: string): Promise<BrowserInstance> {
  const browser = getBrowser(id);
  if (!browser) throw new Error("Browser not found");
  if (browser.status !== "running") {
    const existingPid = await findRunningBrowserPidByProfileId(id);
    if (!existingPid) {
      throw new Error("Browser not running");
    }

    log("warn", "close", "Browser status was stopped but process still exists, closing actual process", `id=${id} pid=${existingPid}`);
    updateBrowserStatus(id, "running", existingPid);
    browser.status = "running";
    browser.pid = existingPid;
  }

  log("info", "close", `Closing browser "${browser.name}"`, `id=${id}`);

  const profileDir = getProfileDir(id);
  const appPath = process.platform === "darwin" ? await findAppPath(profileDir) : null;

  let stopped = false;

  if (!stopped) {
    await killProcessesByProfileId(id);
    stopped = await waitForBrowserExit(id, 2_000);
  }

  if (!stopped) {
    throw new Error(`Failed to stop browser process: ${browser.name}`);
  }

  if (process.platform === "darwin" && appPath) {
    const bundleId = getBundleId(id);
    await cleanupMacOSAfterClose(appPath, bundleId);
    scheduleMacOSCleanupRetries(appPath, bundleId);
  }

  await stopProxyBridge(getProxyBridgeKey(id));
  runningBrowsers.delete(id);
  updateBrowserStatus(id, "stopped", null);
  return { ...browser, status: "stopped", pid: null };
}

export async function deleteBrowser(id: string): Promise<void> {
  const browser = getBrowser(id);
  if (!browser) throw new Error("Browser not found");

  log("info", "delete", `Deleting browser "${browser.name}"`, `id=${id}`);

  // Close if running
  if (browser.status === "running") {
    await closeBrowser(id);
  }

  // Kill ALL Chrome processes using this profile, then cleanup macOS residual
  const profileDir = getProfileDir(id);
  await killProcessesByProfileId(id);

  // macOS cleanup: Dock unpin, LaunchServices, SavedState
  if (process.platform === "darwin") {
    const appPath = await findAppPath(profileDir);
    if (appPath) {
      const bundleId = getBundleId(id);
      await cleanupMacOS(appPath, bundleId);
      scheduleMacOSCleanupRetries(appPath, bundleId);
    }
  }

  await stopProxyBridge(getProxyBridgeKey(id));

  // Delete profile directory completely (includes .app bundle)
  // Retry because Chrome may briefly write data after being killed
  for (let i = 0; i < 5; i++) {
    await rm(profileDir, { recursive: true, force: true });
    // Check if actually gone
    try {
      await readdir(profileDir);
      // Still exists, wait and retry
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Directory gone
      break;
    }
  }
  log("info", "delete", `Deleted profile directory`, profileDir);

  // Remove from DB
  removeBrowser(id);
  log("info", "delete", `Removed from database`, `id=${id}`);
}

/**
 * Kill all processes whose command line contains the profile id.
 * Matches Chrome main process + all Helper subprocesses.
 * Uses SIGTERM first, then SIGKILL.
 */
async function killProcessesByProfileId(id: string) {
  const processMatchPattern = getBrowserProcessMatchPattern(id);
  // pkill -f matches against the full command line of each process
  // The profile id is unique enough and appears in --user-data-dir of all Chrome processes
  try {
    // Graceful first
    const p1 = spawn([getPkillBin(), "-f", "--", processMatchPattern], { stdout: "ignore", stderr: "ignore" });
    await p1.exited;
    log("info", "kill", `Sent SIGTERM to processes matching "${id}"`);
  } catch {}

  await new Promise((r) => setTimeout(r, 2000));

  try {
    // Force kill survivors
    const p2 = spawn([getPkillBin(), "-9", "-f", "--", processMatchPattern], { stdout: "ignore", stderr: "ignore" });
    await p2.exited;
  } catch {}

  await new Promise((r) => setTimeout(r, 500));
  log("info", "kill", `All processes killed for "${id}"`);
}

/** Find the .app bundle path inside a profile directory */
async function findAppPath(profileDir: string): Promise<string | null> {
  try {
    const entries = await readdir(profileDir);
    const app = entries.find((e) => e.endsWith(".app"));
    return app ? join(profileDir, app) : null;
  } catch {
    return null;
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const MAX = 8192;
  try {
    while (total < MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {}
  reader.releaseLock();
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX);
}

async function findRunningBrowserPidByProfileId(id: string): Promise<number | null> {
  const processMatchPattern = getBrowserProcessMatchPattern(id);
  try {
    const proc = spawn([getPgrepBin(), "-o", "-f", "--", processMatchPattern], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      readStream(proc.stdout as ReadableStream<Uint8Array> | null),
    ]);
    if (exitCode !== 0) {
      return null;
    }

    const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] || "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function getBrowserProcessMatchPattern(id: string) {
  return escapeProcessMatchPattern(`--user-data-dir=${getProfileDir(id)}`);
}

function getProxyBridgeKey(id: string) {
  return `browser:${id}`;
}

function escapeProcessMatchPattern(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function getChromePath() {
  return process.env.CHROME_PATH || DEFAULT_CHROME_PATH;
}

function getPgrepBin() {
  return process.env.BW_USE_PGREP_BIN || "pgrep";
}

function getPkillBin() {
  return process.env.BW_USE_PKILL_BIN || "pkill";
}

async function waitForBrowserExit(id: string, timeoutMs = BROWSER_STOP_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await findRunningBrowserPidByProfileId(id);
    if (!pid) {
      return true;
    }
    await Bun.sleep(BROWSER_POLL_INTERVAL_MS);
  }
  return false;
}

function startBrowserExitMonitor(id: string) {
  if (browserExitMonitors.has(id)) {
    return;
  }

  const monitor = (async () => {
    while (true) {
      const pid = await findRunningBrowserPidByProfileId(id);
      if (!pid) {
        await stopProxyBridge(getProxyBridgeKey(id));
        runningBrowsers.delete(id);
        updateBrowserStatus(id, "stopped", null);
        log("info", "launch", "Browser process exited", `id=${id}`);
        return;
      }

      const currentPid = runningBrowsers.get(id);
      if (currentPid !== pid) {
        runningBrowsers.set(id, pid);
        updateBrowserStatus(id, "running", pid);
      }

      await Bun.sleep(1_500);
    }
  })().finally(() => {
    browserExitMonitors.delete(id);
  });

  browserExitMonitors.set(id, monitor);
}
