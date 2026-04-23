import { rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger";

const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * Clean up all macOS residual data for a browser instance.
 */
export async function cleanupMacOS(appPath: string, bundleId: string) {
  // 1. Unpin from Dock
  const removedPersistent = await removeDockEntries("persistent-apps", appPath);
  const removedRecent = await removeDockEntries("recent-apps", appPath);
  if (removedPersistent || removedRecent) {
    await restartDock();
  }

  // 2. Remove Saved Application State
  await removeSavedApplicationState(bundleId);

  // 3. Unregister from LaunchServices
  try {
    const proc = Bun.spawn(
      [LSREGISTER, "-u", appPath],
      { stdout: "ignore", stderr: "ignore" }
    );
    await proc.exited;
    log("info", "cleanup", "Unregistered from LaunchServices", appPath);
  } catch (err: any) {
    log("warn", "cleanup", "Failed to unregister from LaunchServices", err.message);
  }
}

/**
 * Remove runtime Dock residue after app close so managed browser apps do not
 * remain in "recent apps" and produce duplicate Dock icons on next launch.
 */
export async function cleanupMacOSAfterClose(appPath: string, bundleId: string) {
  const removedRecent = await removeDockEntries("recent-apps", appPath);
  if (removedRecent) {
    await restartDock();
  }
  await removeSavedApplicationState(bundleId);
}

async function removeSavedApplicationState(bundleId: string) {
  const savedStatePath = join(homedir(), "Library", "Saved Application State", `${bundleId}.savedState`);
  try {
    await rm(savedStatePath, { recursive: true, force: true });
    log("info", "cleanup", "Removed Saved Application State", savedStatePath);
  } catch {}
}

async function removeDockEntries(section: "persistent-apps" | "recent-apps", appPath: string) {
  try {
    const plistPath = join(process.env.HOME || homedir(), "Library", "Preferences", "com.apple.dock.plist");
    const proc = Bun.spawn(
      ["defaults", "read", "com.apple.dock", section],
      { stdout: "pipe", stderr: "ignore" }
    );
    await new Response(proc.stdout).text();
    await proc.exited;

    let removed = false;
    for (let i = 200; i >= 0; i--) {
      const checkProc = Bun.spawn(
        [
          PLIST_BUDDY,
          "-c",
          `Print ${section}:${i}:tile-data:file-data:_CFURLString`,
          plistPath,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const url = (await new Response(checkProc.stdout).text()).trim();
      const code = await checkProc.exited;
      if (code !== 0) continue;

      if (matchesDockAppPath(url, appPath)) {
        const delProc = Bun.spawn(
          [
            PLIST_BUDDY,
            "-c",
            `Delete ${section}:${i}`,
            plistPath,
          ],
          { stdout: "ignore", stderr: "pipe" }
        );
        await delProc.exited;
        removed = true;
      }
    }

    if (removed) {
      log("info", "cleanup", `Removed app from Dock ${section}`, appPath);
    }
    return removed;
  } catch (err: any) {
    log("warn", "cleanup", `Failed to clean Dock ${section}`, err.message);
    return false;
  }
}

function matchesDockAppPath(url: string, appPath: string) {
  const normalizedAppPath = normalizeDockPath(appPath);
  const normalizedUrl = normalizeDockPath(url);

  return normalizedUrl === normalizedAppPath || normalizedUrl.includes(normalizedAppPath);
}

function normalizeDockPath(value: string) {
  let normalized = value.trim();
  if (normalized.startsWith("file://")) {
    normalized = normalized.slice("file://".length);
  }
  try {
    normalized = decodeURIComponent(normalized);
  } catch {}
  return normalized.replace(/\/+$/, "");
}

async function restartDock() {
  try {
    const killProc = Bun.spawn(["killall", "Dock"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await killProc.exited;
    log("info", "cleanup", "Restarted Dock");
  } catch (err: any) {
    log("warn", "cleanup", "Failed to restart Dock", err.message);
  }
}
