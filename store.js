// Store WorkerCMS — skema D1, pengaturan, plugin aktif, backup, dan render halaman.
import { themes } from './themes.js';
import { pluginDefs } from './plugins.js';
import { esc } from './util.js';

let schemaReady = null;

// Kebijakan retensi data analitik (bukan data produksi):
// - cms_view_events: riwayat views harian, disimpan 90 hari. Counter total
//   views di cms_posts TIDAK dihapus (angka total tetap utuh).
// - cms_rate_limits: bucket per jendela waktu, disimpan 24 jam.
// - cms_login_attempts: jejak gagal login admin, disimpan 24 jam
//   (lockout admin hanya membaca 15 menit ke belakang).
// Post, komentar, user, pengaturan, plugin, vote, loadtest, dan backup
// TIDAK PERNAH dihapus oleh prune. Prune berjalan bertahap (maks 500
// baris per pemanggilan) supaya satu request tidak membakar kuota D1;
// pemanggilan berikutnya melanjutkan sampai bersih.
export const VIEW_EVENTS_RETENTION_DAYS = 90;
export const RATE_LIMIT_RETENTION_HOURS = 24;
export const LOGIN_ATTEMPTS_RETENTION_HOURS = 24;
export const PRUNE_BATCH_SIZE = 500;

