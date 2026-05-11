import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { migrate } from "./migrations.js";

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (db) return db;
  const configuredPath = process.env.OBSIDIANLINK_DB_PATH || config.OBSIDIANLINK_DB_PATH;
  const dbPath = process.env.NODE_ENV === "test" && !process.env.OBSIDIANLINK_DB_PATH ? ":memory:" : configuredPath;
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function databaseStatus() {
  try {
    const database = getDb();
    database.prepare("SELECT 1 AS ok").get();
    return { ok: true, path: process.env.NODE_ENV === "test" && !process.env.OBSIDIANLINK_DB_PATH ? ":memory:" : config.OBSIDIANLINK_DB_PATH };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
