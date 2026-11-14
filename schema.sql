-- WorkerCMS — skema D1 v2 (cocok dengan ensureSchema di store.js).
-- Worker juga membuat tabel ini otomatis saat pertama jalan (DDL satu per
-- satu, lalu migrasi PRAGMA + ALTER bila kolom lama hilang), jadi file ini
-- terutama untuk dokumentasi, setup manual, dan peninjau open-source.
-- Jalankan di D1 utama (binding DB). Tabel cms_backup_* ada di database
-- backup (binding BACKUP_DB), bukan di database utama.

CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER, pinned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cms_refresh_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, device TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, replaced_by TEXT NOT NULL DEFAULT '', remember INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cms_users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, reading_private INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0);
-- v83: kode OTP verifikasi email pendaftaran (hanya hash yang disimpan).
CREATE TABLE IF NOT EXISTS cms_otp_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

-- Waktu baca (v81): lihat reading.js untuk aturan algoritma lengkap.
-- cms_reading_sessions: detik aktif per akun/hari/post (upsert heartbeat).
-- cms_reading_hours: detik aktif per akun/hari/jam WIB (untuk rentang jam).
-- reading_private di cms_users: 0 = terlihat pengguna lain (default, fase 2),
-- 1 = private. Fase 1: kolom disiapkan saja; tampilan publik belum dibangun.
CREATE TABLE IF NOT EXISTS cms_reading_sessions (user_id TEXT NOT NULL, day_wib TEXT NOT NULL, post_id TEXT NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, max_scroll INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, day_wib, post_id));
CREATE TABLE IF NOT EXISTS cms_reading_hours (user_id TEXT NOT NULL, day_wib TEXT NOT NULL, hour_wib INTEGER NOT NULL, seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day_wib, hour_wib));
CREATE INDEX IF NOT EXISTS idx_reading_sessions_user ON cms_reading_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_reading_hours_user ON cms_reading_hours (user_id);
CREATE TABLE IF NOT EXISTS cms_comment_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY (comment_id, user_key));
CREATE TABLE IF NOT EXISTS cms_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL);

