-- Fitur sosial Cerpen Hozin (CMS v87.3, 14 Nov 2026).
-- Jalankan di D1 cms-db (UUID 8281a60e-96fc-4992-9011-9b9891e08786, binding DB).
-- JANGAN jalankan di stopwatch-db: tabel konten (cerpen_episodes /
-- cerpen_komik_episodes / cerpen_news) tinggal di sana, tapi tabel sosial
-- ini tinggal di cms-db bersama cms_users + tabel koin v87.
-- Tabel ini juga dibuat otomatis oleh ensureSchema() di store.js.
CREATE TABLE IF NOT EXISTS cerpen_content_stats (kind TEXT NOT NULL, ref TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, dislikes INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, ref));
CREATE TABLE IF NOT EXISTS cerpen_content_votes (kind TEXT NOT NULL, ref TEXT NOT NULL, voter_key TEXT NOT NULL, vote INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, ref, voter_key));
CREATE TABLE IF NOT EXISTS cerpen_content_views (kind TEXT NOT NULL, ref TEXT NOT NULL, viewer_key TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (kind, ref, viewer_key, day));
CREATE TABLE IF NOT EXISTS cerpen_content_reports (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, reporter_key TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'baru', day TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cerpen_content_reports_daily ON cerpen_content_reports (kind, ref, reporter_key, day);
CREATE INDEX IF NOT EXISTS idx_cerpen_content_reports_status ON cerpen_content_reports (status, created_at);
-- 15 Nov 2026 (v87.5): bookmark ikut akun — sinkron server.
CREATE TABLE IF NOT EXISTS cerpen_bookmarks (user_id TEXT NOT NULL, kind TEXT NOT NULL, content_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind, content_id));
