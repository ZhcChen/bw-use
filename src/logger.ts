import { Database } from "bun:sqlite";

let db: Database;

export type LogLevel = "info" | "warn" | "error";

export function initLogger(database: Database) {
  db = database;
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    )
  `);
}

export function log(level: LogLevel, source: string, message: string, detail?: string) {
  const now = new Date().toISOString();
  const prefix = { info: "INFO", warn: "WARN", error: "ERROR" }[level];
  console.log(`[${prefix}] [${source}] ${message}${detail ? " | " + detail : ""}`);
  db.run(
    "INSERT INTO logs (level, source, message, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    [level, source, message, detail ?? null, now]
  );
}

export interface LogEntry {
  id: number;
  level: string;
  source: string;
  message: string;
  detail: string | null;
  createdAt: string;
}

export function getLogs(limit = 100, level?: string): LogEntry[] {
  let sql = "SELECT id, level, source, message, detail, created_at FROM logs";
  const params: any[] = [];
  if (level) {
    sql += " WHERE level = ?";
    params.push(level);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  return db.query(sql).all(...params).map((r: any) => ({
    id: r.id,
    level: r.level,
    source: r.source,
    message: r.message,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

export function clearLogs() {
  db.run("DELETE FROM logs");
}
