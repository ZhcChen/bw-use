import { access, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import { getDataPaths } from "../src/paths";

async function createIsolatedEnv(label: string) {
  const rootDir = await mkdtemp(join(tmpdir(), `bw-use-${label}-`));
  const dataDir = join(rootDir, "data");
  const tempChromeDir = join(rootDir, "temp-chrome");

  return {
    rootDir,
    env: {
      BW_USE_DATA_DIR: dataDir,
      BW_USE_TEMP_CHROME_DIR: tempChromeDir,
    },
    paths: getDataPaths({
      BW_USE_DATA_DIR: dataDir,
      BW_USE_TEMP_CHROME_DIR: tempChromeDir,
    }),
  };
}

async function expectPathExists(path: string) {
  const exists = await access(path).then(() => true, () => false);
  expect(exists).toBe(true);
}

test("resolves temp chrome root from env override", () => {
  const paths = getDataPaths({
    BW_USE_DATA_DIR: "/tmp/bw-use-data",
    BW_USE_TEMP_CHROME_DIR: "/tmp/bw-use-temp-chrome",
  });

  expect(paths.tempChromeDir).toBe("/tmp/bw-use-temp-chrome");
});

test("defaults temp chrome root under data dir when no override is set", () => {
  const paths = getDataPaths({
    BW_USE_DATA_DIR: "/tmp/bw-use-data",
  });

  expect(paths.tempChromeDir).toBe("/tmp/bw-use-data/temp-chrome");
});

test("ensureDirs follows current env and temp browser CRUD stays isolated per sqlite db", async () => {
  const originalDataDir = process.env.BW_USE_DATA_DIR;
  const originalTempDir = process.env.BW_USE_TEMP_CHROME_DIR;
  const first = await createIsolatedEnv("first");
  const second = await createIsolatedEnv("second");

  try {
    process.env.BW_USE_DATA_DIR = first.env.BW_USE_DATA_DIR;
    process.env.BW_USE_TEMP_CHROME_DIR = first.env.BW_USE_TEMP_CHROME_DIR;

    const store = await import(`../src/store.ts?temp-browser-store=${Date.now()}`);

    await store.ensureDirs();
    await expectPathExists(first.paths.dataDir);
    await expectPathExists(first.paths.profilesDir);
    await expectPathExists(first.paths.tempChromeDir);
    await expectPathExists(first.paths.dbPath);
    expect(store.getProfileDir("alpha")).toBe(join(first.paths.profilesDir, "alpha"));

    store.insertTempBrowser({
      id: "temp-1",
      launcherPid: 123,
      instanceDir: join(first.paths.tempChromeDir, "temp-1"),
      profileDir: join(first.paths.tempChromeDir, "temp-1", "profile"),
      createdAt: "2026-04-17T00:00:00.000Z",
    });
    store.insertTempBrowser({
      id: "temp-2",
      launcherPid: 456,
      instanceDir: join(first.paths.tempChromeDir, "temp-2"),
      profileDir: join(first.paths.tempChromeDir, "temp-2", "profile"),
      createdAt: "2026-04-17T00:00:01.000Z",
    });

    expect(store.loadTempBrowsers().map((item: any) => item.id)).toEqual(["temp-1", "temp-2"]);

    store.removeTempBrowser("temp-1");
    expect(store.loadTempBrowsers().map((item: any) => item.id)).toEqual(["temp-2"]);

    process.env.BW_USE_DATA_DIR = second.env.BW_USE_DATA_DIR;
    process.env.BW_USE_TEMP_CHROME_DIR = second.env.BW_USE_TEMP_CHROME_DIR;

    expect(store.getProfileDir("beta")).toBe(join(first.paths.profilesDir, "beta"));

    await store.ensureDirs();
    await expectPathExists(second.paths.dataDir);
    await expectPathExists(second.paths.profilesDir);
    await expectPathExists(second.paths.tempChromeDir);
    await expectPathExists(second.paths.dbPath);
    expect(store.getProfileDir("gamma")).toBe(join(second.paths.profilesDir, "gamma"));
    expect(store.loadTempBrowsers()).toEqual([]);

    store.insertTempBrowser({
      id: "temp-3",
      launcherPid: 789,
      instanceDir: join(second.paths.tempChromeDir, "temp-3"),
      profileDir: join(second.paths.tempChromeDir, "temp-3", "profile"),
      createdAt: "2026-04-17T00:00:02.000Z",
    });
    expect(store.loadTempBrowsers().map((item: any) => item.id)).toEqual(["temp-3"]);

    store.clearTempBrowsers();
    expect(store.loadTempBrowsers()).toEqual([]);
  } finally {
    if (originalDataDir === undefined) {
      delete process.env.BW_USE_DATA_DIR;
    } else {
      process.env.BW_USE_DATA_DIR = originalDataDir;
    }

    if (originalTempDir === undefined) {
      delete process.env.BW_USE_TEMP_CHROME_DIR;
    } else {
      process.env.BW_USE_TEMP_CHROME_DIR = originalTempDir;
    }

    await rm(first.rootDir, { recursive: true, force: true });
    await rm(second.rootDir, { recursive: true, force: true });
  }
});