export async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER, pinned INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS cms_refresh_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, device TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, replaced_by TEXT NOT NULL DEFAULT '', remember INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cms_users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0)`,
        // 13 Nov 2026 (v83): kode OTP verifikasi email — hanya hash yang
        // disimpan, satu kode aktif per email (INSERT OR REPLACE).
        `CREATE TABLE IF NOT EXISTS cms_otp_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_comment_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY (comment_id, user_key))`,
        `CREATE TABLE IF NOT EXISTS cms_view_events (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, viewed_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_loadtest_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, vu INTEGER NOT NULL DEFAULT 0, duration_s INTEGER NOT NULL DEFAULT 0, p95_ms REAL NOT NULL DEFAULT 0, failed_rate REAL NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS cms_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL)`,
        // 12 Nov 2026 (v74): security_events — aktivitas yang diblokir
        // (login gagal / rate-limit / CSRF) untuk globe publik /uptime.
        // TANPA IP: hanya negara/kota kasar dari request.cf, supaya data
        // yang tampil publik aman. Retensi 500 baris terbaru.
        `CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, country TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '')`,

        `CREATE TABLE IF NOT EXISTS dracin_api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, scope TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS dracin_catalog (platform TEXT NOT NULL, title_id TEXT NOT NULL, title TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', episode_count INTEGER NOT NULL DEFAULT 0, free_count INTEGER NOT NULL DEFAULT 0, locked_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (platform, title_id))`,
        `CREATE TABLE IF NOT EXISTS dracin_episodes (platform TEXT NOT NULL, title_id TEXT NOT NULL, idx INTEGER NOT NULL, item_id TEXT NOT NULL, duration_s REAL NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (platform, title_id, idx))`,
        `CREATE TABLE IF NOT EXISTS dracin_seeds (platform TEXT NOT NULL, query TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (platform, query))`,
        `CREATE TABLE IF NOT EXISTS dracin_api_usage (ts INTEGER NOT NULL, key_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '')`,
        // Index untuk query dashboard (filter 30 hari) + prune retensi.
        `CREATE INDEX IF NOT EXISTS idx_cms_view_events_viewed_at ON cms_view_events (viewed_at)`,
        `CREATE INDEX IF NOT EXISTS idx_security_events_ts ON security_events (ts)`,
        // 13 Nov 2026 (v87): sistem koin Cerpen — dompet, unlock, ledger,
        // voucher, harga, audit admin, ban akun, pantauan perangkat.
        `CREATE TABLE IF NOT EXISTS cerpen_wallets (owner_key TEXT PRIMARY KEY, owner_type TEXT NOT NULL, user_id TEXT, device_id TEXT, balance INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_wallets_user ON cerpen_wallets(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_wallets_device ON cerpen_wallets(device_id)`,
        `CREATE TABLE IF NOT EXISTS cerpen_devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, android_id TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_devices_user ON cerpen_devices(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_devices_android ON cerpen_devices(android_id)`,
        `CREATE TABLE IF NOT EXISTS cerpen_unlocks (owner_key TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL, season INTEGER NOT NULL DEFAULT 1, no INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_key, kind, target_id, season, no))`,
        `CREATE TABLE IF NOT EXISTS cerpen_coin_ledger (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id TEXT, device_id TEXT, delta INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_coin_ledger_owner ON cerpen_coin_ledger(owner_key, created_at)`,
        `CREATE TABLE IF NOT EXISTS cerpen_voucher_batches (batch_id TEXT PRIMARY KEY, reward_type TEXT NOT NULL DEFAULT 'coins', reward_coins INTEGER NOT NULL DEFAULT 0, reward_value INTEGER NOT NULL DEFAULT 0, reward_target_kind TEXT, reward_target_id TEXT, reward_season INTEGER, reward_no INTEGER, total_max INTEGER NOT NULL, per_device_max INTEGER NOT NULL DEFAULT 1, valid_from INTEGER, expires_at INTEGER, redeemed_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cerpen_vip (user_id TEXT PRIMARY KEY, expires_at INTEGER, granted_by TEXT NOT NULL DEFAULT 'admin', reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cerpen_vouchers (code_hash TEXT PRIMARY KEY, batch_id TEXT NOT NULL, code_prefix TEXT NOT NULL DEFAULT '', redeemed_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_vouchers_batch ON cerpen_vouchers(batch_id)`,
        `CREATE TABLE IF NOT EXISTS cerpen_voucher_redemptions (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, owner_key TEXT NOT NULL, device_id TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_voucher_red_code_dev ON cerpen_voucher_redemptions(code_hash, device_id)`,
        `CREATE TABLE IF NOT EXISTS cerpen_coin_pricing (kind TEXT NOT NULL, target_id TEXT NOT NULL, price INTEGER NOT NULL, free_episodes INTEGER NOT NULL, PRIMARY KEY (kind, target_id))`,
        `CREATE TABLE IF NOT EXISTS coin_admin_audit (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS cerpen_bans (id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, banned_by TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL, expires_at INTEGER, active INTEGER NOT NULL DEFAULT 1, unbanned_at INTEGER, unbanned_by TEXT, unban_note TEXT NOT NULL DEFAULT '')`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_cerpen_bans_active ON cerpen_bans(target_type, target_id) WHERE active = 1`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_bans_target ON cerpen_bans(target_id, active)`,
        `CREATE TABLE IF NOT EXISTS cerpen_device_watch (device_id TEXT PRIMARY KEY, android_id TEXT NOT NULL DEFAULT '', watched INTEGER NOT NULL DEFAULT 0, auto_flag INTEGER NOT NULL DEFAULT 0, flag_reason TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cerpen_coin_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '', android_id TEXT NOT NULL DEFAULT '', user_id TEXT, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_coin_events_device ON cerpen_coin_events(device_id, created_at)`,
        `CREATE INDEX IF NOT EXISTS idx_cerpen_coin_events_kind ON cerpen_coin_events(kind, created_at)`,
      ];
      // 11 Nov 2026 (performa): DDL dieksekusi via SATU batch, bukan
      // ~30 round-trip D1 berurutan — di isolate dingin tiap round-trip
      // 80–150 ms, jadi versi lama bikin TTFB 3–4,5 detik di situs sepi
      // (isolate hampir selalu dingin). Batch D1 = 1 round-trip.
      await env.DB.batch(ddl.map(sql => env.DB.prepare(sql)));
      const info = await env.DB.prepare(`PRAGMA table_info(cms_posts)`).all();
      const have = new Set((info.results || []).map(r => r.name));
      const missing = {
        body: `ALTER TABLE cms_posts ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
        category: `ALTER TABLE cms_posts ADD COLUMN category TEXT NOT NULL DEFAULT 'Umum'`,
        status: `ALTER TABLE cms_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'`,
        created_at: `ALTER TABLE cms_posts ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`,
        updated_at: `ALTER TABLE cms_posts ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
        body_mode: `ALTER TABLE cms_posts ADD COLUMN body_mode TEXT NOT NULL DEFAULT 'text'`,
        visibility: `ALTER TABLE cms_posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
        publish_at: `ALTER TABLE cms_posts ADD COLUMN publish_at TEXT NOT NULL DEFAULT ''`,
        post_password_hash: `ALTER TABLE cms_posts ADD COLUMN post_password_hash TEXT NOT NULL DEFAULT ''`,
        post_password_salt: `ALTER TABLE cms_posts ADD COLUMN post_password_salt TEXT NOT NULL DEFAULT ''`,
        views: `ALTER TABLE cms_posts ADD COLUMN views INTEGER NOT NULL DEFAULT 0`,
        tags: `ALTER TABLE cms_posts ADD COLUMN tags TEXT NOT NULL DEFAULT ''`,
      };
      const alters = Object.entries(missing).filter(([col]) => !have.has(col)).map(([, sql]) => env.DB.prepare(sql));
      const cInfo = await env.DB.prepare(`PRAGMA table_info(cms_comments)`).all();
      const cHave = new Set((cInfo.results || []).map(r => r.name));
      if (!cHave.has('parent_id')) alters.push(env.DB.prepare(`ALTER TABLE cms_comments ADD COLUMN parent_id INTEGER`));
      if (!cHave.has('pinned')) alters.push(env.DB.prepare(`ALTER TABLE cms_comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`));
      // 13 Nov 2026 (v83): kolom email + flag verifikasi di cms_users.
      const uInfo = await env.DB.prepare(`PRAGMA table_info(cms_users)`).all();
      const uHave = new Set((uInfo.results || []).map(r => r.name));
      if (!uHave.has('email')) alters.push(env.DB.prepare(`ALTER TABLE cms_users ADD COLUMN email TEXT`));
      if (!uHave.has('email_verified')) alters.push(env.DB.prepare(`ALTER TABLE cms_users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`));
      // 13 Nov 2026 (v87): kolom kunci akun (dipakai penegakan ban koin).
      if (!uHave.has('locked')) alters.push(env.DB.prepare(`ALTER TABLE cms_users ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`));
      // 13 Nov 2026 (v87.2): badge verifikasi akun (tampil di panel + app).
      if (!uHave.has('verified')) alters.push(env.DB.prepare(`ALTER TABLE cms_users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`));
      if (alters.length) await env.DB.batch(alters);
      // Akun lama (tanpa email) dianggap terverifikasi — jangan kunci mereka
      // keluar. Idempotent: hanya baris tanpa email yang disentuh.
      await env.DB.prepare(`UPDATE cms_users SET email_verified = 1 WHERE email IS NULL`).run();
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('site_title', 'WorkerCMS')`),
        env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('theme', 'terang')`),
        env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('navbar', 'modern')`),
        env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('donate_url', '')`),
        // 13 Nov 2026 (v87): default harga koin Cerpen.
        env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('cerpen_coin_price_default', '10')`),
        env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('cerpen_coin_free_episodes_default', '1')`),
        ...pluginDefs.map(p => env.DB.prepare(`INSERT OR IGNORE INTO cms_plugins (id, enabled) VALUES (?, 1)`).bind(p.id)),
      ]);
      const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_posts`).first();
      if (existing && Number(existing.n) === 0) {
        const now = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, 'text', 'public', ?, '', '', 0)`).bind('p-welcome', 'selamat-datang', 'Selamat Datang di WorkerCMS', 'Ini post pertama. Dari panel admin, kamu bisa menambah post baru, menyetujui komentar, mengganti tema, dan mengaktifkan plugin.', 'Umum', now, now, now).run();
      }
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
// Prune bertahap data analitik (lihat kebijakan retensi di atas).
// Mengembalikan jumlah baris yang dihapus pada pemanggilan ini.
// Dipanggil dari dashboard admin (awaited, try/catch di pemanggil —
// gagal prune tidak merusak halaman). Tanpa Cron di Worker ini, prune
// hanya jalan saat admin membuka dashboard; itu keterbatasan yang
// didokumentasikan di README, bukan asumsi tersembunyi.
export async function pruneAnalytics(env) {
  const cutoff = new Date(Date.now() - VIEW_EVENTS_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const res = await env.DB.prepare(
    `DELETE FROM cms_view_events WHERE id IN (SELECT id FROM cms_view_events WHERE viewed_at < ? ORDER BY id ASC LIMIT ?)`
  ).bind(cutoff, PRUNE_BATCH_SIZE).run();
  return Number(res && res.meta ? res.meta.changes : 0) || 0;
}
export async function pruneRateTables(env) {
  const cutoff = new Date(Date.now() - RATE_LIMIT_RETENTION_HOURS * 3600 * 1000).toISOString();
  const loginCutoff = new Date(Date.now() - LOGIN_ATTEMPTS_RETENTION_HOURS * 3600 * 1000).toISOString();
  const r1 = await env.DB.prepare(
    `DELETE FROM cms_rate_limits WHERE key IN (SELECT key FROM cms_rate_limits WHERE window_start < ? ORDER BY key ASC LIMIT ?)`
  ).bind(cutoff, PRUNE_BATCH_SIZE).run();
  const r2 = await env.DB.prepare(
    `DELETE FROM cms_login_attempts WHERE id IN (SELECT id FROM cms_login_attempts WHERE created_at < ? ORDER BY id ASC LIMIT ?)`
  ).bind(loginCutoff, PRUNE_BATCH_SIZE).run();
  const n1 = Number(r1 && r1.meta ? r1.meta.changes : 0) || 0;
  const n2 = Number(r2 && r2.meta ? r2.meta.changes : 0) || 0;
  return n1 + n2;
}

export async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare(`SELECT value FROM cms_settings WHERE key = ?`).bind(key).first();
  return row ? row.value : fallback;
}
// 11 Nov 2026 (performa): SATU query untuk semua pengaturan — halaman
// publik tadinya memanggil getSetting 5–8x (2 gelombang D1 berurutan:
// Promise.all halaman + Promise.all renderPage). Tabel settings kecil
// (puluhan baris), jadi SELECT * jauh lebih murah daripada N round-trip.
export async function getAllSettings(env) {
  const rows = await env.DB.prepare(`SELECT * FROM cms_settings ORDER BY key ASC`).all();
  return new Map((rows.results || []).map(r => [r.key, r.value]));
}
export async function getEnabledPlugins(env) {
  const rows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
  const map = new Map((rows.results || []).map(r => [r.id, Number(r.enabled) === 1]));
  return pluginDefs.filter(p => map.get(p.id) !== false);
}

