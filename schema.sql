CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
-- Tabel backup di stopwatch (dibuat otomatis oleh Worker saat tombol backup ditekan, bukan dari schema ini):
-- cms_backup_posts, cms_backup_comments, cms_backup_settings, cms_backup_plugins
