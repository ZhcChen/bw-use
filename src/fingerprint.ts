import type { Fingerprint } from "./store";

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min: number, max: number) => +(Math.random() * (max - min) + min).toFixed(2);

const CHROME_PATH =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Detect real Chrome version at startup
let realChromeVersion = "130.0.0.0";
try {
  const proc = Bun.spawnSync([CHROME_PATH, "--version"], { stdout: "pipe" });
  const output = new TextDecoder().decode(proc.stdout).trim();
  const match = output.match(/(\d+\.\d+\.\d+\.\d+)/);
  if (match) realChromeVersion = match[1]!;
} catch {}

const PLATFORMS = [
  { platform: "Win32", uaOs: "Windows NT 10.0; Win64; x64" },
  { platform: "MacIntel", uaOs: "Macintosh; Intel Mac OS X 10_15_7" },
  { platform: "Linux x86_64", uaOs: "X11; Linux x86_64" },
];

const RESOLUTIONS: Array<readonly [number, number]> = [
  [1366, 768], [1440, 900], [1536, 864], [1600, 900],
  [1920, 1080], [2560, 1440], [1680, 1050], [1280, 800], [1280, 720],
];

const WEBGL_CONFIGS = [
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M1, OpenGL 4.1)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M2, OpenGL 4.1)" },
  { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M3, OpenGL 4.1)" },
];

const HARDWARE_CONCURRENCY = [2, 4, 6, 8, 10, 12, 16];
const DEVICE_MEMORY = [2, 4, 8, 16];

const TIMEZONES = [
  { tz: "Asia/Shanghai", offset: -480 },
  { tz: "Asia/Tokyo", offset: -540 },
  { tz: "Asia/Seoul", offset: -540 },
  { tz: "America/New_York", offset: 300 },
  { tz: "America/Chicago", offset: 360 },
  { tz: "America/Los_Angeles", offset: 480 },
  { tz: "Europe/London", offset: 0 },
  { tz: "Europe/Berlin", offset: -60 },
  { tz: "Europe/Paris", offset: -60 },
  { tz: "Australia/Sydney", offset: -660 },
];

const CONNECTION_TYPES = [
  { type: "4g", downlink: 10, rtt: 50 },
  { type: "4g", downlink: 5.6, rtt: 100 },
  { type: "4g", downlink: 2.3, rtt: 150 },
  { type: "wifi", downlink: 30, rtt: 25 },
  { type: "wifi", downlink: 15, rtt: 50 },
  { type: "ethernet", downlink: 100, rtt: 10 },
];

// Common fonts across platforms
const FONT_POOLS = {
  Win32: [
    "Arial", "Verdana", "Times New Roman", "Courier New", "Georgia",
    "Trebuchet MS", "Impact", "Comic Sans MS", "Tahoma", "Segoe UI",
    "Calibri", "Cambria", "Consolas", "Lucida Console", "Microsoft Sans Serif",
  ],
  MacIntel: [
    "Arial", "Verdana", "Times New Roman", "Courier New", "Georgia",
    "Helvetica", "Helvetica Neue", "Lucida Grande", "Monaco", "Menlo",
    "San Francisco", "Avenir", "Futura", "Optima", "Palatino",
  ],
  "Linux x86_64": [
    "Arial", "Verdana", "Times New Roman", "Courier New", "Georgia",
    "DejaVu Sans", "DejaVu Serif", "Liberation Sans", "Liberation Serif",
    "Ubuntu", "Noto Sans", "Noto Serif", "Droid Sans", "Cantarell", "FreeSans",
  ],
};

export function generateFingerprint(): Fingerprint {
  const platformInfo = pick(PLATFORMS);
  const resolution = pick(RESOLUTIONS);
  const webgl = pick(WEBGL_CONFIGS);
  const tz = pick(TIMEZONES);
  const conn = pick(CONNECTION_TYPES);
  const fontPool = FONT_POOLS[platformInfo.platform as keyof typeof FONT_POOLS] || FONT_POOLS.Win32;
  // Pick 8-12 random fonts
  const fontCount = randInt(8, 12);
  const shuffled = [...fontPool].sort(() => Math.random() - 0.5);
  const fonts = shuffled.slice(0, fontCount);

  return {
    userAgent: `Mozilla/5.0 (${platformInfo.uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${realChromeVersion} Safari/537.36`,
    platform: platformInfo.platform,
    screenWidth: resolution[0],
    screenHeight: resolution[1],
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY),
    deviceMemory: pick(DEVICE_MEMORY),
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    timezone: tz.tz,
    timezoneOffset: tz.offset,
    devicePixelRatio: pick([1, 1, 1.25, 1.5, 2, 2]),
    maxTouchPoints: 0,
    doNotTrack: pick(["1", null as any, "unspecified"]),
    canvasNoiseSeed: randInt(1, 999999),
    audioNoiseSeed: randInt(1, 999999),
    webrtcPolicy: pick(["default", "disable", "public_only"] as const),
    connectionType: conn.type,
    connectionDownlink: conn.downlink,
    connectionRtt: conn.rtt,
    mediaDevices: {
      audioinput: pick([1, 1, 2]),
      videoinput: pick([0, 1, 1]),
      audiooutput: pick([1, 1, 2, 3]),
    },
    fonts,
  };
}