-- API Dracin (katalog metadata saja — TIDAK ada stream URL, TIDAK ada
-- identitas perangkat di tabel mana pun; usage hanya simpan lokasi kasar
-- dari request.cf, tanpa IP dan tanpa user-agent).
CREATE TABLE IF NOT EXISTS dracin_api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, scope TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dracin_catalog (platform TEXT NOT NULL, title_id TEXT NOT NULL, title TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', episode_count INTEGER NOT NULL DEFAULT 0, free_count INTEGER NOT NULL DEFAULT 0, locked_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (platform, title_id));
CREATE TABLE IF NOT EXISTS dracin_episodes (platform TEXT NOT NULL, title_id TEXT NOT NULL, idx INTEGER NOT NULL, item_id TEXT NOT NULL, duration_s REAL NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (platform, title_id, idx));
CREATE TABLE IF NOT EXISTS dracin_seeds (platform TEXT NOT NULL, query TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (platform, query));
CREATE TABLE IF NOT EXISTS dracin_api_usage (ts INTEGER NOT NULL, key_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cms_loadtest_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, vu INTEGER NOT NULL DEFAULT 0, duration_s INTEGER NOT NULL DEFAULT 0, p95_ms REAL NOT NULL DEFAULT 0, failed_rate REAL NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cms_view_events (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, viewed_at TEXT NOT NULL);
-- Index untuk query dashboard (filter 30 hari) + prune retensi 90 hari.
CREATE INDEX IF NOT EXISTS idx_cms_view_events_viewed_at ON cms_view_events (viewed_at);

-- Aktivitas yang diblokir untuk globe publik /uptime (Worker v74).
-- TANPA IP: hanya negara/kota kasar dari request.cf. Retensi 500 baris.
CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_security_events_ts ON security_events (ts);

-- Retensi data analitik (bukan data produksi): cms_view_events disimpan
-- 90 hari, cms_rate_limits + cms_login_attempts 24 jam, dihapus bertahap
-- (maks 500 baris per pemanggilan) saat admin membuka dashboard.
-- Post, komentar, user, pengaturan, plugin, vote, dan loadtest TIDAK
-- pernah dihapus oleh prune.

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

-- ================= Sistem Koin Cerpen (v87, 13 Nov 2026) =================
-- Dompet: owner_key = 'user:<id>' | 'device:<uuid>'.
CREATE TABLE IF NOT EXISTS cerpen_wallets (owner_key TEXT PRIMARY KEY, owner_type TEXT NOT NULL, user_id TEXT, device_id TEXT, balance INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cerpen_wallets_user ON cerpen_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_cerpen_wallets_device ON cerpen_wallets(device_id);
CREATE TABLE IF NOT EXISTS cerpen_devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, android_id TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cerpen_devices_user ON cerpen_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_cerpen_devices_android ON cerpen_devices(android_id);
CREATE TABLE IF NOT EXISTS cerpen_unlocks (owner_key TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL, season INTEGER NOT NULL DEFAULT 1, no INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_key, kind, target_id, season, no));
CREATE TABLE IF NOT EXISTS cerpen_coin_ledger (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id TEXT, device_id TEXT, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cerpen_coin_ledger_owner ON cerpen_coin_ledger(owner_key, created_at);
-- Batch voucher fleksibel (19:17): reward_type coins|episode|season|series|vip.
-- valid_from/expires_at = unix DETIK. redeemed_count batch = kuota total atomik.
CREATE TABLE IF NOT EXISTS cerpen_voucher_batches (batch_id TEXT PRIMARY KEY, reward_type TEXT NOT NULL DEFAULT 'coins', reward_coins INTEGER NOT NULL DEFAULT 0, reward_value INTEGER NOT NULL DEFAULT 0, reward_target_kind TEXT, reward_target_id TEXT, reward_season INTEGER, reward_no INTEGER, total_max INTEGER NOT NULL, per_device_max INTEGER NOT NULL DEFAULT 1, valid_from INTEGER, expires_at INTEGER, redeemed_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cerpen_vouchers (code_hash TEXT PRIMARY KEY, batch_id TEXT NOT NULL, code_prefix TEXT NOT NULL DEFAULT '', redeemed_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cerpen_vouchers_batch ON cerpen_vouchers(batch_id);
CREATE TABLE IF NOT EXISTS cerpen_voucher_redemptions (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, owner_key TEXT NOT NULL, device_id TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cerpen_voucher_red_code_dev ON cerpen_voucher_redemptions(code_hash, device_id);
CREATE TABLE IF NOT EXISTS cerpen_coin_pricing (kind TEXT NOT NULL, target_id TEXT NOT NULL, price INTEGER NOT NULL, free_episodes INTEGER NOT NULL, PRIMARY KEY (kind, target_id));
CREATE TABLE IF NOT EXISTS coin_admin_audit (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS cerpen_bans (id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, banned_by TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL, expires_at INTEGER, active INTEGER NOT NULL DEFAULT 1, unbanned_at INTEGER, unbanned_by TEXT, unban_note TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS idx_cerpen_bans_active ON cerpen_bans(target_type, target_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_cerpen_bans_target ON cerpen_bans(target_id, active);
CREATE TABLE IF NOT EXISTS cerpen_device_watch (device_id TEXT PRIMARY KEY, android_id TEXT NOT NULL DEFAULT '', watched INTEGER NOT NULL DEFAULT 0, auto_flag INTEGER NOT NULL DEFAULT 0, flag_reason TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cerpen_coin_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '', android_id TEXT NOT NULL DEFAULT '', user_id TEXT, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cerpen_coin_events_device ON cerpen_coin_events(device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cerpen_coin_events_kind ON cerpen_coin_events(kind, created_at);
-- VIP per akun (19:17): expires_at = unix MS.
CREATE TABLE IF NOT EXISTS cerpen_vip (user_id TEXT PRIMARY KEY, expires_at INTEGER, granted_by TEXT NOT NULL DEFAULT 'admin', reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);

-- ================= Fitur Sosial Cerpen (v87.3, 14 Nov 2026) =================
-- Lihat social.js + social_ddl.sql. Tinggal di cms-db (binding DB).
CREATE TABLE IF NOT EXISTS cerpen_content_stats (kind TEXT NOT NULL, ref TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, dislikes INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, ref));
CREATE TABLE IF NOT EXISTS cerpen_content_votes (kind TEXT NOT NULL, ref TEXT NOT NULL, voter_key TEXT NOT NULL, vote INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, ref, voter_key));
CREATE TABLE IF NOT EXISTS cerpen_content_views (kind TEXT NOT NULL, ref TEXT NOT NULL, viewer_key TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (kind, ref, viewer_key, day));
CREATE TABLE IF NOT EXISTS cerpen_content_reports (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, reporter_key TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'baru', day TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cerpen_content_reports_daily ON cerpen_content_reports (kind, ref, reporter_key, day);
CREATE INDEX IF NOT EXISTS idx_cerpen_content_reports_status ON cerpen_content_reports (status, created_at);
