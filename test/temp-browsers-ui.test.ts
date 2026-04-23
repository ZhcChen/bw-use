import { afterEach, expect, test } from "bun:test";
import { join } from "path";

const TEMP_BROWSERS_SCRIPT = await Bun.file(join(import.meta.dir, "..", "public", "temp-browsers.js")).text();
const originalDocument = (globalThis as Record<string, unknown>).document;
const originalWindow = (globalThis as Record<string, unknown>).window;
const originalFetch = (globalThis as Record<string, unknown>).fetch;

interface MockElement {
  addEventListener(type: string, listener: () => void): void;
  click(): void;
  disabled: boolean;
  hidden: boolean;
  className: string;
  textContent: string;
  title: string;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
}

function createMockElement(initialText = ""): MockElement {
  const listeners = new Map<string, Array<() => void>>();
  const classes = new Set<string>();
  const el: MockElement = {
    disabled: false,
    hidden: false,
    className: "",
    textContent: initialText,
    title: "",
    addEventListener(type: string, listener: () => void) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    click() {
      if (this.disabled) return;
      for (const listener of listeners.get("click") || []) listener();
    },
    classList: {
      add(name: string) { classes.add(name); },
      remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
    },
  };
  return el;
}

function createMockDom() {
  const elements = {
    "temp-browser-count": createMockElement(),
    "btn-create-temp-browser": createMockElement("创建临时浏览器"),
    "btn-close-temp-browsers": createMockElement("一键关闭临时浏览器"),
    "temp-browser-toast": createMockElement(),
    "temp-browser-toast-spinner": createMockElement(),
    "temp-browser-toast-message": createMockElement(),
    "temp-browser-toast-close": createMockElement("关闭"),
  };
  elements["temp-browser-toast"].hidden = true;
  elements["temp-browser-toast-spinner"].hidden = true;
  elements["temp-browser-toast-close"].hidden = true;
  return {
    elements,
    document: {
      getElementById(id: string) {
        return elements[id as keyof typeof elements] || null;
      },
    },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Bun.sleep(0);
  await Promise.resolve();
}

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = originalDocument;
  if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = originalWindow;
  if (originalFetch === undefined) delete (globalThis as Record<string, unknown>).fetch;
  else (globalThis as Record<string, unknown>).fetch = originalFetch;
});

test("未安装 Chrome 时 count 显示未安装提示，创建按钮 disabled，点击打开下载页", async () => {
  const calls: string[] = [];
  const opens: string[] = [];
  const { elements, document } = createMockDom();

  (globalThis as Record<string, unknown>).document = document;
  (globalThis as Record<string, unknown>).window = {
    open(url: string) { opens.push(url); },
    confirm() { return true; },
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    clearInterval() {},
  };
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/temp-browsers/setup") {
      return new Response(JSON.stringify({ installed: false }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  new Function(TEMP_BROWSERS_SCRIPT)();
  await flushAsync();
  await flushAsync();

  expect(calls).toEqual(["GET /api/temp-browsers/setup"]);
  expect(elements["temp-browser-count"].textContent).toContain("未安装 Chrome");
  expect(elements["temp-browser-count"].classList.contains("vs-count--error")).toBe(true);
  expect(elements["btn-create-temp-browser"].disabled).toBe(true);
  expect(elements["btn-close-temp-browsers"].disabled).toBe(true);

  elements["btn-create-temp-browser"].disabled = false; // mock 直接触发 click
  elements["btn-create-temp-browser"].click();
  await flushAsync();
  expect(opens).toContain("https://www.google.com/chrome/");
});

test("已安装 Chrome 时点击创建按钮会 POST 创建并刷新计数", async () => {
  const calls: string[] = [];
  const { elements, document } = createMockDom();

  let listCallCount = 0;

  (globalThis as Record<string, unknown>).document = document;
  (globalThis as Record<string, unknown>).window = {
    open() {},
    confirm() { return true; },
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    clearInterval() {},
  };
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/temp-browsers/setup") {
      return new Response(JSON.stringify({ installed: true, path: "/fake/chrome" }), { status: 200 });
    }
    if (url === "/api/temp-browsers" && method === "GET") {
      listCallCount += 1;
      return new Response(JSON.stringify({ count: listCallCount === 1 ? 0 : 1, items: [] }), { status: 200 });
    }
    if (url === "/api/temp-browsers" && method === "POST") {
      return new Response(JSON.stringify({ id: "t1", createdAt: "2026-04-17T00:00:00.000Z", running: true, pid: 1 }), { status: 201 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  new Function(TEMP_BROWSERS_SCRIPT)();
  await flushAsync();
  await flushAsync();

  expect(elements["temp-browser-count"].textContent).toBe("临时浏览器：0 个");
  expect(elements["btn-create-temp-browser"].disabled).toBe(false);

  elements["btn-create-temp-browser"].click();
  await flushAsync();
  await flushAsync();

  expect(calls).toEqual([
    "GET /api/temp-browsers/setup",
    "GET /api/temp-browsers",
    "POST /api/temp-browsers",
    "GET /api/temp-browsers",
  ]);
  expect(elements["temp-browser-count"].textContent).toBe("临时浏览器：1 个");
  expect(elements["btn-close-temp-browsers"].disabled).toBe(false);
});

test("一键关闭临时浏览器调用 DELETE 并显示成功文案", async () => {
  const calls: string[] = [];
  const { elements, document } = createMockDom();

  (globalThis as Record<string, unknown>).document = document;
  (globalThis as Record<string, unknown>).window = {
    open() {},
    confirm() { return true; },
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    clearInterval() {},
  };
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/temp-browsers/setup") {
      return new Response(JSON.stringify({ installed: true }), { status: 200 });
    }
    if (url === "/api/temp-browsers" && method === "GET") {
      const count = calls.filter((c) => c === "DELETE /api/temp-browsers").length > 0 ? 0 : 2;
      return new Response(JSON.stringify({ count, items: [] }), { status: 200 });
    }
    if (url === "/api/temp-browsers" && method === "DELETE") {
      return new Response(JSON.stringify({ closedCount: 2, failedIds: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  new Function(TEMP_BROWSERS_SCRIPT)();
  await flushAsync();
  await flushAsync();

  expect(elements["btn-close-temp-browsers"].disabled).toBe(false);
  elements["btn-close-temp-browsers"].click();
  await flushAsync();
  await flushAsync();

  expect(calls).toContain("DELETE /api/temp-browsers");
  expect(elements["temp-browser-toast-message"].textContent).toContain("已关闭并清理 2");
  expect(elements["temp-browser-count"].textContent).toBe("临时浏览器：0 个");
});
