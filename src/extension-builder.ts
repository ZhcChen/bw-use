import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import type { Fingerprint } from "./store";
import type { ProxyConfig } from "./proxy";

export async function buildExtension(
  profileDir: string,
  fingerprint: Fingerprint,
  browserName: string,
  proxy: ProxyConfig | null = null,
) {
  const extDir = join(profileDir, "fingerprint-ext");
  await mkdir(extDir, { recursive: true });

  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: "Fingerprint Override",
    version: "1.0",
    content_scripts: [
      {
        matches: ["http://*/*", "https://*/*"],
        js: ["inject.js"],
        run_at: "document_start",
        all_frames: false,
        world: "MAIN",
      },
    ],
  };

  const shouldHandleProxyAuth = !!(proxy && (proxy.username || proxy.password));
  if (shouldHandleProxyAuth) {
    manifest.permissions = ["webRequest", "webRequestAuthProvider"];
    manifest.host_permissions = ["<all_urls>"];
    manifest.background = {
      service_worker: "background.js",
    };
  }

  const injectJs = `'use strict';
(() => {
  const fp = ${JSON.stringify(fingerprint)};
  const BROWSER_NAME = ${JSON.stringify(browserName)};

  // ---- Navigator ----
  Object.defineProperties(Navigator.prototype, {
    platform: { get() { return fp.platform; }, configurable: true, enumerable: true },
    hardwareConcurrency: { get() { return fp.hardwareConcurrency; }, configurable: true, enumerable: true },
    deviceMemory: { get() { return fp.deviceMemory; }, configurable: true, enumerable: true },
    maxTouchPoints: { get() { return fp.maxTouchPoints; }, configurable: true, enumerable: true },
    doNotTrack: { get() { return fp.doNotTrack; }, configurable: true, enumerable: true },
  });

  // ---- Screen ----
  Object.defineProperties(Screen.prototype, {
    width: { get() { return fp.screenWidth; }, configurable: true, enumerable: true },
    height: { get() { return fp.screenHeight; }, configurable: true, enumerable: true },
    availWidth: { get() { return fp.screenWidth; }, configurable: true, enumerable: true },
    availHeight: { get() { return fp.screenHeight - 40; }, configurable: true, enumerable: true },
    colorDepth: { get() { return 24; }, configurable: true, enumerable: true },
    pixelDepth: { get() { return 24; }, configurable: true, enumerable: true },
  });

  // ---- devicePixelRatio ----
  Object.defineProperty(window, 'devicePixelRatio', {
    get() { return fp.devicePixelRatio; },
    configurable: true,
  });

  // ---- Timezone ----
  const origDTF = Intl.DateTimeFormat;
  const newDTF = function(...args) {
    if (args.length === 0 || (args.length >= 1 && !args[1])) args[1] = {};
    if (typeof args[1] === 'object' && !args[1].timeZone) args[1].timeZone = fp.timezone;
    return new origDTF(...args);
  };
  newDTF.prototype = origDTF.prototype;
  newDTF.supportedLocalesOf = origDTF.supportedLocalesOf;
  Intl.DateTimeFormat = newDTF;

  const origGetTZOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = function() { return fp.timezoneOffset; };

  // ---- WebGL ----
  function patchWebGL(proto) {
    const orig = proto.getParameter;
    proto.getParameter = function(p) {
      if (p === 0x9245) return fp.webglVendor;
      if (p === 0x9246) return fp.webglRenderer;
      return orig.call(this, p);
    };
  }
  if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);

  // ---- Canvas fingerprint noise ----
  // Seed-based deterministic noise so same seed = same fingerprint
  function seededRandom(seed) {
    let s = seed;
    return function() {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }
  const cRng = seededRandom(fp.canvasNoiseSeed);

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    injectCanvasNoise(this, cRng);
    return origToDataURL.apply(this, args);
  };

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function(cb, ...args) {
    injectCanvasNoise(this, cRng);
    return origToBlob.call(this, cb, ...args);
  };

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const data = origGetImageData.apply(this, args);
    // Add subtle noise to a few pixels
    const len = Math.min(data.data.length, 40);
    for (let i = 0; i < len; i += 4) {
      data.data[i] = (data.data[i] + ((cRng() * 3 - 1.5) | 0)) & 0xff;
    }
    return data;
  };

  function injectCanvasNoise(canvas, rng) {
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = Math.min(canvas.width, 4);
      const h = Math.min(canvas.height, 4);
      if (w === 0 || h === 0) return;
      const imgData = origGetImageData.call(ctx, 0, 0, w, h);
      for (let i = 0; i < imgData.data.length; i += 4) {
        imgData.data[i] = (imgData.data[i] + ((rng() * 3 - 1.5) | 0)) & 0xff;
      }
      ctx.putImageData(imgData, 0, 0);
    } catch(e) {}
  }

  // ---- AudioContext fingerprint noise ----
  const aRng = seededRandom(fp.audioNoiseSeed);
  if (typeof AudioContext !== 'undefined') {
    const origCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      const osc = origCreateOscillator.call(this);
      const origFreq = osc.frequency.value;
      osc.frequency.value = origFreq + (aRng() * 0.01 - 0.005);
      return osc;
    };

    const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function(array) {
      origGetFloatFreq.call(this, array);
      for (let i = 0; i < Math.min(array.length, 16); i++) {
        array[i] += (aRng() * 0.1 - 0.05);
      }
    };
  }

  // ---- WebRTC ----
  if (fp.webrtcPolicy === 'disable') {
    // Completely block RTC
    if (typeof RTCPeerConnection !== 'undefined') {
      window.RTCPeerConnection = undefined;
      window.webkitRTCPeerConnection = undefined;
    }
  } else if (fp.webrtcPolicy === 'public_only') {
    // Block local candidate gathering
    if (typeof RTCPeerConnection !== 'undefined') {
      const OrigRTC = RTCPeerConnection;
      window.RTCPeerConnection = function(config, ...rest) {
        if (!config) config = {};
        config.iceServers = config.iceServers || [];
        // Force relay-only to hide local IPs
        const inst = new OrigRTC({ ...config, iceCandidatePoolSize: 0 }, ...rest);
        const origAddEvent = inst.addEventListener.bind(inst);
        inst.addEventListener = function(type, listener, ...a) {
          if (type === 'icecandidate') {
            const wrapped = function(event) {
              if (event.candidate && event.candidate.candidate.indexOf('.local') !== -1) return;
              if (event.candidate && event.candidate.candidate.match(/([0-9]{1,3}\\.){3}[0-9]{1,3}/)) {
                const ip = event.candidate.candidate.match(/([0-9]{1,3}\\.){3}[0-9]{1,3}/)[0];
                if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return;
              }
              listener(event);
            };
            return origAddEvent(type, wrapped, ...a);
          }
          return origAddEvent(type, listener, ...a);
        };
        return inst;
      };
      window.RTCPeerConnection.prototype = OrigRTC.prototype;
    }
  }

  // ---- Connection / Network Info ----
  if ('connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator) {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      try {
        Object.defineProperties(conn, {
          effectiveType: { get() { return fp.connectionType; }, configurable: true },
          downlink: { get() { return fp.connectionDownlink; }, configurable: true },
          rtt: { get() { return fp.connectionRtt; }, configurable: true },
        });
      } catch(e) {}
    }
  }

  // ---- Media Devices ----
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async function() {
      const devices = [];
      for (let i = 0; i < fp.mediaDevices.audioinput; i++) {
        devices.push({ deviceId: 'ai' + i, kind: 'audioinput', label: '', groupId: 'g' + i });
      }
      for (let i = 0; i < fp.mediaDevices.videoinput; i++) {
        devices.push({ deviceId: 'vi' + i, kind: 'videoinput', label: '', groupId: 'g' + (10 + i) });
      }
      for (let i = 0; i < fp.mediaDevices.audiooutput; i++) {
        devices.push({ deviceId: 'ao' + i, kind: 'audiooutput', label: '', groupId: 'g' + (20 + i) });
      }
      return devices;
    };
  }

  // ---- Font enumeration defense ----
  // Override document.fonts.check to only report our allowed fonts
  if (document.fonts && document.fonts.check) {
    const allowedFonts = new Set(fp.fonts.map(f => f.toLowerCase()));
    const origCheck = document.fonts.check.bind(document.fonts);
    document.fonts.check = function(font, text) {
      // font is like "12px Arial" or "bold 16px 'Times New Roman'"
      const match = font.match(/['\"]?([^'\"]+)['\"]?$/);
      if (match) {
        const name = match[1].trim().toLowerCase();
        if (!allowedFonts.has(name)) return false;
      }
      return origCheck(font, text);
    };
  }

  // ---- Window title prefix ----
  const prefix = '[' + BROWSER_NAME + '] ';
  const origTitle = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  Object.defineProperty(Document.prototype, 'title', {
    get() { return origTitle.get.call(this); },
    set(v) { origTitle.set.call(this, prefix + v); },
    configurable: true,
    enumerable: true,
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!document.title.startsWith(prefix)) {
        origTitle.set.call(document, prefix + origTitle.get.call(document));
      }
    }, { once: true });
  } else {
    if (!document.title.startsWith(prefix)) {
      origTitle.set.call(document, prefix + origTitle.get.call(document));
    }
  }
})();
`;

  const backgroundJs = `'use strict';
(() => {
  const credentials = ${JSON.stringify(proxy ? {
    username: proxy.username,
    password: proxy.password,
  } : null)};

  if (!credentials || (!credentials.username && !credentials.password)) {
    return;
  }

  const seenRequests = new Set();

  function clearRequest(details) {
    seenRequests.delete(details.requestId);
  }

  chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (!details.isProxy) {
        callback({});
        return;
      }

      if (seenRequests.has(details.requestId)) {
        callback({});
        return;
      }

      seenRequests.add(details.requestId);
      callback({
        authCredentials: {
          username: credentials.username,
          password: credentials.password,
        },
      });
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking'],
  );

  chrome.webRequest.onCompleted.addListener(clearRequest, { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener(clearRequest, { urls: ['<all_urls>'] });
})();
`;

  await writeFile(join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(extDir, "inject.js"), injectJs);
  if (shouldHandleProxyAuth) {
    await writeFile(join(extDir, "background.js"), backgroundJs);
  }

  return extDir;
}
