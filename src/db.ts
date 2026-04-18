import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// Ensure data directory exists
const dataDir = path.join(process.cwd(), "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Database file path
const dbPath = path.join(dataDir, "prepped.sqlite");

// Create database
export const db = new Database(dbPath);

// Basic settings
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
