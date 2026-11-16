-- Blokir total percobaan bypass gerbang versi aplikasi Cerpen (v1.1.38, 16 Nov 2026)
-- Database: stopwatch-db (BACKUP_DB) — JANGAN jalankan di cms-db.
-- created_at / blocked_until: milidetik epoch (Date.now()).
-- Terapkan via d1_api.py (query berparameter), satu pernyataan per panggilan.

CREATE TABLE IF NOT EXISTS cerpen_lock_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_key TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cerpen_lock_attempts_key_time
  ON cerpen_lock_attempts (subject_key, created_at);
CREATE INDEX IF NOT EXISTS idx_cerpen_lock_attempts_reason_time
  ON cerpen_lock_attempts (subject_key, reason, created_at);

CREATE TABLE IF NOT EXISTS cerpen_app_blocks (
  subject_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  blocked_until INTEGER NOT NULL,
  violation_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cerpen_app_blocks_until
  ON cerpen_app_blocks (blocked_until);
