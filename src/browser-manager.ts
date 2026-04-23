import { spawn, type Subprocess } from "bun";
import { rm, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { getBrowser, updateBrowserStatus, removeBrowser, getProfileDir, type BrowserInstance } from "./store";
import { buildExtension } from "./extension-builder";
import { getBundleId } from "./app-builder";
import { cleanupMacOS } from "./macos-cleanup";
import { log } from "./logger";
import { formatProxyServer, summarizeProxy } from "./proxy";

const CHROME_PATH =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Track running processes in memory (pid -> id)
const runningBrowsers = new Map<string, number>();

export async function launchBrowser(id: string): Promise<BrowserInstance> {
  const browser = getBrowser(id);
  if (!browser) throw new Error("Browser not found");
  if (browser.status === "running") throw new Error("Browser already running");

  const profileDir = getProfileDir(id);
  await mkdir(profileDir, { recursive: true });

  log("info", "launch", `Starting browser "${browser.name}"`, `id=${id}`);

  // Build fingerprint extension
  const extDir = await buildExtension(profileDir, browser.fingerprint, browser.name, browser.proxy);

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
    args.push(`--proxy-server=${formatProxyServer(browser.proxy)}`);
    log("info", "launch", "Using proxy", summarizeProxy(browser.proxy));
  }

  log("info", "launch", `Chrome args`, args.join(" "));

  const proc = spawn([CHROME_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const pid = proc.pid;
  log("info", "launch", `Chrome spawned`, `pid=${pid}`);

  runningBrowsers.set(id, pid);
  updateBrowserStatus(id, "running", pid);

  proc.exited.then(async (exitCode) => {
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
  if (browser.status !== "running") throw new Error("Browser not running");

  log("info", "close", `Closing browser "${browser.name}"`, `id=${id}`);

  // Kill all processes associated with this browser instance by profile id
  await killProcessesByProfileId(id);

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
      await cleanupMacOS(appPath, getBundleId(id));
    }
  }

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
  // pkill -f matches against the full command line of each process
  // The profile id is unique enough and appears in --user-data-dir of all Chrome processes
  try {
    // Graceful first
    const p1 = spawn(["pkill", "-f", id], { stdout: "ignore", stderr: "ignore" });
    await p1.exited;
    log("info", "kill", `Sent SIGTERM to processes matching "${id}"`);
  } catch {}

  await new Promise((r) => setTimeout(r, 2000));

  try {
    // Force kill survivors
    const p2 = spawn(["pkill", "-9", "-f", id], { stdout: "ignore", stderr: "ignore" });
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
