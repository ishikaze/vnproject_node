const Database = require('better-sqlite3');
const db = new Database('database.db');

// Enable foreign keys
db.pragma('foreign_keys = ON');

// 1. Create Basic Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        is_banned INTEGER DEFAULT 0,
        is_admin INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        title TEXT,
        description TEXT,
        is_published INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        title TEXT,
        episode_number INTEGER,
        draft_data TEXT,
        published_data TEXT,
        last_published_at DATETIME,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        project_id INTEGER,
        name TEXT,
        type TEXT,
        url TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- NEW: Settings Table for Global Flags
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// 2. Insert Default Settings if missing
const checkSettings = db.prepare("SELECT key FROM settings WHERE key = 'whitelist_mode'");
if (!checkSettings.get()) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('whitelist_mode', '0')").run();
}

// 3. MIGRATION HELPER (In case you ran the old DB, this adds columns without error)
try {
    db.prepare("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0").run();
} catch (e) { /* Column likely exists, ignore */ }

try {
    db.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0").run();
} catch (e) { /* Column likely exists, ignore */ }

module.exports = db;