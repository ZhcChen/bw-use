import { join } from "path";
import { mkdir } from "fs/promises";
import { Database } from "bun:sqlite";
import { initLogger } from "./logger";
import { getDataPaths, type DataPaths } from "./paths";
import { normalizeProxyConfig, type ProxyConfig } from "./proxy";

export interface Fingerprint {
  userAgent: string;
  platform: string;
  screenWidth: number;
  screenHeight: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  // Extended
  timezone: string;
  timezoneOffset: number;
  devicePixelRatio: number;
  maxTouchPoints: number;
  doNotTrack: string;
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
  webrtcPolicy: "default" | "disable" | "public_only";
  connectionType: string;
  connectionDownlink: number;
  connectionRtt: number;
  mediaDevices: { audioinput: number; videoinput: number; audiooutput: number };
  fonts: string[];
}

export interface BrowserInstance {
  id: string;
  name: string;
  groupId: string | null;
  fingerprint: Fingerprint;
  proxy: ProxyConfig | null;
  enableCustomIcon: boolean;
  disableCors: boolean;
  language: string;
  status: "running" | "stopped";
  pid: number | null;
  createdAt: string;
}

export interface Group {
  id: string;
  name: string;
  createdAt: string;
}

export interface TempBrowser {
  id: string;
  launcherPid: number;
  instanceDir: string;
  profileDir: string;
  createdAt: string;
}

export interface SavedProxy {
  id: string;
  name: string;
  proxy: ProxyConfig;
  createdAt: string;
}

let db: Database;
let dbPath: string | null = null;
let currentPaths: DataPaths = getDataPaths();

function initializeDb(databasePath: string) {
  if (dbPath === databasePath && db) {
    return;
  }

  if (db) {
    db.close(false);
  }

  db = new Database(databasePath);
  dbPath = databasePath;
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS browsers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      group_id TEXT,
      fingerprint TEXT NOT NULL,
      proxy TEXT,
      enable_custom_icon INTEGER DEFAULT 0,
      disable_cors INTEGER DEFAULT 0,
      language TEXT DEFAULT 'zh-CN',
      status TEXT DEFAULT 'stopped',
      pid INTEGER,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS temp_browsers (
      id TEXT PRIMARY KEY,
      launcher_pid INTEGER NOT NULL,
      instance_dir TEXT NOT NULL,
      profile_dir TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS saved_proxies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      proxy TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // Migration: add group_id column if missing
  try { db.run("ALTER TABLE browsers ADD COLUMN group_id TEXT"); } catch {}
  try { db.run("ALTER TABLE browsers ADD COLUMN proxy TEXT"); } catch {}
  try { db.run("ALTER TABLE browsers ADD COLUMN enable_custom_icon INTEGER DEFAULT 0"); } catch {}
  initLogger(db);
}

// ensureDirs also refreshes the store's active path state and rebinds DB/logger
// when the resolved database path changes.
export async function ensureDirs() {
  currentPaths = getDataPaths();
  const { dataDir, profilesDir, dbPath: currentDbPath, tempChromeDir } = currentPaths;

  await mkdir(dataDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });
  await mkdir(tempChromeDir, { recursive: true });

  initializeDb(currentDbPath);
}

function rowToInstance(row: any): BrowserInstance {
  let proxy: ProxyConfig | null = null;
  try {
    proxy = normalizeProxyConfig(row.proxy ? JSON.parse(row.proxy) : null);
  } catch {
    proxy = null;
  }

  return {
    id: row.id,
    name: row.name,
    groupId: row.group_id || null,
    fingerprint: JSON.parse(row.fingerprint),
    proxy,
    enableCustomIcon: !!row.enable_custom_icon,
    disableCors: !!row.disable_cors,
    language: row.language,
    status: row.status,
    pid: row.pid,
    createdAt: row.created_at,
  };
}

export function loadBrowsers(): BrowserInstance[] {
  const rows = db.query("SELECT * FROM browsers ORDER BY created_at ASC").all();
  return rows.map(rowToInstance);
}

export function getBrowser(id: string): BrowserInstance | null {
  const row = db.query("SELECT * FROM browsers WHERE id = ?").get(id);
  return row ? rowToInstance(row) : null;
}

export function insertBrowser(b: BrowserInstance) {
  db.run(
    "INSERT INTO browsers (id, name, group_id, fingerprint, proxy, enable_custom_icon, disable_cors, language, status, pid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      b.id,
      b.name,
      b.groupId,
      JSON.stringify(b.fingerprint),
      b.proxy ? JSON.stringify(b.proxy) : null,
      b.enableCustomIcon ? 1 : 0,
      b.disableCors ? 1 : 0,
      b.language,
      b.status,
      b.pid,
      b.createdAt,
    ]
  );
}

