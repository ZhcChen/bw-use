import { expect, test } from "bun:test";
import { getDataPaths } from "../src/paths";

test("uses default data directory when no env override is set", () => {
  const paths = getDataPaths({});

  expect(paths.dataDir.endsWith("/data")).toBe(true);
  expect(paths.profilesDir.endsWith("/data/profiles")).toBe(true);
  expect(paths.dbPath.endsWith("/data/browsers.db")).toBe(true);
});

test("uses BW_USE_DATA_DIR when provided", () => {
  const paths = getDataPaths({ BW_USE_DATA_DIR: "/tmp/bw-use-test" });

  expect(paths.dataDir).toBe("/tmp/bw-use-test");
  expect(paths.profilesDir).toBe("/tmp/bw-use-test/profiles");
  expect(paths.dbPath).toBe("/tmp/bw-use-test/browsers.db");
});
