import { log } from "./logger";
import { formatProxyServer, summarizeProxy, type ProxyConfig } from "./proxy";

const PROXY_TEST_URL = process.env.BW_USE_PROXY_TEST_URL || "https://api.ipify.org?format=json";
const CONNECT_TIMEOUT_SECONDS = "5";
const MAX_TIME_SECONDS = "12";

export interface ProxyTestResult {
  ok: true;
  target: string;
  summary: string;
  ip: string | null;
  response: string;
}

async function readProcessStream(stream: ReadableStream<Uint8Array> | number | undefined) {
  if (!(stream instanceof ReadableStream)) {
    return "";
  }
  return new Response(stream).text();
}

export async function testProxyConnection(proxy: ProxyConfig): Promise<ProxyTestResult> {
  const args = [
    "curl",
    "--silent",
    "--show-error",
    "--fail",
    "--location",
    "--connect-timeout",
    CONNECT_TIMEOUT_SECONDS,
    "--max-time",
    MAX_TIME_SECONDS,
    "--proxy",
    formatProxyServer(proxy),
  ];

  if (proxy.username || proxy.password) {
    args.push("--proxy-user", `${proxy.username}:${proxy.password}`);
  }

  args.push(PROXY_TEST_URL);

  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "inherit",
      env: process.env,
    });
  } catch (error: any) {
    throw new Error(error?.message || "无法启动代理测试命令");
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    readProcessStream(proc.stdout),
    readProcessStream(proc.stderr),
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `curl exit ${exitCode}`;
    log("warn", "proxy-test", "Proxy test failed", `${summarizeProxy(proxy)} | ${detail}`);
    throw new Error(`代理连通性测试失败：${detail}`);
  }

  const response = stdout.trim();
  let ip: string | null = null;

  try {
    const parsed = JSON.parse(response) as { ip?: unknown };
    if (typeof parsed.ip === "string" && parsed.ip.trim()) {
      ip = parsed.ip.trim();
    }
  } catch {}

  log("info", "proxy-test", "Proxy test succeeded", `${summarizeProxy(proxy)} -> ${ip || response || "ok"}`);

  return {
    ok: true,
    target: PROXY_TEST_URL,
    summary: summarizeProxy(proxy),
    ip,
    response,
  };
}