export async function doBackup(env) {
  if (!env.BACKUP_DB) throw new Error('Binding BACKUP_DB belum dipasang di Worker');
  const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at ASC`).all();
  const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at ASC`).all();
  // H2 (5 Nov 2026): backup TIDAK menyalin rahasia ke BACKUP_DB bersama —
  // kunci ImgBB ('imgbb_api_keys'/'imgbb_api_key'), 'csrf_secret' (H5), dan
  // hash/salt password (komentator + post) dikosongkan. Setelah restore,
  // isi ulang kunci ImgBB di /kendali/settings; csrf_secret dibuat ulang
  // otomatis saat login berikut; komentator perlu reset password.
  const settings = await env.DB.prepare(`SELECT key, value FROM cms_settings WHERE key NOT IN ('imgbb_api_keys', 'imgbb_api_key', 'csrf_secret') ORDER BY key ASC`).all();
  const plugins = await env.DB.prepare(`SELECT * FROM cms_plugins ORDER BY id ASC`).all();
  const users = await env.DB.prepare(`SELECT id, username, created_at FROM cms_users ORDER BY created_at ASC`).all();
  const votes = await env.DB.prepare(`SELECT * FROM cms_comment_votes ORDER BY comment_id ASC`).all();
  const loadtests = await env.DB.prepare(`SELECT * FROM cms_loadtest_runs ORDER BY created_at ASC`).all();

  const dracinKeys = await env.DB.prepare(`SELECT * FROM dracin_api_keys ORDER BY created_at ASC`).all();
  const dracinCatalog = await env.DB.prepare(`SELECT * FROM dracin_catalog ORDER BY platform ASC, title_id ASC`).all();
  const dracinEpisodes = await env.DB.prepare(`SELECT * FROM dracin_episodes ORDER BY platform ASC, title_id ASC, idx ASC`).all();
  const dracinSeeds = await env.DB.prepare(`SELECT * FROM dracin_seeds ORDER BY platform ASC, query ASC`).all();
  const dracinUsage = await env.DB.prepare(`SELECT * FROM dracin_api_usage ORDER BY ts ASC`).all();
  const now = new Date().toISOString();
  const bak = env.BACKUP_DB;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS cms_backup_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '', backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_comments (id INTEGER PRIMARY KEY, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, backup_at TEXT NOT NULL, PRIMARY KEY (comment_id, user_key))`,
    `CREATE TABLE IF NOT EXISTS cms_backup_loadtest_runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, vu INTEGER NOT NULL DEFAULT 0, duration_s INTEGER NOT NULL DEFAULT 0, p95_ms REAL NOT NULL DEFAULT 0, failed_rate REAL NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '', backup_at TEXT NOT NULL)`,

    `CREATE TABLE IF NOT EXISTS cms_backup_dracin_api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, scope TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_dracin_catalog (platform TEXT NOT NULL, title_id TEXT NOT NULL, title TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', synopsis TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', episode_count INTEGER NOT NULL DEFAULT 0, free_count INTEGER NOT NULL DEFAULT 0, locked_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, backup_at TEXT NOT NULL, PRIMARY KEY (platform, title_id))`,
    `CREATE TABLE IF NOT EXISTS cms_backup_dracin_episodes (platform TEXT NOT NULL, title_id TEXT NOT NULL, idx INTEGER NOT NULL, item_id TEXT NOT NULL, duration_s REAL NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, backup_at TEXT NOT NULL, PRIMARY KEY (platform, title_id, idx))`,
    `CREATE TABLE IF NOT EXISTS cms_backup_dracin_seeds (platform TEXT NOT NULL, query TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL, PRIMARY KEY (platform, query))`,
    `CREATE TABLE IF NOT EXISTS cms_backup_dracin_api_usage (ts INTEGER NOT NULL, key_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, country TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', backup_at TEXT NOT NULL)`,
  ]) await bak.prepare(sql).run();
  const stmts = [
    bak.prepare(`DELETE FROM cms_backup_posts`),
    bak.prepare(`DELETE FROM cms_backup_comments`),
    bak.prepare(`DELETE FROM cms_backup_settings`),
    bak.prepare(`DELETE FROM cms_backup_plugins`),
    bak.prepare(`DELETE FROM cms_backup_users`),
    bak.prepare(`DELETE FROM cms_backup_votes`),
    bak.prepare(`DELETE FROM cms_backup_loadtest_runs`),

    bak.prepare(`DELETE FROM cms_backup_dracin_api_keys`),
    bak.prepare(`DELETE FROM cms_backup_dracin_catalog`),
    bak.prepare(`DELETE FROM cms_backup_dracin_episodes`),
    bak.prepare(`DELETE FROM cms_backup_dracin_seeds`),
    bak.prepare(`DELETE FROM cms_backup_dracin_api_usage`),
  ];
  for (const p of (posts.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views, tags, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.id, p.slug, p.title, p.body, p.category, p.status, p.created_at, p.updated_at, p.body_mode || 'text', p.visibility || 'public', p.publish_at || p.created_at || '', '', '', Number(p.views) || 0, p.tags || '', now));
  }
  for (const c of (comments.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_comments (id, post_id, name, text, status, created_at, parent_id, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.post_id, c.name, c.text, c.status, c.created_at, c.parent_id ?? null, now));
  }
  for (const u of (users.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_users (id, username, password_hash, salt, created_at, backup_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(u.id, u.username, '', '', u.created_at, now));
  }
  for (const v of (votes.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_votes (comment_id, user_key, vote, backup_at) VALUES (?, ?, ?, ?)`).bind(v.comment_id, v.user_key, v.vote, now));
  }
  for (const s of (settings.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_settings (key, value, backup_at) VALUES (?, ?, ?)`).bind(s.key, s.value, now));
  }
  for (const r of (loadtests.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_loadtest_runs (id, created_at, vu, duration_s, p95_ms, failed_rate, passed, details, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(r.id, r.created_at, r.vu, r.duration_s, r.p95_ms, r.failed_rate, r.passed, r.details || '', now));
  }
  for (const p of (plugins.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_plugins (id, enabled, backup_at) VALUES (?, ?, ?)`).bind(p.id, p.enabled, now));
  }
  for (const k of (dracinKeys.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_dracin_api_keys (id, name, key_hash, scope, active, created_at, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(k.id, k.name, k.key_hash, k.scope, k.active, k.created_at, now));
  }
  for (const t of (dracinCatalog.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_dracin_catalog (platform, title_id, title, cover_url, synopsis, language, episode_count, free_count, locked_count, updated_at, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(t.platform, t.title_id, t.title, t.cover_url || '', t.synopsis || '', t.language || '', Number(t.episode_count) || 0, Number(t.free_count) || 0, Number(t.locked_count) || 0, t.updated_at, now));
  }
  for (const e of (dracinEpisodes.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_dracin_episodes (platform, title_id, idx, item_id, duration_s, locked, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(e.platform, e.title_id, e.idx, e.item_id, Number(e.duration_s) || 0, Number(e.locked) || 0, now));
  }
  for (const s of (dracinSeeds.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_dracin_seeds (platform, query, enabled, backup_at) VALUES (?, ?, ?, ?)`).bind(s.platform, s.query, Number(s.enabled) || 0, now));
  }
  for (const u of (dracinUsage.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_dracin_api_usage (ts, key_id, endpoint, method, status, country, region, city, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(u.ts, u.key_id, u.endpoint, u.method, u.status, u.country || '', u.region || '', u.city || '', now));
  }

  await bak.batch(stmts);
  return { posts: (posts.results || []).length, comments: (comments.results || []).length };
}