export function updateBrowser(instance: BrowserInstance) {
  db.run(
    "UPDATE browsers SET name = ?, group_id = ?, fingerprint = ?, proxy = ?, enable_custom_icon = ?, disable_cors = ?, language = ? WHERE id = ?",
    [
      instance.name,
      instance.groupId,
      JSON.stringify(instance.fingerprint),
      instance.proxy ? JSON.stringify(instance.proxy) : null,
      instance.enableCustomIcon ? 1 : 0,
      instance.disableCors ? 1 : 0,
      instance.language,
      instance.id,
    ],
  );
}

export function updateBrowserGroup(id: string, groupId: string | null) {
  db.run("UPDATE browsers SET group_id = ? WHERE id = ?", [groupId, id]);
}

export function updateBrowserStatus(id: string, status: string, pid: number | null) {
  db.run("UPDATE browsers SET status = ?, pid = ? WHERE id = ?", [status, pid, id]);
}

export function removeBrowser(id: string) {
  db.run("DELETE FROM browsers WHERE id = ?", [id]);
}

export function getProfileDir(id: string) {
  return join(currentPaths.profilesDir, id);
}

// Reset all running browsers to stopped on startup
export function syncStatus() {
  db.run("UPDATE browsers SET status = 'stopped', pid = NULL WHERE status = 'running'");
}

// ---- Groups ----
export function loadGroups(): Group[] {
  return db.query("SELECT * FROM groups ORDER BY created_at ASC").all().map((r: any) => ({
    id: r.id, name: r.name, createdAt: r.created_at,
  }));
}

export function loadTempBrowsers(): TempBrowser[] {
  return db.query("SELECT * FROM temp_browsers ORDER BY created_at ASC").all().map((row: any) => ({
    id: row.id,
    launcherPid: row.launcher_pid,
    instanceDir: row.instance_dir,
    profileDir: row.profile_dir,
    createdAt: row.created_at,
  }));
}

export function insertTempBrowser(browser: TempBrowser) {
  db.run(
    "INSERT INTO temp_browsers (id, launcher_pid, instance_dir, profile_dir, created_at) VALUES (?, ?, ?, ?, ?)",
    [browser.id, browser.launcherPid, browser.instanceDir, browser.profileDir, browser.createdAt],
  );
}

export function removeTempBrowser(id: string) {
  db.run("DELETE FROM temp_browsers WHERE id = ?", [id]);
}

export function clearTempBrowsers() {
  db.run("DELETE FROM temp_browsers");
}

function rowToSavedProxy(row: any): SavedProxy | null {
  try {
    const proxy = normalizeProxyConfig(JSON.parse(row.proxy));
    if (!proxy) {
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      proxy,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

export function loadSavedProxies(): SavedProxy[] {
  return db.query("SELECT * FROM saved_proxies ORDER BY created_at ASC").all()
    .map(rowToSavedProxy)
    .filter((item): item is SavedProxy => item !== null);
}

export function getSavedProxy(id: string): SavedProxy | null {
  const row = db.query("SELECT * FROM saved_proxies WHERE id = ?").get(id);
  return row ? rowToSavedProxy(row) : null;
}

export function insertSavedProxy(savedProxy: SavedProxy) {
  db.run(
    "INSERT INTO saved_proxies (id, name, proxy, created_at) VALUES (?, ?, ?, ?)",
    [savedProxy.id, savedProxy.name, JSON.stringify(savedProxy.proxy), savedProxy.createdAt],
  );
}

export function updateSavedProxy(savedProxy: SavedProxy) {
  db.run(
    "UPDATE saved_proxies SET name = ?, proxy = ? WHERE id = ?",
    [savedProxy.name, JSON.stringify(savedProxy.proxy), savedProxy.id],
  );
}

export function removeSavedProxy(id: string) {
  db.run("DELETE FROM saved_proxies WHERE id = ?", [id]);
}

export function insertGroup(g: Group) {
  db.run("INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)", [g.id, g.name, g.createdAt]);
}

export function renameGroup(id: string, name: string) {
  db.run("UPDATE groups SET name = ? WHERE id = ?", [name, id]);
}

export function removeGroup(id: string) {
  // Unlink browsers from this group
  db.run("UPDATE browsers SET group_id = NULL WHERE group_id = ?", [id]);
  db.run("DELETE FROM groups WHERE id = ?", [id]);
}
