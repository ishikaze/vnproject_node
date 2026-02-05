const Database = require('better-sqlite3');
const db = new Database('database.db');

// Enable foreign keys
db.pragma('foreign_keys = ON');

// 1. CORE TABLES (Existing)
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
        is_published INTEGER DEFAULT 0,
        cover_image TEXT DEFAULT '/images/default_cover.png',
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
`);

// 2. MIGRATION: Add display_name to users if missing
try {
    db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
    console.log("Migration: Added display_name to users table.");
} catch (e) {
    // Column likely exists already, ignore error
}

// 3. NEW FEATURE TABLES

db.exec(`
    -- VIEWS
    -- Tracks individual views per episode to calculate cooldowns
    CREATE TABLE IF NOT EXISTS views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        episode_id INTEGER,
        viewer_hash TEXT, -- IP + UserAgent hash to track non-logged in users
        user_id TEXT,     -- Nullable (if not logged in)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- LIKES
    -- User likes an EPISODE. We can count Project likes by aggregating these.
    CREATE TABLE IF NOT EXISTS likes (
        user_id TEXT,
        project_id INTEGER,
        episode_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, episode_id)
    );

    -- RATINGS
    -- User rates an EPISODE (1-5).
    CREATE TABLE IF NOT EXISTS ratings (
        user_id TEXT,
        project_id INTEGER,
        episode_id INTEGER,
        score REAL CHECK(score >= 1 AND score <= 5),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, episode_id)
    );

    -- COMMENTS
    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        project_id INTEGER,
        episode_id INTEGER,
        text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    -- COLLECTIONS (Playlists)
    CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        name TEXT,
        is_system INTEGER DEFAULT 0, -- 1 = 'Liked Videos' (cannot delete), 0 = Custom
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ITEMS INSIDE COLLECTIONS
    CREATE TABLE IF NOT EXISTS collection_items (
        collection_id INTEGER,
        project_id INTEGER, -- Collections store Series (Projects), not just Episodes
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (collection_id, project_id),
        FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE
    );
`);

module.exports = db;