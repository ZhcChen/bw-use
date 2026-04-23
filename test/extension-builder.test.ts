import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import { buildExtension } from "../src/extension-builder";
import { generateFingerprint } from "../src/fingerprint";

test("带代理账号密码时会生成可重试的代理认证脚本", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "bw-use-ext-builder-"));

  try {
    const extDir = await buildExtension(
      rootDir,
      generateFingerprint(),
      "Proxy Browser",
      {
        host: "127.0.0.1",
        port: 8080,
        username: "user-a",
        password: "pass-b",
      },
    );

    const manifest = await readFile(join(extDir, "manifest.json"), "utf-8");
    const background = await readFile(join(extDir, "background.js"), "utf-8");

    expect(manifest).toContain("webRequestAuthProvider");
    expect(background).toContain("MAX_PROXY_AUTH_ATTEMPTS = 5");
    expect(background).toContain("attemptCounts");
    expect(background).toContain("details.challenger.host !== credentials.host");
    expect(background).toContain("authCredentials");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
