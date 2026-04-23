import { mkdtemp, rm } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";

async function withIsolatedEnv<T>(
  label: string,
  run: (ctx: { rootDir: string; dataDir: string }) => Promise<T>,
) {
  const rootDir = await mkdtemp(join(tmpdir(), `bw-use-proxy-library-${label}-`));
  const dataDir = join(rootDir, "data");
  const originalDataDir = process.env.BW_USE_DATA_DIR;

  process.env.BW_USE_DATA_DIR = dataDir;

  try {
    return await run({ rootDir, dataDir });
  } finally {
    if (originalDataDir === undefined) delete process.env.BW_USE_DATA_DIR;
    else process.env.BW_USE_DATA_DIR = originalDataDir;
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function findFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve free port"));
        return;
      }
      const { port } = address;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(port);
      });
    });
  });
}

async function waitForServerReady(baseUrl: string, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/browsers`);
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for server at ${baseUrl}`);
}

async function stopServer(proc: ReturnType<typeof Bun.spawn>) {
  try {
    proc.kill("SIGTERM");
  } catch {}

  const exited = await Promise.race([
    proc.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (exited) return;

  try {
    proc.kill("SIGKILL");
  } catch {}
  await Promise.race([proc.exited, Bun.sleep(2_000)]);
}

async function startServerForTest(env: Record<string, string>) {
  const port = await findFreePort();
  const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ...env, BW_USE_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServerReady(baseUrl);
  } catch (error) {
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    const stdout = await new Response(proc.stdout).text().catch(() => "");
    await stopServer(proc);
    throw new Error(`${(error as Error).message}\nstderr: ${stderr.slice(-500)}\nstdout: ${stdout.slice(-500)}`);
  }
  return { proc, baseUrl };
}

test("saved proxy API 支持创建、更新、删除与列表查询", async () => {
  await withIsolatedEnv("crud", async ({ dataDir }) => {
    const server = await startServerForTest({ BW_USE_DATA_DIR: dataDir });

    try {
      const createResponse = await fetch(`${server.baseUrl}/api/proxies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "住宅代理 A",
          proxy: {
            host: "69.33.201.28",
            port: 5782,
            username: "j5dy5c20",
            password: "W9Q9D37wBoVS",
          },
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as {
        id: string;
        name: string;
        proxy: { host: string; port: number; username: string; password: string };
      };
      expect(created.name).toBe("住宅代理 A");
      expect(created.proxy.host).toBe("69.33.201.28");

      const listResponse = await fetch(`${server.baseUrl}/api/proxies`);
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json() as Array<{ id: string; name: string }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(created.id);

      const updateResponse = await fetch(`${server.baseUrl}/api/proxies/${created.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "住宅代理 B",
          proxy: {
            host: "69.33.201.28",
            port: 5782,
            username: "updated-user",
            password: "updated-pass",
          },
        }),
      });
      expect(updateResponse.status).toBe(200);
      const updated = await updateResponse.json() as {
        name: string;
        proxy: { username: string; password: string };
      };
      expect(updated.name).toBe("住宅代理 B");
      expect(updated.proxy.username).toBe("updated-user");

      const deleteResponse = await fetch(`${server.baseUrl}/api/proxies/${created.id}`, {
        method: "DELETE",
      });
      expect(deleteResponse.status).toBe(200);

      const emptyListResponse = await fetch(`${server.baseUrl}/api/proxies`);
      expect(emptyListResponse.status).toBe(200);
      expect(await emptyListResponse.json()).toEqual([]);
    } finally {
      await stopServer(server.proc);
    }
  });
});
