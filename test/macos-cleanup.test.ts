import { expect, test } from "bun:test";
import { shouldRemoveDockEntry } from "../src/macos-cleanup";

test("shouldRemoveDockEntry 在 bundle identifier 命中时返回 true", () => {
  expect(
    shouldRemoveDockEntry(
      {
        bundleIdentifier: "com.bw-use.browser.1234",
      },
      "/tmp/Browser.app",
      "com.bw-use.browser.1234",
    ),
  ).toBe(true);
});

test("shouldRemoveDockEntry 在 file url 命中 appPath 时返回 true", () => {
  expect(
    shouldRemoveDockEntry(
      {
        url: "file:///Users/chen/Library/Application%20Support/bw-use/data/profiles/abc/Browser.app/",
      },
      "/Users/chen/Library/Application Support/bw-use/data/profiles/abc/Browser.app",
      "com.bw-use.browser.other",
    ),
  ).toBe(true);
});

test("shouldRemoveDockEntry 在 bundle identifier 和 appPath 都不命中时返回 false", () => {
  expect(
    shouldRemoveDockEntry(
      {
        url: "file:///Applications/Google%20Chrome.app",
        bundleIdentifier: "com.google.Chrome",
      },
      "/Users/chen/Library/Application Support/bw-use/data/profiles/abc/Browser.app",
      "com.bw-use.browser.abc",
    ),
  ).toBe(false);
});
