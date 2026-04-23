import { join } from "path";
import { readFile } from "fs/promises";
import { ensureDirs, loadBrowsers, insertBrowser, updateBrowserGroup, syncStatus, loadGroups, insertGroup, renameGroup, removeGroup, getBrowser, updateBrowser, type BrowserInstance, type Group } from "./store";
import { generateFingerprint } from "./fingerprint";
import { launchBrowser, closeBrowser, deleteBrowser } from "./browser-manager";
import { getLogs, clearLogs, log } from "./logger";
import { normalizeProxyConfig } from "./proxy";
import { testProxyConnection } from "./proxy-tester";
import { recoverTempBrowsers } from "./temp-browser-manager";
import { handleTempBrowserApi } from "./temp-browser-api";

const PORT = Number(process.env.BW_USE_PORT || "20000");
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PACKAGE_JSON_PATH = join(import.meta.dir, "..", "package.json");

const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf-8")) as { version?: unknown };
const APP_VERSION =
  typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "0.0.0";

await ensureDirs();
await recoverTempBrowsers();
syncStatus();
log("info", "server", "Server starting", `port=${PORT}`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // API routes
    if (pathname.startsWith("/api/")) {
      return handleApi(req, pathname);
    }

    // Serve static files
    if (pathname === "/" || pathname === "/index.html") {
      const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf-8");
      return new Response(html.replaceAll("__APP_VERSION__", APP_VERSION), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Other static files
    try {
      const filePath = join(PUBLIC_DIR, pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    } catch {}

    return new Response("Not Found", { status: 404 });
  },
});

async function handleApi(req: Request, pathname: string): Promise<Response> {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const readBody = async (): Promise<Record<string, any>> => {
    const body = await req.json().catch(() => ({}));
    return (body && typeof body === "object") ? (body as Record<string, any>) : {};
  };

  try {
    const tempApiResponse = await handleTempBrowserApi(req, pathname);
    if (tempApiResponse) {
      return tempApiResponse;
    }

    // GET /api/browsers
    if (pathname === "/api/browsers" && req.method === "GET") {
      return json(loadBrowsers());
    }

    // POST /api/browsers
    if (pathname === "/api/browsers" && req.method === "POST") {
      const body = await readBody();
      const browsers = loadBrowsers();

      // Merge with random defaults for any missing fingerprint fields
      const defaultFp = generateFingerprint();
      const fp = body.fingerprint
        ? { ...defaultFp, ...body.fingerprint, fonts: (body.fingerprint.fonts && body.fingerprint.fonts.length > 0) ? body.fingerprint.fonts : defaultFp.fonts }
        : defaultFp;

      const instance: BrowserInstance = {
        id: crypto.randomUUID(),
        name: body.name || `Browser ${browsers.length + 1}`,
        fingerprint: fp,
        proxy: normalizeProxyConfig(body.proxy),
        enableCustomIcon: body.enableCustomIcon ?? false,
        disableCors: body.disableCors ?? false,
        language: body.language || "zh-CN",
        groupId: body.groupId || null,
        status: "stopped",
        pid: null,
        createdAt: new Date().toISOString(),
      };

      insertBrowser(instance);
      return json(instance, 201);
    }

    // GET /api/fingerprint/random
    if (pathname === "/api/fingerprint/random" && req.method === "GET") {
      return json(generateFingerprint());
    }

    // POST /api/proxy/test
    if (pathname === "/api/proxy/test" && req.method === "POST") {
      const body = await readBody();
      const proxy = normalizeProxyConfig(body.proxy);
      if (!proxy) {
        return json({ error: "请先填写代理配置" }, 400);
      }
      return json(await testProxyConnection(proxy));
    }

    // GET /api/logs
    if (pathname === "/api/logs" && req.method === "GET") {
      const level = new URL(req.url).searchParams.get("level") || undefined;
      return json(getLogs(200, level));
    }

    // DELETE /api/logs
    if (pathname === "/api/logs" && req.method === "DELETE") {
      clearLogs();
      return json({ ok: true });
    }

    // ---- Groups ----
    // GET /api/groups
    if (pathname === "/api/groups" && req.method === "GET") {
      return json(loadGroups());
    }

    // POST /api/groups
    if (pathname === "/api/groups" && req.method === "POST") {
      const body = await readBody();
      const group: Group = {
        id: crypto.randomUUID(),
        name: body.name || "新分组",
        createdAt: new Date().toISOString(),
      };
      insertGroup(group);
      return json(group, 201);
    }

    // Group routes with :id
    const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (groupMatch) {
      const gid = groupMatch[1]!;
      if (req.method === "PUT") {
        const body = await readBody();
        renameGroup(gid, body.name);
        return json({ ok: true });
      }
      if (req.method === "DELETE") {
        removeGroup(gid);
        return json({ ok: true });
      }
    }

    // Routes with :id
    const match = pathname.match(/^\/api\/browsers\/([^/]+)(\/.*)?$/);
    if (match) {
      const id = match[1]!;
      const action = match[2];

      // POST /api/browsers/:id/launch
      if (action === "/launch" && req.method === "POST") {
        const browser = await launchBrowser(id);
        return json(browser);
      }

      // POST /api/browsers/:id/close
      if (action === "/close" && req.method === "POST") {
        const browser = await closeBrowser(id);
        return json(browser);
      }

      // PUT /api/browsers/:id/group
      if (action === "/group" && req.method === "PUT") {
        const body = await readBody();
        updateBrowserGroup(id, body.groupId ?? null);
        return json({ ok: true });
      }

      // PUT /api/browsers/:id
      if (!action && req.method === "PUT") {
        const existing = getBrowser(id);
        if (!existing) {
          return json({ error: "Browser not found" }, 404);
        }

        const body = await readBody();
        const next: BrowserInstance = {
          ...existing,
          name: body.name || existing.name,
          fingerprint: body.fingerprint ? { ...existing.fingerprint, ...body.fingerprint } : existing.fingerprint,
          proxy: normalizeProxyConfig(body.proxy),
          enableCustomIcon: body.enableCustomIcon ?? existing.enableCustomIcon,
          disableCors: body.disableCors ?? existing.disableCors,
          language: body.language || existing.language,
          groupId: body.groupId ?? existing.groupId,
        };

        updateBrowser(next);
        return json(next);
      }

      // DELETE /api/browsers/:id
      if (!action && req.method === "DELETE") {
        await deleteBrowser(id);
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err: any) {
    return json({ error: err.message }, 400);
  }
}

console.log(`Browser Manager running at http://localhost:${PORT}`);
