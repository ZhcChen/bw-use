import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildAppBundle, getBundleId } from "../src/app-builder";
import { initLogger } from "../src/logger";

test("buildAppBundle 使用稳定 app 路径并更新显示名称", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "bw-use-app-builder-"));
  const db = new Database(":memory:");
  initLogger(db);
  const browserId = "a1b2c3d4-browser";

  try {
    const appPath1 = await buildAppBundle(rootDir, "测试浏览器A", browserId, [
      "--user-data-dir=/tmp/profile-a",
      "--lang=zh-CN",
    ]);
    const appPath2 = await buildAppBundle(rootDir, "测试浏览器B", browserId, [
      "--user-data-dir=/tmp/profile-a",
      "--lang=en-US",
    ]);

    expect(appPath1).toBe(join(rootDir, "Browser.app"));
    expect(appPath2).toBe(appPath1);

    const plist = await readFile(join(appPath2, "Contents", "Info.plist"), "utf-8");
    const launchScript = await readFile(join(appPath2, "Contents", "MacOS", "launch"), "utf-8");
    const iconLabel = await readFile(join(appPath2, "Contents", "Resources", ".icon-label"), "utf-8");

    expect(plist).toContain(getBundleId(browserId));
    expect(plist).toContain("<string>测试浏览器B</string>");
    expect(launchScript).toContain("--user-data-dir=/tmp/profile-a");
    expect(launchScript).toContain("--lang=en-US");
    expect(iconLabel.trim()).toBe("A1B2");
  } finally {
    db.close(false);
    await rm(rootDir, { recursive: true, force: true });
  }
});
