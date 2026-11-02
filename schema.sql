-- WorkerCMS — skema D1 v2 (cocok dengan ensureSchema di store.js).
-- Worker juga membuat tabel ini otomatis saat pertama jalan (DDL satu per
-- satu, lalu migrasi PRAGMA + ALTER bila kolom lama hilang), jadi file ini
-- terutama untuk dokumentasi, setup manual, dan peninjau open-source.
-- Jalankan di D1 utama (binding DB). Tabel cms_backup_* ada di database
-- backup (binding BACKUP_DB), bukan di database utama.

CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER);
CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cms_refresh_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, device TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, replaced_by TEXT NOT NULL DEFAULT '', remember INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cms_users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_comment_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY (comment_id, user_key));
CREATE TABLE IF NOT EXISTS cms_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_loadtest_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, vu INTEGER NOT NULL DEFAULT 0, duration_s INTEGER NOT NULL DEFAULT 0, p95_ms REAL NOT NULL DEFAULT 0, failed_rate REAL NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '');

-- API Dracin (katalog metadata saja — TIDAK ada stream URL, TIDAK ada
-- identitas perangkat di tabel mana pun; usage hanya simpan lokasi kasar
-- dari request.cf, tanpa IP dan tanpa user-agent).
CREATE TABLE IF NOT EXISTS dracin_api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, scope TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dracin_catalog (platform TEXT NOT NULL, title_id TEXT NOT NULL, title TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', episode_count INTEGER NOT NULL DEFAULT 0, free_count INTEGER NOT NULL DEFAULT 0, locked_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (platform, title_id));
CREATE TABLE IF NOT EXISTS dracin_episodes (platform TEXT NOT NULL, title_id TEXT NOT NULL, idx INTEGER NOT NULL, item_id TEXT NOT NULL, duration_s REAL NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (platform, title_id, idx));
CREATE TABLE IF NOT EXISTS dracin_seeds (platform TEXT NOT NULL, query TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (platform, query));
CREATE TABLE IF NOT EXISTS dracin_api_usage (ts INTEGER NOT NULL, key_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '');

-- Tabel backup di database backup (dibuat otomatis oleh Worker saat tombol
-- backup ditekan, bukan dari database utama):
CREATE TABLE IF NOT EXISTS cms_backup_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0, backup_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_comments (id INTEGER PRIMARY KEY, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER, backup_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, backup_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL, backup_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, backup_at TEXT NOT NULL, PRIMARY KEY (comment_id, user_key));
CREATE TABLE IF NOT EXISTS cms_backup_loadtest_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, vu INTEGER NOT NULL DEFAULT 0, duration_s INTEGER NOT NULL DEFAULT 0, p95_ms REAL NOT NULL DEFAULT 0, failed_rate REAL NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '', backup_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_dracin_api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, scope TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, backup_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_dracin_catalog (platform TEXT NOT NULL, title_id TEXT NOT NULL, title TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', episode_count INTEGER NOT NULL DEFAULT 0, free_count INTEGER NOT NULL DEFAULT 0, locked_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, backup_at TEXT NOT NULL, PRIMARY KEY (platform, title_id));
CREATE TABLE IF NOT EXISTS cms_backup_dracin_episodes (platform TEXT NOT NULL, title_id TEXT NOT NULL, idx INTEGER NOT NULL, item_id TEXT NOT NULL, duration_s REAL NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, backup_at TEXT NOT NULL, PRIMARY KEY (platform, title_id, idx));
CREATE TABLE IF NOT EXISTS cms_backup_dracin_seeds (platform TEXT NOT NULL, query TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL, PRIMARY KEY (platform, query));
CREATE TABLE IF NOT EXISTS cms_backup_dracin_api_usage (ts INTEGER NOT NULL, key_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', backup_at TEXT NOT NULL);
