import { connect, createServer, type Server, type Socket } from "net";
import { log } from "./logger";
import { summarizeProxy, type ProxyConfig } from "./proxy";

const LOCAL_PROXY_HOST = "127.0.0.1";
const HEADER_SEPARATOR = "\r\n\r\n";
const MAX_HEADER_BYTES = 64 * 1024;

interface ProxyBridgeState {
  port: number;
  proxy: ProxyConfig;
  server: Server;
  sockets: Set<Socket>;
}

export interface ProxyBridgeEndpoint {
  host: string;
  port: number;
}

const bridges = new Map<string, ProxyBridgeState>();

export async function ensureProxyBridge(key: string, proxy: ProxyConfig): Promise<ProxyBridgeEndpoint> {
  const existing = bridges.get(key);
  if (existing) {
    return { host: LOCAL_PROXY_HOST, port: existing.port };
  }

  const sockets = new Set<Socket>();
  const server = createServer((clientSocket) => {
    clientSocket.setNoDelay(true);
    registerSocket(sockets, clientSocket);
    handleClientSocket(clientSocket, proxy, sockets).catch((error: unknown) => {
      log("warn", "proxy-bridge", "Proxy bridge client handling failed", String(error));
      clientSocket.destroy();
    });
  });

  server.on("error", (error) => {
    log("error", "proxy-bridge", "Proxy bridge server error", String(error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCAL_PROXY_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind local proxy bridge");
  }

  bridges.set(key, {
    port: address.port,
    proxy,
    server,
    sockets,
  });

  log(
    "info",
    "proxy-bridge",
    "Started local proxy bridge",
    `${key} -> ${LOCAL_PROXY_HOST}:${address.port} -> ${summarizeProxy(proxy)}`,
  );

  return { host: LOCAL_PROXY_HOST, port: address.port };
}

export async function stopProxyBridge(key: string): Promise<void> {
  const state = bridges.get(key);
  if (!state) {
    return;
  }

  bridges.delete(key);

  for (const socket of state.sockets) {
    socket.destroy();
  }

  await new Promise<void>((resolve) => {
    state.server.close(() => resolve());
  });

  log(
    "info",
    "proxy-bridge",
    "Stopped local proxy bridge",
    `${key} -> ${LOCAL_PROXY_HOST}:${state.port} -> ${summarizeProxy(state.proxy)}`,
  );
}

async function handleClientSocket(clientSocket: Socket, proxy: ProxyConfig, sockets: Set<Socket>) {
  const { headerBuffer, initialBody } = await readRequestHead(clientSocket);
  const headerText = headerBuffer.toString("latin1");
  const requestLine = headerText.split("\r\n", 1)[0] || "";

  if (/^CONNECT\s+/i.test(requestLine)) {
    await handleConnectTunnel(clientSocket, proxy, requestLine, initialBody, sockets);
    return;
  }

  await handleHttpProxyRequest(clientSocket, proxy, headerText, initialBody, sockets);
}

async function handleConnectTunnel(
  clientSocket: Socket,
  proxy: ProxyConfig,
  requestLine: string,
  initialBody: Buffer,
  sockets: Set<Socket>,
) {
  const targetAuthority = requestLine.trim().split(/\s+/)[1];
  if (!targetAuthority) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }

  const upstreamSocket = connect(proxy.port, proxy.host);
  upstreamSocket.setNoDelay(true);
  registerSocket(sockets, upstreamSocket);

  await onceConnected(upstreamSocket);

  const connectRequest = [
    `CONNECT ${targetAuthority} HTTP/1.1`,
    `Host: ${targetAuthority}`,
    `Proxy-Authorization: ${buildProxyAuthorization(proxy)}`,
    "Proxy-Connection: Keep-Alive",
    "Connection: Keep-Alive",
    "",
    "",
  ].join("\r\n");
  upstreamSocket.write(connectRequest);

  const { headerBuffer, initialBody: upstreamInitialBody } = await readResponseHead(upstreamSocket);
  const statusLine = headerBuffer.toString("latin1").split("\r\n", 1)[0] || "";
  if (!/^HTTP\/1\.[01]\s+200\b/.test(statusLine)) {
    clientSocket.end(Buffer.concat([headerBuffer, upstreamInitialBody]));
    upstreamSocket.destroy();
    return;
  }

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (upstreamInitialBody.length > 0) {
    clientSocket.write(upstreamInitialBody);
  }
  if (initialBody.length > 0) {
    upstreamSocket.write(initialBody);
  }

  pipeSockets(clientSocket, upstreamSocket);
}

async function handleHttpProxyRequest(
  clientSocket: Socket,
  proxy: ProxyConfig,
  headerText: string,
  initialBody: Buffer,
  sockets: Set<Socket>,
) {
  const upstreamSocket = connect(proxy.port, proxy.host);
  upstreamSocket.setNoDelay(true);
  registerSocket(sockets, upstreamSocket);

  await onceConnected(upstreamSocket);

  upstreamSocket.write(rewriteHttpProxyRequest(headerText, proxy));
  if (initialBody.length > 0) {
    upstreamSocket.write(initialBody);
  }

  pipeSockets(clientSocket, upstreamSocket);
}

function rewriteHttpProxyRequest(headerText: string, proxy: ProxyConfig) {
  const lines = headerText.split("\r\n");
  const requestLine = lines.shift() || "";
  const filteredHeaders = lines.filter((line) => {
    if (!line) {
      return false;
    }
    return !/^proxy-authorization:/i.test(line);
  });

  filteredHeaders.push(`Proxy-Authorization: ${buildProxyAuthorization(proxy)}`);
  return Buffer.from([requestLine, ...filteredHeaders, "", ""].join("\r\n"), "latin1");
}

function buildProxyAuthorization(proxy: ProxyConfig) {
  const token = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
  return `Basic ${token}`;
}

async function readRequestHead(socket: Socket) {
  return readHead(socket);
}

async function readResponseHead(socket: Socket) {
  return readHead(socket);
}

async function readHead(socket: Socket) {
  let buffer = Buffer.alloc(0);

  while (buffer.length <= MAX_HEADER_BYTES) {
    const chunk = await readNextChunk(socket);
    if (chunk.length === 0) {
      break;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const separatorIndex = buffer.indexOf(HEADER_SEPARATOR);
    if (separatorIndex >= 0) {
      const headEnd = separatorIndex + HEADER_SEPARATOR.length;
      return {
        headerBuffer: buffer.subarray(0, headEnd),
        initialBody: buffer.subarray(headEnd),
      };
    }
  }

  throw new Error("Proxy bridge header exceeded maximum size or stream closed unexpectedly");
}

function readNextChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };

    const onData = (chunk: Buffer) => {
      cleanup();
      socket.pause();
      resolve(chunk);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.alloc(0));
    };
    const onClose = () => {
      cleanup();
      resolve(Buffer.alloc(0));
    };

    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    socket.resume();
  });
}

function pipeSockets(clientSocket: Socket, upstreamSocket: Socket) {
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);

  const closeBoth = () => {
    if (!clientSocket.destroyed) {
      clientSocket.destroy();
    }
    if (!upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
  };

  clientSocket.once("error", closeBoth);
  upstreamSocket.once("error", closeBoth);
  clientSocket.once("close", () => {
    if (!upstreamSocket.destroyed) {
      upstreamSocket.destroy();
    }
  });
  upstreamSocket.once("close", () => {
    if (!clientSocket.destroyed) {
      clientSocket.destroy();
    }
  });

  clientSocket.resume();
  upstreamSocket.resume();
}

function registerSocket(sockets: Set<Socket>, socket: Socket) {
  sockets.add(socket);
  socket.once("close", () => {
    sockets.delete(socket);
  });
}

function onceConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((socket as Socket & { connecting?: boolean }).connecting === false) {
      resolve();
      return;
    }

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };

    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}