export function envSiteTitle(env) {
  const v = env && typeof env.SITE_TITLE === 'string' ? env.SITE_TITLE.trim().slice(0, 100) : '';
  return v;
}

export async function renderPage(env, pageTitle, content, opts = {}) {
  let siteTitle = opts.siteTitle;
  let themeId = opts.themeId;
  let siteAvatar = opts.siteAvatar;
  let navbarId = opts.navbarId;
  if (!siteTitle || !themeId || siteAvatar === undefined || !navbarId) {
    const envTitle = envSiteTitle(env);
    const [siteTitleDb, themeDb, avatarDb, navbarDb] = await Promise.all([
      envTitle || siteTitle ? Promise.resolve('') : getSetting(env, 'site_title', 'WorkerCMS'),
      themeId ? Promise.resolve('') : getSetting(env, 'theme', 'terang'),
      siteAvatar !== undefined ? Promise.resolve('') : getSetting(env, 'site_avatar', ''),
      navbarId ? Promise.resolve('') : getSetting(env, 'navbar', 'modern'),
    ]);
    if (!siteTitle) siteTitle = envTitle || siteTitleDb;
    if (!themeId) themeId = themeDb;
    if (siteAvatar === undefined) siteAvatar = avatarDb;
    if (!navbarId) navbarId = navbarDb;
  }
  if (typeof siteAvatar !== 'string' || !siteAvatar.startsWith('https://') || /["'<\s]/.test(siteAvatar)) siteAvatar = '';
  // AdSense: satu setting mengendalikan script + meta verifikasi di <head>.
  // Diambil dari opts (pageOpts) bila ada, kalau tidak baca D1 sekali.
  let adsenseClient = opts.adsenseClient;
  if (adsenseClient === undefined) adsenseClient = await getSetting(env, 'adsense_client', '');
  const theme = themes[themeId] || themes.terang;
  return theme.render({ siteTitle: esc(siteTitle), pageTitle: esc(pageTitle), content, siteAvatar, metaDesc: opts.metaDesc || '', navbar: navbarId, adsenseClient });
}
