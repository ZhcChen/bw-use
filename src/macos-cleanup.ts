import { rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger";

/**
 * Clean up all macOS residual data for a browser instance.
 */
export async function cleanupMacOS(appPath: string, bundleId: string) {
  // 1. Unpin from Dock
  await unpinFromDock(appPath);

  // 2. Remove Saved Application State
  const savedStatePath = join(homedir(), "Library", "Saved Application State", `${bundleId}.savedState`);
  try {
    await rm(savedStatePath, { recursive: true, force: true });
    log("info", "cleanup", "Removed Saved Application State", savedStatePath);
  } catch {}

  // 3. Unregister from LaunchServices
  try {
    const proc = Bun.spawn(
      [
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        "-u",
        appPath,
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    await proc.exited;
    log("info", "cleanup", "Unregistered from LaunchServices", appPath);
  } catch (err: any) {
    log("warn", "cleanup", "Failed to unregister from LaunchServices", err.message);
  }
}

/**
 * Remove app from Dock's persistent-apps if pinned.
 * Reads com.apple.dock.plist, finds matching entry, removes it, restarts Dock.
 */
async function unpinFromDock(appPath: string) {
  try {
    // Read current Dock plist as JSON
    const proc = Bun.spawn(
      ["defaults", "read", "com.apple.dock", "persistent-apps"],
      { stdout: "pipe", stderr: "ignore" }
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Check if our app path appears in the Dock config
    if (!output.includes(appPath)) {
      log("info", "cleanup", "App not pinned to Dock, skipping");
      return;
    }

    // Find and remove the entry using PlistBuddy
    // First, get count of persistent-apps
    const countProc = Bun.spawn(
      [
        "/usr/libexec/PlistBuddy",
        "-c",
        "Print persistent-apps",
        join(process.env.HOME || homedir(), "Library", "Preferences", "com.apple.dock.plist"),
      ],
      { stdout: "pipe", stderr: "ignore" }
    );
    const countOutput = await new Response(countProc.stdout).text();
    await countProc.exited;

    // Parse entries to find index. PlistBuddy output has Dict blocks.
    // We look for the file-data -> _CFURLString matching our app path
    const plistPath = join(process.env.HOME || homedir(), "Library", "Preferences", "com.apple.dock.plist");

    // Try each index until we find or exhaust
    for (let i = 100; i >= 0; i--) {
      const checkProc = Bun.spawn(
        [
          "/usr/libexec/PlistBuddy",
          "-c",
          `Print persistent-apps:${i}:tile-data:file-data:_CFURLString`,
          plistPath,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const url = (await new Response(checkProc.stdout).text()).trim();
      const code = await checkProc.exited;
      if (code !== 0) continue;

      // Match by path (Dock stores file:// URLs or plain paths)
      if (url.includes(appPath) || url === `file://${appPath}/`) {
        // Delete this entry
        const delProc = Bun.spawn(
          [
            "/usr/libexec/PlistBuddy",
            "-c",
            `Delete persistent-apps:${i}`,
            plistPath,
          ],
          { stdout: "ignore", stderr: "pipe" }
        );
        await delProc.exited;

        // Restart Dock to apply
        const killProc = Bun.spawn(["killall", "Dock"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        await killProc.exited;

        log("info", "cleanup", "Unpinned from Dock and restarted Dock", appPath);
        return;
      }
    }

    log("info", "cleanup", "App path in Dock config but entry not found by PlistBuddy");
  } catch (err: any) {
    log("warn", "cleanup", "Failed to unpin from Dock", err.message);
  }
}
