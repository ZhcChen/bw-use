export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

interface ProxyInput {
  host: string;
  port: string;
  username: string;
  password: string;
}

function toTrimmedString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

export function parseProxyString(value: string): ProxyInput {
  const raw = value.trim();
  if (!raw) {
    return { host: "", port: "", username: "", password: "" };
  }

  const parts = raw.split(":");
  return {
    host: parts[0]?.trim() ?? "",
    port: parts[1]?.trim() ?? "",
    username: parts[2]?.trim() ?? "",
    password: parts.slice(3).join(":").trim(),
  };
}

export function normalizeProxyConfig(value: unknown): ProxyConfig | null {
  if (value == null || value === false) {
    return null;
  }

  let input: ProxyInput;
  if (typeof value === "string") {
    input = parseProxyString(value);
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    input = {
      host: toTrimmedString(record.host),
      port: toTrimmedString(record.port),
      username: toTrimmedString(record.username),
      password: toTrimmedString(record.password),
    };
  } else {
    return null;
  }

  const { host, port, username, password } = input;
  if (!host && !port && !username && !password) {
    return null;
  }

  if (!host) {
    throw new Error("代理 IP / 主机不能为空");
  }

  if (!port) {
    throw new Error("代理端口不能为空");
  }

  const parsedPort = Number.parseInt(port, 10);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error("代理端口必须是 1 到 65535 的整数");
  }

  return {
    host,
    port: parsedPort,
    username,
    password,
  };
}

export function formatProxyServer(proxy: ProxyConfig): string {
  return `http://${proxy.host}:${proxy.port}`;
}

export function summarizeProxy(proxy: ProxyConfig | null | undefined): string {
  if (!proxy) {
    return "direct";
  }
  if (proxy.username) {
    return `${proxy.host}:${proxy.port}@${proxy.username}`;
  }
  return `${proxy.host}:${proxy.port}`;
}
