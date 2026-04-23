import { connect, createServer as createNetServer, type Socket } from "net";
import { expect, test } from "bun:test";
import { ensureProxyBridge, stopProxyBridge } from "../src/proxy-bridge";

const AUTH_HEADER = `Basic ${Buffer.from("bridge-user:bridge-pass").toString("base64")}`;

function listen(server: { listen(port: number, host: string, cb?: () => void): void; address(): any }) {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      if ("off" in server) {
        (server as any).off("error", onError);
      }
    };
    if ("once" in server) {
      (server as any).once("error", onError);
    }
    server.listen(0, "127.0.0.1", () => {
      cleanup();
      resolve(server.address().port);
    });
  });
}

function closeServer(server: { close(cb?: () => void): void }) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

test("proxy bridge 会为 CONNECT 隧道补充 Proxy-Authorization", async () => {
  const targetServer = createNetServer((socket) => {
    socket.on("data", (chunk) => {
      socket.write(Buffer.concat([Buffer.from("echo:"), Buffer.from(chunk)]));
    });
  });
  const targetPort = await listen(targetServer);

  const upstreamAuthHeaders: string[] = [];
  const upstreamProxy = createNetServer((clientSocket) => {
    captureHead(clientSocket).then(async ({ headerText, initialBody }) => {
      const lines = headerText.split("\r\n").filter(Boolean);
      upstreamAuthHeaders.push(lines.find((line) => /^Proxy-Authorization:/i.test(line)) || "");
      const connectLine = lines[0] || "";
      const authority = connectLine.split(/\s+/)[1] || "";
      const [host, portText] = authority.split(":");
      const targetSocket = connect(Number(portText), host || "127.0.0.1");

      await onceConnected(targetSocket);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (initialBody.length > 0) {
        targetSocket.write(initialBody);
      }
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
      clientSocket.resume();
      targetSocket.resume();
    }).catch(() => {
      clientSocket.destroy();
    });
  });
  const upstreamPort = await listen(upstreamProxy);

  const bridgeKey = `test-connect-${crypto.randomUUID()}`;
  const bridge = await ensureProxyBridge(bridgeKey, {
    host: "127.0.0.1",
    port: upstreamPort,
    username: "bridge-user",
    password: "bridge-pass",
  });

  try {
    const clientSocket = connect(bridge.port, bridge.host);
    await onceConnected(clientSocket);

    clientSocket.write([
      `CONNECT 127.0.0.1:${targetPort} HTTP/1.1`,
      `Host: 127.0.0.1:${targetPort}`,
      "",
      "",
    ].join("\r\n"));

    const { headerText } = await captureHead(clientSocket);
    expect(headerText.startsWith("HTTP/1.1 200")).toBe(true);

    clientSocket.write("ping");
    const echoed = await readExact(clientSocket, 9);
    expect(echoed.toString()).toBe("echo:ping");
    expect(upstreamAuthHeaders[0]).toBe(`Proxy-Authorization: ${AUTH_HEADER}`);

    clientSocket.destroy();
  } finally {
    await stopProxyBridge(bridgeKey);
    await closeServer(upstreamProxy);
    await closeServer(targetServer);
  }
});

async function captureHead(socket: Socket) {
  let buffer = Buffer.alloc(0);
  while (true) {
    const chunk = await readNextChunk(socket);
    if (chunk.length === 0) {
      throw new Error("socket ended before header completed");
    }
    buffer = Buffer.concat([buffer, chunk]);
    const separatorIndex = buffer.indexOf("\r\n\r\n");
    if (separatorIndex >= 0) {
      const headEnd = separatorIndex + 4;
      return {
        headerText: buffer.subarray(0, headEnd).toString("latin1"),
        initialBody: buffer.subarray(headEnd),
      };
    }
  }
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

async function readExact(socket: Socket, size: number) {
  let buffer = Buffer.alloc(0);
  while (buffer.length < size) {
    const chunk = await readNextChunk(socket);
    if (chunk.length === 0) {
      throw new Error("socket ended before enough bytes were read");
    }
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer.subarray(0, size);
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
