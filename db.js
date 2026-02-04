const Database = require('better-sqlite3');
const db = new Database('database.db');

// Enable foreign keys
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        title TEXT,
        description TEXT,
        is_published INTEGER DEFAULT 0, -- If the SERIES itself is visible on landing
        cover_image TEXT DEFAULT '/images/default_cover.png',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        title TEXT,
        episode_number INTEGER,
        draft_data TEXT,      -- The JSON used in Editor (Work in Progress)
        published_data TEXT,  -- The JSON used in Public Player (ReadOnly)
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
`);

module.exports = db;