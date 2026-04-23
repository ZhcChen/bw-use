import { closeAllTempBrowsers, createTempBrowser, isChromeInstalled, getChromeBinPath } from "./temp-browser-manager";
import { ensureDirs, loadTempBrowsers } from "./store";
import { normalizeProxyConfig } from "./proxy";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleTempBrowserApi(req: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/api/temp-browsers")) {
    return null;
  }

  await ensureDirs();

  if (pathname === "/api/temp-browsers/setup") {
    if (req.method !== "GET") {
      return json({ error: "Not found" }, 404);
    }

    return json({
      installed: await isChromeInstalled(process.env),
      path: getChromeBinPath(process.env),
    });
  }

  if (pathname !== "/api/temp-browsers") {
    return json({ error: "Not found" }, 404);
  }

  if (req.method === "GET") {
    const items = loadTempBrowsers().map(({ id, createdAt, launcherPid }) => ({
      id,
      createdAt,
      pid: launcherPid,
    }));
    return json({
      count: items.length,
      items,
    });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const browser = await createTempBrowser({
      proxy: normalizeProxyConfig((body as Record<string, unknown>).proxy),
    });
    return json({
      id: browser.id,
      createdAt: browser.createdAt,
      pid: browser.launcherPid,
      running: true,
    }, 201);
  }

  if (req.method === "DELETE") {
    return json(await closeAllTempBrowsers());
  }

  return json({ error: "Not found" }, 404);
}
