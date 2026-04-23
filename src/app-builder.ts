import { join } from "path";
import { mkdir, writeFile, chmod } from "fs/promises";
import { log } from "./logger";

const CHROME_PATH =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Generate a .app wrapper bundle for a browser instance.
 * Structure:
 *   BrowserName.app/
 *     Contents/
 *       Info.plist
 *       MacOS/
 *         launch       (shell script)
 *       Resources/
 *         app.icns     (icon - TODO: generate with text overlay)
 */
export async function buildAppBundle(
  profileDir: string,
  name: string,
  id: string,
  chromeArgs: string[]
): Promise<string> {
  const safeName = name.replace(/[^\w\s\u4e00-\u9fff-]/g, "").trim() || "Browser";
  const appDir = join(profileDir, "Browser.app");
  const contentsDir = join(appDir, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const resourcesDir = join(contentsDir, "Resources");

  await mkdir(macosDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });

  const bundleId = `com.bw-use.browser.${id}`;

  // Info.plist
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleName</key>
  <string>${safeName}</string>
  <key>CFBundleDisplayName</key>
  <string>${safeName}</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>app.icns</string>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>`;

  // Launch script - exec Chrome so the Chrome process replaces the shell,
  // Dock icon stays as our .app
  const escapedArgs = chromeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" \\\n    ");
  const launchScript = `#!/bin/bash
exec '${CHROME_PATH.replace(/'/g, "'\\''")}' \\
    ${escapedArgs}
`;

  await writeFile(join(contentsDir, "Info.plist"), plist);
  await writeFile(join(macosDir, "launch"), launchScript);
  await chmod(join(macosDir, "launch"), 0o755);

  // Generate icon with text overlay
  await generateIcon(resourcesDir, safeName);

  log("info", "app-bundle", `Built ${safeName}.app`, `path=${appDir}`);
  return appDir;
}

/**
 * Generate an .icns icon with the browser name overlaid.
 * Uses macOS sips + iconutil via a temporary iconset.
 * Falls back to copying Chrome's icon if generation fails.
 */
async function generateIcon(resourcesDir: string, name: string) {
  const iconsetDir = join(resourcesDir, "app.iconset");
  await mkdir(iconsetDir, { recursive: true });

  // Label text: first 2 chars of name
  const label = name.slice(0, 2);

  // Generate icon PNGs using built-in macOS tools
  const sizes = [16, 32, 64, 128, 256, 512];

  for (const size of sizes) {
    const svg = generateIconSvg(size, label);
    const pngPath = join(iconsetDir, `icon_${size}x${size}.png`);
    const png2xPath = join(iconsetDir, `icon_${size}x${size}@2x.png`);

    // Use qlmanage or sips to convert SVG to PNG
    // Since we can't easily do SVG->PNG with built-in tools, draw with HTML canvas approach
    // Instead, use a simple approach: write SVG, convert with sips
    const svgPath = join(resourcesDir, "_tmp.svg");
    await writeFile(svgPath, svg);

    try {
      // Try rsvg-convert first, then sips
      const proc = Bun.spawn(
        ["sips", "-s", "format", "png", "-z", String(size), String(size), svgPath, "--out", pngPath],
        { stdout: "ignore", stderr: "ignore" }
      );
      await proc.exited;

      if (size <= 256) {
        const proc2x = Bun.spawn(
          ["sips", "-s", "format", "png", "-z", String(size * 2), String(size * 2), svgPath, "--out", png2xPath],
          { stdout: "ignore", stderr: "ignore" }
        );
        await proc2x.exited;
      }
    } catch {}
  }

  // Convert iconset to icns
  try {
    const proc = Bun.spawn(
      ["iconutil", "-c", "icns", iconsetDir, "-o", join(resourcesDir, "app.icns")],
      { stdout: "ignore", stderr: "pipe" }
    );
    const code = await proc.exited;
    if (code !== 0) {
      log("warn", "app-bundle", "iconutil failed, using fallback icon");
      await generateFallbackIcon(resourcesDir, label);
    }
  } catch {
    await generateFallbackIcon(resourcesDir, label);
  }

  // Cleanup
  const { rm } = await import("fs/promises");
  await rm(iconsetDir, { recursive: true, force: true }).catch(() => {});
  await rm(join(resourcesDir, "_tmp.svg"), { force: true }).catch(() => {});
}

function generateIconSvg(size: number, label: string): string {
  const fontSize = Math.round(size * 0.35);
  const badgeFontSize = Math.round(size * 0.22);
  const padding = Math.round(size * 0.08);
  const radius = Math.round(size * 0.18);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#1e293b"/>
  <rect x="${padding}" y="${padding}" width="${size - padding * 2}" height="${size * 0.3}" rx="${Math.round(radius * 0.6)}" fill="#3b82f6"/>
  <circle cx="${padding + size * 0.08}" cy="${padding + size * 0.15}" r="${size * 0.03}" fill="#1e293b"/>
  <circle cx="${padding + size * 0.16}" cy="${padding + size * 0.15}" r="${size * 0.03}" fill="#1e293b"/>
  <circle cx="${padding + size * 0.24}" cy="${padding + size * 0.15}" r="${size * 0.03}" fill="#1e293b"/>
  <text x="${size / 2}" y="${size * 0.7}" font-family="Helvetica Neue, Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#60a5fa" text-anchor="middle" dominant-baseline="middle">${escXml(label)}</text>
  <rect x="${size * 0.55}" y="${padding * 0.5}" width="${size * 0.42}" height="${badgeFontSize + padding}" rx="${(badgeFontSize + padding) / 2}" fill="#ef4444"/>
  <text x="${size * 0.76}" y="${padding * 0.5 + (badgeFontSize + padding) / 2}" font-family="Helvetica Neue, Arial, sans-serif" font-size="${badgeFontSize * 0.7}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="central">${escXml(label)}</text>
</svg>`;
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Fallback: generate a simple TIFF icon using sips from a solid color PNG
 */
async function generateFallbackIcon(resourcesDir: string, label: string) {
  // Create a minimal 256x256 SVG and convert
  const svg = generateIconSvg(256, label);
  const svgPath = join(resourcesDir, "_fallback.svg");
  const pngPath = join(resourcesDir, "_fallback.png");
  const icnsPath = join(resourcesDir, "app.icns");

  await writeFile(svgPath, svg);
  try {
    const proc = Bun.spawn(
      ["sips", "-s", "format", "png", "-z", "256", "256", svgPath, "--out", pngPath],
      { stdout: "ignore", stderr: "ignore" }
    );
    await proc.exited;
    // sips can convert PNG to icns
    const proc2 = Bun.spawn(
      ["sips", "-s", "format", "icns", pngPath, "--out", icnsPath],
      { stdout: "ignore", stderr: "ignore" }
    );
    await proc2.exited;
  } catch {}

  const { rm } = await import("fs/promises");
  await rm(svgPath, { force: true }).catch(() => {});
  await rm(pngPath, { force: true }).catch(() => {});
}

export function getBundleId(id: string): string {
  return `com.bw-use.browser.${id}`;
}
