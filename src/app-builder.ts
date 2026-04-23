import { join } from "path";
import { mkdir, writeFile, chmod, readFile, access } from "fs/promises";
import { log } from "./logger";

const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Generate a .app wrapper bundle for a browser instance.
 * Structure:
 *   Browser.app/
 *     Contents/
 *       Info.plist
 *       MacOS/
 *         launch       (shell script)
 *       Resources/
 *         app.icns     (current logo + short id footer)
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
  const iconLabelPath = join(resourcesDir, ".icon-label");
  const iconPath = join(resourcesDir, "app.icns");

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
exec '${getChromePath().replace(/'/g, "'\\''")}' \\
    ${escapedArgs}
`;

  await writeFileIfChanged(join(contentsDir, "Info.plist"), plist);
  await writeFileIfChanged(join(macosDir, "launch"), launchScript);
  await chmod(join(macosDir, "launch"), 0o755);

  // Icon generation is expensive on macOS. Reuse the existing icon unless
  // the visible short id actually changed or the icon is missing.
  const iconLabel = getShortIconId(id);
  const previousIconLabel = await readOptionalText(iconLabelPath);
  const shouldRegenerateIcon =
    !(await fileExists(iconPath)) || previousIconLabel !== iconLabel;
  if (shouldRegenerateIcon) {
    await generateIcon(resourcesDir, iconLabel);
    await writeFile(iconLabelPath, iconLabel, "utf-8");
  }

  log("info", "app-bundle", `Built ${safeName}.app`, `path=${appDir}`);
  return appDir;
}

/**
 * Generate an .icns icon using the current app logo with a short browser id
 * shown in the footer.
 * Uses macOS sips + iconutil via a temporary iconset.
 * Falls back to copying Chrome's icon if generation fails.
 */
async function generateIcon(resourcesDir: string, shortId: string) {
  const iconsetDir = join(resourcesDir, "app.iconset");
  await mkdir(iconsetDir, { recursive: true });

  // Generate icon PNGs using built-in macOS tools
  const sizes = [16, 32, 64, 128, 256, 512];

  for (const size of sizes) {
    const svg = generateIconSvg(size, shortId);
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
      await generateFallbackIcon(resourcesDir, shortId);
    }
  } catch {
    await generateFallbackIcon(resourcesDir, shortId);
  }

  // Cleanup
  const { rm } = await import("fs/promises");
  await rm(iconsetDir, { recursive: true, force: true }).catch(() => {});
  await rm(join(resourcesDir, "_tmp.svg"), { force: true }).catch(() => {});
}

function generateIconSvg(size: number, shortId: string): string {
  const baseSize = 64;
  const idFontSize = 8.5;
  const footerHeight = 12;
  const footerY = 46;
  const footerX = 8;
  const footerWidth = baseSize - footerX * 2;
  const footerRadius = 4.5;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${baseSize} ${baseSize}">
  <g>
    <rect x="4" y="8" width="56" height="48" rx="6" fill="#1e293b" stroke="#3b82f6" stroke-width="3"/>
    <rect x="4" y="8" width="56" height="14" rx="6" fill="#3b82f6"/>
    <rect x="4" y="16" width="56" height="6" fill="#3b82f6"/>
    <circle cx="14" cy="15" r="2.5" fill="#1e293b"/>
    <circle cx="22" cy="15" r="2.5" fill="#1e293b"/>
    <circle cx="30" cy="15" r="2.5" fill="#1e293b"/>
    <circle cx="32" cy="40" r="10" fill="none" stroke="#60a5fa" stroke-width="2"/>
    <circle cx="32" cy="40" r="6" fill="none" stroke="#60a5fa" stroke-width="1.5"/>
    <circle cx="32" cy="40" r="2" fill="#60a5fa"/>
    <path d="M32 28 Q38 34 32 40 Q26 34 32 28Z" fill="none" stroke="#60a5fa" stroke-width="1.2"/>
    <path d="M32 40 Q38 46 32 52 Q26 46 32 40Z" fill="none" stroke="#60a5fa" stroke-width="1.2"/>
  </g>
  <rect x="${footerX}" y="${footerY}" width="${footerWidth}" height="${footerHeight}" rx="${footerRadius}" fill="#020617" opacity="0.94"/>
  <text x="32" y="${footerY + footerHeight / 2 + 0.8}" font-family="SF Mono, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace" font-size="${idFontSize}" font-weight="700" letter-spacing="0.6" fill="#f8fafc" text-anchor="middle" dominant-baseline="middle">${escXml(shortId)}</text>
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

async function writeFileIfChanged(filePath: string, content: string) {
  const previous = await readOptionalText(filePath);
  if (previous === content) {
    return;
  }
  await writeFile(filePath, content);
}

async function readOptionalText(filePath: string) {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getShortIconId(id: string) {
  const normalized = id.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return (normalized || "BROWSER").slice(0, 4);
}

function getChromePath() {
  return process.env.CHROME_PATH || DEFAULT_CHROME_PATH;
}
