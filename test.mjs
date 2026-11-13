// Uji WorkerCMS tanpa Cloudflare: mock D1 sederhana untuk pola SQL yang dipakai worker.js.
// Jalankan: node test.mjs  (harus keluar semua OK (kini 18+ cek, termasuk CSRF & rate-limit))
import worker from './worker.js';
import vm from 'node:vm';
import { themes } from './themes.js';
import { renderPage, envSiteTitle, pruneAnalytics, pruneRateTables, VIEW_EVENTS_RETENTION_DAYS } from './store.js';
import { parseTags, tagSlug, sanitizeHtml, sha256Hex } from './util.js';
import { renderMarkdown } from './markdown.js';
import { checkRateLimit } from './security.js';
import { tagLinks } from './content.js';
import { wibParts, computeReadingStats, pickFirstVisit, formatStopwatch, nextEventMs, countActiveSeconds } from './reading.js';

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  // run() mengembalikan bentuk D1Result ({success, meta:{changes}, results})
  // seperti D1 nyata — dibutuhkan checkRateLimit atomik + prune.
  async run() {
    const out = this.db.exec(this.sql, this.args, 'run');
    if (out && typeof out === 'object' && !Array.isArray(out) && typeof out.changes === 'number') {
      return { success: true, meta: { changes: out.changes }, results: [] };
    }
    return { success: true, meta: { changes: 0 }, results: [] };
  }
  async all() { return { results: this.db.exec(this.sql, this.args, 'all') }; }
  async first() { const r = this.db.exec(this.sql, this.args, 'all'); return r[0] || null; }
}
class MockDB {
  constructor() {
    this.posts = []; this.comments = []; this.settings = new Map(); this.plugins = new Map(); this.commentSeq = 0; this.attempts = []; this.backupRuns = []; this.refreshTokens = []; this.viewEvents = [];
    this.users = new Map(); this.votes = []; this.rateLimits = new Map(); this.loadtestRuns = [];
    this.otpCodes = new Map(); // v83: kode OTP per email
    this.readingSessions = []; this.readingHours = []; this.eternalStopwatch = null;
    this.dracinKeys = []; this.dracinCatalog = []; this.dracinEpisodes = []; this.dracinSeeds = []; this.dracinUsage = [];
    this.viewEventSeq = 0; this.attemptSeq = 0;
    // v62: fixture konten Cerpen (D1 stopwatch-db) untuk tes API /api/c/*/cerpen/*
    this.cerpenManifest = [{ key: 'version', value: '1' }, { key: 'updated_at', value: '2026-11-12T00:00:00+07:00' }, { key: 'counts', value: '{"cerpen_series":1,"cerpen_episodes":2}' }];
    this.cerpenSeries = [{ id: 'cerpen-01', judul: 'Surat Tanpa Nama', genre: 'Misteri', deskripsi: '', cover_url: 'https://example.com/c1.jpg', status: 'aktif' }];
    this.cerpenEpisodes = [
      { series_id: 'cerpen-01', season: 1, no: 1, judul: 'Lestari Tiba', isi_cipher: 'QUJD', word_count: 100 },
      { series_id: 'cerpen-01', season: 1, no: 2, judul: 'Yang Tidak Beres', isi_cipher: 'REVG', word_count: 120 },
    ];
    this.cerpenKomik = [{ id: 'komik-01', judul: 'Komik Tes', genre: '', deskripsi: '', cover_url: '' }];
    this.cerpenKomikEpisodes = [{ komik_id: 'komik-01', no: 1, judul: 'Episode 1', panels_cipher: 'UEFORQ==', panels_count: 2 }];
    this.cerpenNews = [{ id: 'news-1', title: 'Judul Berita', summary: 'Ringkasan', source_name: 'Sumber', source_url: 'https://example.com/a', image_url: 'https://example.com/i.jpg', images_json: '["https://example.com/i.jpg"]', details_json: '{}', topic: 'tekno', published_at: '2026-11-12', added_at: '2026-11-12' }];
    // v66: fixture API Cerpen admin (keys + submissions + audit) untuk tes /api/admin/cerpen-*
    const nowT = Date.now();
    this.cerpenApiKeys = [
      { key_id: 'key-be663fc2', key_hash: 'a'.repeat(64), name: 'muse-kedua', created_at: nowT - 2 * 3600 * 1000, revoked: 0, daily_limit: 10, auto_approve_mode: 'off', auto_approve_until: null },
      { key_id: 'key-11111111', key_hash: 'b'.repeat(64), name: 'kunci-uji', created_at: nowT - 1 * 3600 * 1000, revoked: 1, daily_limit: 5, auto_approve_mode: 'off', auto_approve_until: null },
    ];
    this.cerpenSubmissions = [
      { id: 'sub-aaaaaaaaaaaa', key_id: 'key-be663fc2', kind: 'cerpen', target_id: 'cerpen-99', title: 'Cerpen Uji Pending', dedup_hash: 'h1', payload_json: '{"kind":"cerpen","id":"cerpen-99"}', status: 'pending', created_at: nowT - 1800 * 1000, reviewed_at: null, review_note: '' },
      { id: 'sub-bbbbbbbbbbbb', key_id: 'key-be663fc2', kind: 'season', target_id: 'cerpen-01', title: 'Season Uji Approved', dedup_hash: 'h2', payload_json: '{"kind":"season","id":"cerpen-01"}', status: 'approved', created_at: nowT - 1200 * 1000, reviewed_at: nowT - 1100 * 1000, review_note: 'ok' },
      { id: 'sub-cccccccccccc', key_id: 'key-11111111', kind: 'komik', target_id: 'komik-99', title: 'Komik Uji Rejected', dedup_hash: 'h3', payload_json: '{"kind":"komik","id":"komik-99"}', status: 'rejected', created_at: nowT - 600 * 1000, reviewed_at: nowT - 500 * 1000, review_note: 'tidak lolos' },
    ];
    this.cerpenAdminAudit = [];
    // v67: fixture share link Cerpen (tabel cerpen_share_links + cerpen_share_opens)
    this.cerpenShareLinks = [];
    this.cerpenShareOpens = [];
    // v69: fixture auto-backup .md (md_backup_keys + md_backups)
    this.mdBackupKeys = [
      { key_id: 'mdk-aaaaaaaa', key_hash: 'd'.repeat(64), name: 'sekar-md-backup', created_at: nowT - 3600 * 1000, revoked: 0, daily_limit: 50 },
    ];
    this.mdBackups = [
      { id: 'mdb-111111111111', key_id: 'mdk-aaaaaaaa', path: 'data/PANDUAN-MUSE-LAIN.md', content: '# Panduan Muse Lain\n\nTeks **tebal**, `kode`, dan [tautan](https://example.com).\n\n| Kolom A | Kolom B |\n|---|---|\n| 1 | 2 |\n\n- [x] selesai\n- [ ] tertunda\n', content_hash: 'h-md-1', size: 120, version: 1, created_at: nowT - 1800 * 1000 },
    ];
    // v74: fixture security_events untuk globe /uptime
    this.securityEvents = [
      { id: 1, ts: nowT - 3600 * 1000, kind: 'login_gagal', country: 'US', city: 'Ashburn' },
      { id: 2, ts: nowT - 1800 * 1000, kind: 'rate_limit', country: 'CN', city: 'Beijing' },
      { id: 3, ts: nowT - 900 * 1000, kind: 'login_gagal', country: 'RU', city: 'Moscow' },
    ];
    this.securityEventSeq = 3;
    // v1.0.33: laporan tamper FB Manager (tabel app_tamper_reports)
    this.tamperReports = [];
    // v86: fixture gambar + versi Cerpen (tabel cerpen_images + cerpen_version, D1 stopwatch-db)
    this.cerpenImages = [{ path: 'covers/cover_01.jpg.enc', data: 'GAMBAR-ENKRIPSI-UJI', sha256: 'abc123', size: 20 }];
    this.cerpenVersion = [{ key: 'latest', tag: 'v1.1.29', version: '1.1.29', apk_url: 'https://example.com/cerpen-1.1.29.apk', published_at: '2026-11-13T19:00:00+07:00' }];
    // v87: state Sistem Koin Cerpen (cms-db) — dompet, unlock, voucher, VIP,
    // ban, pantauan, ledger, audit + tabel pelacak baca v81 (dipakai papan
    // peringkat/riwayat). BACKUP_DB memakai instance MockDB yang sama,
    // jadi fixture konten Cerpen di atas juga melayani resolveVoucherEpisodes.
    this.coinWallets = new Map(); // owner_key -> {owner_key, owner_type, user_id, device_id, balance}
    this.coinDevices = new Map(); // device_id -> {device_id, user_id, android_id, label, first_seen, last_seen}
    this.coinUnlocks = []; // {owner_key, kind, target_id, season, no, created_at}
    this.coinLedger = []; // {id, owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at}
    this.coinBatches = new Map(); // batch_id -> {batch_id, reward_type, reward_coins, reward_value, reward_target_kind, reward_target_id, reward_season, reward_no, total_max, per_device_max, valid_from, expires_at, redeemed_count, active, note, created_at}
    this.coinVouchers = new Map(); // code_hash -> {code_hash, batch_id, code_prefix, redeemed_count, active, created_at}
    this.coinRedemptions = []; // {id, code_hash, owner_key, device_id, user_id, created_at}
    this.coinPricing = new Map(); // kind:target -> {kind, target_id, price, free_episodes}
    this.coinAudit = []; // {id, created_at, action, target_type, target_id, note}
    this.coinBans = []; // {id, target_type, target_id, reason, banned_by, created_at, expires_at, active, unbanned_at, unbanned_by, unban_note}
    this.coinWatch = new Map(); // device_id -> {device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at}
    this.coinEvents = []; // {id, kind, device_id, android_id, user_id, detail, created_at}
    this.coinVip = new Map(); // user_id -> {user_id, expires_at, granted_by, reason, created_at}
    // v81: agregat waktu baca (sudah ada array-nya di constructor; isi di
    // sini hanya penegas — handler upsert ada di bawah).
    this.readingSessions = this.readingSessions || [];
    this.readingHours = this.readingHours || [];
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { this.batchCalls = (this.batchCalls || 0) + 1; for (const s of stmts) await s.run(); }
  exec(sql, a, mode) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return [];
    if (s.startsWith('CREATE INDEX') || s.startsWith('CREATE UNIQUE INDEX')) return [];
    if (s.startsWith('PRAGMA table_info(cms_posts)')) return [{ name: 'id' }, { name: 'slug' }, { name: 'title' }, { name: 'body' }, { name: 'category' }, { name: 'status' }, { name: 'created_at' }, { name: 'updated_at' }, { name: 'body_mode' }, { name: 'visibility' }, { name: 'publish_at' }, { name: 'post_password_hash' }, { name: 'post_password_salt' }, { name: 'views' }, { name: 'tags' }];
    if (s.startsWith('PRAGMA table_info(cms_comments)')) return [{ name: 'id' }, { name: 'post_id' }, { name: 'name' }, { name: 'text' }, { name: 'status' }, { name: 'created_at' }, { name: 'parent_id' }];
    // v83: kolom email/email_verified BELUM ada di mock — jalur migrasi ALTER teruji.
    if (s.startsWith('PRAGMA table_info(cms_users)')) return [{ name: 'id' }, { name: 'username' }, { name: 'password_hash' }, { name: 'salt' }, { name: 'created_at' }];
    if (s.startsWith('ALTER TABLE')) return [];
    if (s.startsWith('INSERT OR IGNORE INTO cms_settings')) {
      // SQL worker memakai kunci literal di VALUES, bukan bind: ('theme', 'terang')
      const m = s.match(/VALUES \('([^']+)', '([^']+)'\)/);
      if (m && !this.settings.has(m[1])) this.settings.set(m[1], m[2]);
      return [];
    }
    if (s.startsWith('INSERT OR REPLACE INTO cms_settings')) {
      // SQL worker: VALUES ('theme', ?) dengan nilai di-bind sebagai a[0]
      const m = s.match(/VALUES \('([^']+)',/);
      if (m) this.settings.set(m[1], a[0]);
      return [];
    }
    if (s.startsWith('INSERT OR IGNORE INTO cms_plugins')) { if (!this.plugins.has(a[0])) this.plugins.set(a[0], 1); return []; }
    if (s.startsWith('INSERT INTO cms_posts')) {
      const isSeed = s.includes("'text', 'public'");
      this.posts.push({ id: a[0], slug: a[1], title: a[2], body: a[3], category: a[4], status: 'published', created_at: a[5], updated_at: a[6], body_mode: isSeed ? 'text' : (a[7] || 'text'), visibility: isSeed ? 'public' : (a[8] || 'public'), publish_at: isSeed ? a[7] : (a[9] || a[5]), post_password_hash: isSeed ? '' : (a[10] || ''), post_password_salt: isSeed ? '' : (a[11] || ''), views: 0, tags: isSeed ? '' : (a[12] || '') });
      return [];
    }
    if (s.startsWith('INSERT INTO cms_comments')) { this.comments.push({ id: ++this.commentSeq, post_id: a[0], name: a[1], text: a[2], status: a[3], created_at: a[4], parent_id: a[5] || null }); return []; }
    if (s.startsWith('INSERT INTO cms_users')) { this.users.set(a[0], { id: a[0], username: a[1], password_hash: a[2], salt: a[3], created_at: a[4], email: a[5] ?? null, email_verified: a[6] ?? 0 }); return []; }
    if (s.startsWith('SELECT * FROM cms_users WHERE email')) return [...this.users.values()].filter(u => u.email === a[0]);
    if (s.startsWith('SELECT id FROM cms_users WHERE email')) return [...this.users.values()].filter(u => u.email === a[0]).map(u => ({ id: u.id }));
    if (s === 'UPDATE cms_users SET email_verified = 1 WHERE email IS NULL') { for (const u of this.users.values()) if (!u.email) u.email_verified = 1; return []; }
    if (s.startsWith('UPDATE cms_users SET email_verified = 1 WHERE email = ?')) { for (const u of this.users.values()) if (u.email === a[0]) u.email_verified = 1; return []; }
    // v83: tabel kode OTP (satu kode aktif per email).
    if (s.startsWith('INSERT OR REPLACE INTO cms_otp_codes')) { this.otpCodes.set(a[0], { email: a[0], code_hash: a[1], expires_at: a[2], attempts: 0, created_at: a[3] }); return []; }
    if (s.startsWith('SELECT * FROM cms_otp_codes WHERE email')) return this.otpCodes.has(a[0]) ? [this.otpCodes.get(a[0])] : [];
    if (s.startsWith('UPDATE cms_otp_codes SET attempts = attempts + 1 WHERE email')) { const row = this.otpCodes.get(a[0]); if (row) row.attempts = Number(row.attempts) + 1; return []; }
    if (s.startsWith('DELETE FROM cms_otp_codes WHERE email')) { this.otpCodes.delete(a[0]); return []; }
    if (s.startsWith('SELECT * FROM cms_users WHERE username')) return [...this.users.values()].filter(u => u.username === a[0]);
    if (s.startsWith('SELECT id FROM cms_users WHERE username')) return [...this.users.values()].filter(u => u.username === a[0]).map(u => ({ id: u.id }));
    if (s.startsWith('SELECT id, slug, visibility, publish_at FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ id: p.id, slug: p.slug, visibility: p.visibility, publish_at: p.publish_at }));
    if (s.startsWith('SELECT * FROM cms_users WHERE id')) return [...this.users.values()].filter(u => u.id === a[0]);
    if (s.startsWith('SELECT * FROM cms_users ORDER BY created_at DESC')) {
      const all = [...this.users.values()].sort((x, y) => y.created_at.localeCompare(x.created_at));
      if (s.includes('LIMIT ? OFFSET ?')) return all.slice(a[1], a[1] + a[0]);
      return all;
    }
    if (s.startsWith('SELECT * FROM cms_users ORDER BY created_at ASC')) return [...this.users.values()].sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('DELETE FROM cms_users')) { this.users.delete(a[0]); return []; }
    // UPSERT rate-limit atomik (meniru meta.changes D1): naik hanya bila
    // masih di bawah batas (a[2]); yang ditolak tidak menambah counter.
    // Nilai disimpan {count, window_start} supaya prune bisa menghapus
    // bucket lama.
    if (s.startsWith('INSERT INTO cms_rate_limits')) {
      const cur = this.rateLimits.get(a[0]);
      const n = cur ? cur.count : 0;
      if (n < a[2]) { this.rateLimits.set(a[0], { count: n + 1, window_start: a[1] }); return { changes: 1 }; }
      return { changes: 0 };
    }
    if (s.startsWith('DELETE FROM cms_rate_limits')) {
      const old = [...this.rateLimits.entries()].filter(([, v]) => String(v.window_start || '') < a[0]).sort((x, y) => x[0].localeCompare(y[0])).slice(0, a[1]);
      for (const [k] of old) this.rateLimits.delete(k);
      return { changes: old.length };
    }
    if (s.startsWith('SELECT id, slug, visibility, publish_at, post_password_hash, post_password_salt FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ id: p.id, slug: p.slug, visibility: p.visibility, publish_at: p.publish_at, post_password_hash: p.post_password_hash, post_password_salt: p.post_password_salt }));
    if (s.startsWith('UPDATE cms_posts SET views')) { const p = this.posts.find(x => x.id === a[0]); if (p) p.views = (p.views || 0) + 1; return []; }
    if (s.startsWith('SELECT id, post_id FROM cms_comments WHERE id')) return this.comments.filter(c => c.id === a[0]).map(c => ({ id: c.id, post_id: c.post_id }));
    if (s.startsWith('SELECT id FROM cms_comments WHERE post_id')) return this.comments.filter(c => c.post_id === a[0]).map(c => ({ id: c.id }));
    if (s.startsWith('SELECT vote FROM cms_comment_votes')) return a.length === 1 ? this.votes.filter(v => v.comment_id === a[0]).map(v => ({ vote: v.vote })) : this.votes.filter(v => v.comment_id === a[0] && v.user_key === a[1]).map(v => ({ vote: v.vote }));
    if (s.startsWith('INSERT INTO cms_comment_votes')) { this.votes.push({ comment_id: a[0], user_key: a[1], vote: a[2] }); return []; }
    if (s.startsWith('UPDATE cms_comment_votes')) { const v = this.votes.find(x => x.comment_id === a[1] && x.user_key === a[2]); if (v) v.vote = a[0]; return []; }
    if (s.startsWith('DELETE FROM cms_comment_votes WHERE comment_id = ? AND user_key = ?')) { this.votes = this.votes.filter(v => !(v.comment_id === a[0] && v.user_key === a[1])); return []; }
    if (s.startsWith('DELETE FROM cms_comment_votes WHERE comment_id = ?')) { this.votes = this.votes.filter(v => v.comment_id !== a[0]); return []; }
    if (s.startsWith('SELECT comment_id, vote, COUNT(*) AS n FROM cms_comment_votes')) {
      const groups = new Map();
      for (const v of this.votes) { const k = v.comment_id + ':' + v.vote; groups.set(k, (groups.get(k) || 0) + 1); }
      return [...groups.entries()].map(([k, n]) => { const [comment_id, vote] = k.split(':'); return { comment_id: Number(comment_id), vote: Number(vote), n }; });
    }
    if (s.startsWith('SELECT comment_id, vote FROM cms_comment_votes WHERE user_key')) return this.votes.filter(v => v.user_key === a[0]).map(v => ({ comment_id: v.comment_id, vote: v.vote }));
    if (s.startsWith('SELECT * FROM cms_comment_votes ORDER')) return [...this.votes].sort((x, y) => x.comment_id - y.comment_id);
    if (s.startsWith('INSERT INTO cms_login_attempts')) { this.attempts.push({ id: ++this.attemptSeq, ip: a[0], created_at: a[1] }); return []; }
    if (s.startsWith('SELECT COUNT(*) AS n FROM cms_login_attempts')) return [{ n: this.attempts.filter(x => x.ip === a[0] && x.created_at > a[1]).length }];
    if (s.startsWith('DELETE FROM cms_login_attempts')) {
      // Login admin sukses: hapus semua jejak IP itu.
      if (s.includes('WHERE ip = ?')) { this.attempts = this.attempts.filter(x => x.ip !== a[0]); return []; }
      // Prune retensi: hapus yang lebih tua dari cutoff, bertahap.
      const old = this.attempts.filter(x => String(x.created_at || '') < a[0]).sort((x, y) => (x.id || 0) - (y.id || 0)).slice(0, a[1]);
      const ids = new Set(old.map(x => x.id));
      this.attempts = this.attempts.filter(x => !ids.has(x.id));
      return { changes: old.length };
    }
    if (s.startsWith('INSERT INTO cms_refresh_tokens')) { this.refreshTokens.push({ id: a[0], token_hash: a[1], device: a[2], ip: a[3], created_at: a[4], last_used_at: a[5], expires_at: a[6], revoked: 0, replaced_by: '', remember: a[7] }); return []; }
    if (s.startsWith('SELECT * FROM cms_refresh_tokens WHERE token_hash')) return this.refreshTokens.filter(x => x.token_hash === a[0]);
    if (s.startsWith('SELECT * FROM cms_refresh_tokens WHERE id')) return this.refreshTokens.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT id, device, ip, created_at, last_used_at, expires_at FROM cms_refresh_tokens')) return this.refreshTokens.filter(x => x.revoked === 0 && x.expires_at > a[0]).sort((x, y) => y.last_used_at.localeCompare(x.last_used_at)).slice(0, 50);
    if (s.startsWith('UPDATE cms_refresh_tokens SET revoked = 1, replaced_by = ? WHERE id = ?')) { const rr = this.refreshTokens.find(x => x.id === a[1]); if (rr) { rr.revoked = 1; rr.replaced_by = a[0]; } return []; }
    if (s.startsWith('UPDATE cms_refresh_tokens SET revoked = 1 WHERE id = ?')) { const rr = this.refreshTokens.find(x => x.id === a[0]); if (rr) rr.revoked = 1; return []; }
    if (s.startsWith('UPDATE cms_refresh_tokens SET revoked = 1 WHERE revoked = 0')) { this.refreshTokens.forEach(x => x.revoked = 1); return []; }
    if (s.startsWith('INSERT INTO cms_backup_runs')) {
      const status = (s.match(/'(BERHASIL|GAGAL)'/) || [])[1] || 'GAGAL';
      this.backupRuns.push(status === 'BERHASIL'
        ? { created_at: a[0], status, posts: a[1], comments: a[2], error: '' }
        : { created_at: a[0], status, posts: 0, comments: 0, error: a[1] });
      return [];
    }
    if (s.startsWith('SELECT * FROM cms_backup_runs')) return [...this.backupRuns].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 10);
    // Mock backup DB: tabel cms_backup_* disimpan di objek yang sama, cukup terima tulisnya
    if (s.startsWith('CREATE TABLE IF NOT EXISTS cms_backup')) return [];
    if (s.startsWith('DELETE FROM cms_backup')) return [];
    if (s.startsWith('INSERT INTO cms_backup_posts')) { this.backupPosts = (this.backupPosts || 0) + 1; return []; }
    // v1.0.33: laporan tamper FB Manager (app_tamper_reports).
    if (s.startsWith('INSERT INTO app_tamper_reports')) { this.tamperReports.push({ id: this.tamperReports.length + 1, package_found: a[0], label_found: a[1], signer_found: a[2], version_code: a[3], version_name: a[4], device_model: a[5], android_version: a[6], created_at: a[7] }); return []; }
    if (s.startsWith('SELECT id, package_found, label_found, signer_found, version_code, version_name, device_model, android_version, created_at FROM app_tamper_reports')) { const all = [...this.tamperReports].sort((x, y) => (y.created_at || 0) - (x.created_at || 0)); return all.slice(0, a[0]); }
    if (s.startsWith('INSERT INTO cms_backup_comments')) { this.backupComments = (this.backupComments || 0) + 1; return []; }
    if (s.startsWith('INSERT INTO cms_backup_settings')) { (this.backupSettings = this.backupSettings || []).push({ key: a[0], value: a[1], backup_at: a[2] }); return []; }
    if (s.startsWith('INSERT INTO cms_backup_plugins') || s.startsWith('INSERT INTO cms_backup_users') || s.startsWith('INSERT INTO cms_backup_votes')) return [];
    if (s === 'SELECT COUNT(*) AS n FROM cms_posts') return [{ n: this.posts.length }];
    if (s === 'SELECT COUNT(*) AS n FROM cms_comments') return [{ n: this.comments.length }];
    if (s === 'SELECT COUNT(*) AS n FROM cms_users') return [{ n: this.users.size }];
    if (s === 'SELECT COUNT(*) AS n, COALESCE(SUM(views), 0) AS v FROM cms_posts') return [{ n: this.posts.length, v: this.posts.reduce((a, p) => a + (Number(p.views) || 0), 0) }];
    if (s.startsWith('SELECT value FROM cms_settings')) return this.settings.has(a[0]) ? [{ value: this.settings.get(a[0]) }] : [];
    if (s.startsWith('SELECT * FROM cms_settings ORDER')) return [...this.settings.entries()].map(([key, value]) => ({ key, value })).sort((x, y) => x.key.localeCompare(y.key));
    if (s.startsWith('SELECT * FROM cms_plugins ORDER')) return [...this.plugins.entries()].map(([id, enabled]) => ({ id, enabled })).sort((x, y) => x.id.localeCompare(y.id));
    if (s.startsWith('SELECT * FROM cms_plugins') || s.startsWith('SELECT id, enabled FROM cms_plugins')) return [...this.plugins.entries()].map(([id, enabled]) => ({ id, enabled }));
    if (s.startsWith('SELECT * FROM cms_posts WHERE status') && s.includes('ORDER BY views DESC')) {
      const all = [...this.posts].filter(p => p.status === 'published' && p.visibility === 'public' && String(p.publish_at || p.created_at) <= a[0]).sort((x, y) => (y.views || 0) - (x.views || 0));
      return all.slice(0, 10);
    }
    if (s.startsWith('SELECT * FROM cms_posts WHERE status')) {
      if (s.includes("visibility = 'public'")) {
        const all = [...this.posts].filter(p => p.status === 'published' && p.visibility === 'public' && String(p.publish_at || p.created_at) <= a[0]).sort((x, y) => String(y.publish_at || y.created_at).localeCompare(String(x.publish_at || x.created_at)));
        if (s.includes('LIMIT 200')) return all.slice(0, 200);
        if (s.includes('LIMIT')) return all.slice(Number(a[1]) || 0, (Number(a[1]) || 0) + 11);
        return all;
      }
      return [...this.posts].filter(p => p.status === 'published').sort((x, y) => y.created_at.localeCompare(x.created_at));
    }
    if (s.startsWith('SELECT * FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ ...p }));
    if (s.startsWith('SELECT * FROM cms_posts WHERE id')) return this.posts.filter(p => p.id === a[0]).map(p => ({ ...p }));
    if (s.startsWith('UPDATE cms_posts SET title')) { const pp = this.posts.find(x => x.id === a[10]); if (pp) { pp.title=a[0]; pp.body=a[1]; pp.category=a[2]; pp.updated_at=a[3]; pp.body_mode=a[4]; pp.visibility=a[5]; pp.publish_at=a[6]; pp.post_password_hash=a[7]; pp.post_password_salt=a[8]; pp.tags=a[9]; } return []; }
    if (s.startsWith('SELECT * FROM cms_posts WHERE category')) {
      if (s.includes("visibility = 'public'")) return [...this.posts].filter(p => p.category === a[0] && p.status === 'published' && p.visibility === 'public' && String(p.publish_at || p.created_at) <= a[1]).sort((x, y) => String(y.publish_at || y.created_at).localeCompare(String(x.publish_at || x.created_at)));
      return [...this.posts].filter(p => p.category === a[0] && p.status === 'published').sort((x, y) => y.created_at.localeCompare(x.created_at));
    }
    if (s.startsWith('SELECT * FROM cms_posts ORDER')) {
      if (s.includes('ORDER BY views DESC')) {
        const all = [...this.posts].sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
        const m = s.match(/LIMIT (\d+)/);
        return m ? all.slice(0, Number(m[1])) : all;
      }
      const all = [...this.posts].sort((x, y) => y.created_at.localeCompare(x.created_at));
      if (s.includes('LIMIT ? OFFSET ?')) return all.slice(a[1], a[1] + a[0]);
      return all;
    }
    if (s.startsWith('SELECT id FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ id: p.id }));
    if (s.startsWith('SELECT * FROM cms_comments WHERE post_id')) return this.comments.filter(c => c.post_id === a[0] && c.status === 'approved').sort((x, y) => x.created_at.localeCompare(y.created_at));
    // v82: panel admin butuh slug postingan untuk tautan teleport ke komentar
    if (s.startsWith('SELECT c.*, p.slug AS post_slug FROM cms_comments')) {
      const all = [...this.comments].sort((x, y) => y.created_at.localeCompare(x.created_at)).map(c => ({ ...c, post_slug: (this.posts.find(p => p.id === c.post_id) || {}).slug || null }));
      if (s.includes('LIMIT ? OFFSET ?')) return all.slice(a[1], a[1] + a[0]);
      return all;
    }
    if (s.startsWith('SELECT * FROM cms_comments ORDER')) {
      const all = [...this.comments].sort((x, y) => y.created_at.localeCompare(x.created_at));
      if (s.includes('LIMIT ? OFFSET ?')) return all.slice(a[1], a[1] + a[0]);
      return all;
    }
    if (s.startsWith('INSERT INTO cms_view_events')) { this.viewEvents.push({ id: ++this.viewEventSeq, post_id: a[0], viewed_at: a[1] }); return []; }
    // v74: security_events (globe /uptime)
    if (s.startsWith('INSERT INTO security_events')) { this.securityEvents.push({ id: ++this.securityEventSeq, ts: a[0], kind: a[1], country: a[2], city: a[3] }); return []; }
    if (s.startsWith('DELETE FROM security_events')) {
      const keep = [...this.securityEvents].sort((x, y) => (y.id || 0) - (x.id || 0)).slice(0, 500);
      const removed = this.securityEvents.length - keep.length;
      this.securityEvents = keep;
      return { changes: removed };
    }
    if (s.startsWith('SELECT country, kind, ts FROM security_events')) {
      const evs = this.securityEvents.filter(e => Number(e.ts || 0) >= a[0] && String(e.country || '') !== '');
      return evs.sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 200);
    }
    if (s.startsWith('DELETE FROM cms_view_events')) {
      const old = this.viewEvents.filter(e => String(e.viewed_at || '') < a[0]).sort((x, y) => (x.id || 0) - (y.id || 0)).slice(0, a[1]);
      const ids = new Set(old.map(e => e.id));
      this.viewEvents = this.viewEvents.filter(e => !ids.has(e.id));
      return { changes: old.length };
    }
    if (s.startsWith('INSERT INTO cms_loadtest_runs')) { this.loadtestRuns.push({ id: a[0], created_at: a[1], vu: a[2], duration_s: a[3], p95_ms: a[4], failed_rate: a[5], passed: a[6], details: a[7] }); return []; }
    if (s.startsWith('SELECT * FROM cms_loadtest_runs ORDER BY created_at DESC')) return [...this.loadtestRuns].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 10);
    if (s.startsWith('SELECT * FROM cms_loadtest_runs ORDER BY created_at ASC')) return [...this.loadtestRuns].sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('INSERT INTO cms_backup_loadtest_runs')) { this.backupLoadtests = (this.backupLoadtests || 0) + 1; return []; }
    if (s.startsWith('SELECT post_id, viewed_at FROM cms_view_events')) {
      let evs = [...this.viewEvents];
      if (s.includes('WHERE viewed_at >= ?')) evs = evs.filter(e => String(e.viewed_at || '') >= a[0]);
      return evs.sort((x, y) => y.viewed_at.localeCompare(x.viewed_at));
    }
    if (s.startsWith('SELECT * FROM cms_comments WHERE id')) return this.comments.filter(c => c.id === a[0]);
    if (s.startsWith('UPDATE cms_comments SET text')) { const c = this.comments.find(x => x.id === a[1]); if (c) { c.text = a[0]; if (s.includes("status = 'pending'")) c.status = 'pending'; } return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned = 0 WHERE post_id')) { this.comments.filter(c => c.post_id === a[0] && c.id !== a[1]).forEach(c => { c.pinned = 0; }); return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned = 1')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.pinned = 1; return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned = 0')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.pinned = 0; return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned')) { const c = this.comments.find(x => x.id === a[1]); if (c) c.pinned = a[0]; return []; }
    if (s.startsWith('UPDATE cms_comments SET status')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.status = s.includes("status = 'pending'") ? 'pending' : 'approved'; return []; }
    if (s.startsWith('UPDATE cms_plugins SET enabled')) { this.plugins.set(a[1], a[0]); return []; }
    if (s.startsWith('DELETE FROM cms_posts')) { this.posts = this.posts.filter(p => p.id !== a[0]); return []; }
    if (s.startsWith('DELETE FROM cms_comments')) { this.comments = this.comments.filter(c => c.id !== a[0]); return []; }
    // ---- Port 11 Nov 2026: API Dracin + H2 backup ----
    if (s.startsWith('SELECT key, value FROM cms_settings WHERE key NOT IN')) {
      const skip = new Set(['imgbb_api_keys', 'imgbb_api_key', 'csrf_secret']);
      return [...this.settings.entries()].filter(([k]) => !skip.has(k)).map(([key, value]) => ({ key, value })).sort((x, y) => x.key.localeCompare(y.key));
    }
    if (s.startsWith('SELECT id, username, created_at FROM cms_users ORDER BY created_at ASC')) return [...this.users.values()].sort((x, y) => x.created_at.localeCompare(y.created_at)).map(u => ({ id: u.id, username: u.username, created_at: u.created_at }));
    if (s.startsWith('SELECT * FROM dracin_api_keys WHERE key_hash')) return this.dracinKeys.filter(k => k.key_hash === a[0]);
    if (s.startsWith('SELECT * FROM dracin_api_keys ORDER BY created_at DESC')) return [...this.dracinKeys].sort((x, y) => y.created_at - x.created_at);
    if (s.startsWith('SELECT * FROM dracin_api_keys ORDER BY created_at ASC')) return [...this.dracinKeys].sort((x, y) => x.created_at - y.created_at);
    if (s === 'SELECT COUNT(*) AS n FROM dracin_api_usage') return [{ n: this.dracinUsage.length }];
    if (s.startsWith('SELECT * FROM dracin_api_usage ORDER BY ts DESC LIMIT 5000')) return [...this.dracinUsage].sort((x, y) => y.ts - x.ts).slice(0, 5000);
    if (s.startsWith('SELECT * FROM dracin_api_usage ORDER BY ts ASC')) return [...this.dracinUsage].sort((x, y) => x.ts - y.ts);
    if (s.startsWith('SELECT * FROM dracin_catalog ORDER BY updated_at DESC')) {
      let rows = [...this.dracinCatalog].sort((x, y) => y.updated_at - x.updated_at);
      let limit, offset;
      if (s.includes('WHERE platform = ?')) { rows = rows.filter(t => t.platform === a[0]); limit = a[1]; offset = a[2]; }
      else { limit = a[0]; offset = a[1]; }
      return rows.slice(offset, offset + limit);
    }
    if (s.startsWith('SELECT * FROM dracin_catalog ORDER BY platform ASC, title_id ASC')) return [...this.dracinCatalog].sort((x, y) => (x.platform + x.title_id).localeCompare(y.platform + y.title_id));
    if (s.startsWith('SELECT * FROM dracin_catalog WHERE platform')) return this.dracinCatalog.filter(t => t.platform === a[0] && t.title_id === a[1]);
    if (s.startsWith('SELECT * FROM dracin_episodes ORDER BY platform ASC, title_id ASC, idx ASC')) return [...this.dracinEpisodes].sort((x, y) => (x.platform + x.title_id + x.idx).localeCompare(y.platform + y.title_id + y.idx));
    if (s.startsWith('SELECT * FROM dracin_seeds WHERE enabled = 1')) return this.dracinSeeds.filter(x => Number(x.enabled) === 1).sort((x, y) => (x.platform + x.query).localeCompare(y.platform + y.query));
    if (s.startsWith('SELECT * FROM dracin_seeds ORDER BY platform ASC, query ASC')) return [...this.dracinSeeds].sort((x, y) => (x.platform + x.query).localeCompare(y.platform + y.query));
    if (s.startsWith('SELECT * FROM dracin_seeds WHERE platform')) return this.dracinSeeds.filter(x => x.platform === a[0] && x.query === a[1]);
    if (s.startsWith('SELECT * FROM hacklab_lessons')) return [];
    // v62: mock tabel konten Cerpen (dipakai endpoint /api/c/*/cerpen/*)
    if (s.startsWith('SELECT key, value FROM cerpen_manifest')) return this.cerpenManifest;
    // v86: mock tabel gambar + versi Cerpen (dipakai /api/cerpen-img/* + /api/cerpen-version)
    if (s.startsWith('SELECT data FROM cerpen_images WHERE path = ?')) return this.cerpenImages.filter(x => x.path === a[0]);
    if (s.startsWith('SELECT tag, version, apk_url, published_at FROM cerpen_version WHERE key = ?')) return this.cerpenVersion.filter(x => x.key === a[0]);
    if (s.startsWith('SELECT id, judul, genre, deskripsi, cover_url, status FROM cerpen_series')) return this.cerpenSeries;
    // v63: dump penuh `all` — cek dulu (prefix sama dengan endpoint satuan, tanpa WHERE)
    if (s.startsWith('SELECT series_id, season, no, judul, isi_cipher, word_count FROM cerpen_episodes') && s.includes('ORDER BY series_id ASC')) return this.cerpenEpisodes;
    if (s.startsWith('SELECT komik_id, no, judul, panels_cipher, panels_count FROM cerpen_komik_episodes') && s.includes('ORDER BY komik_id ASC')) return this.cerpenKomikEpisodes;
    if (s.startsWith('SELECT id, title, summary, source_name, source_url, image_url, images_json, details_json, topic, published_at, added_at FROM cerpen_news')) return this.cerpenNews;
    if (s.startsWith('SELECT no, judul, word_count FROM cerpen_episodes')) return this.cerpenEpisodes.filter(e => e.series_id === a[0] && e.season === a[1]).map(e => ({ no: e.no, judul: e.judul, word_count: e.word_count }));
    if (s.startsWith('SELECT series_id, season, no, judul, isi_cipher, word_count FROM cerpen_episodes')) return this.cerpenEpisodes.filter(e => e.series_id === a[0] && e.season === a[1] && e.no === a[2]);
    if (s.startsWith('SELECT id, judul, genre, deskripsi, cover_url FROM cerpen_komik')) return this.cerpenKomik;
    if (s.startsWith('SELECT no, judul, panels_count FROM cerpen_komik_episodes')) return this.cerpenKomikEpisodes.filter(e => e.komik_id === a[0]).map(e => ({ no: e.no, judul: e.judul, panels_count: e.panels_count }));
    if (s.startsWith('SELECT komik_id, no, judul, panels_cipher, panels_count FROM cerpen_komik_episodes')) return this.cerpenKomikEpisodes.filter(e => e.komik_id === a[0] && e.no === a[1]);
    if (s.startsWith('SELECT id, title, summary, source_name, source_url, image_url, topic, published_at, added_at FROM cerpen_news')) {
      let rows = [...this.cerpenNews];
      if (s.includes('WHERE added_at > ?')) { rows = rows.filter(n => n.added_at > a[0]); return rows.slice(0, a[1]); }
      return rows.slice(0, a[0]);
    }
    // v66: pola SQL endpoint admin Cerpen (/api/admin/cerpen-*) + halaman /kendali/cerpen-api
    if (s.startsWith('SELECT key_id, key_hash, name, created_at, revoked, daily_limit, auto_approve_mode, auto_approve_until FROM cerpen_api_keys ORDER BY created_at DESC')) return [...this.cerpenApiKeys].sort((x, y) => y.created_at - x.created_at);
    if (s.startsWith('SELECT key_id, COUNT(*) AS total, SUM(CASE WHEN status = \'pending\' THEN 1 ELSE 0 END) AS pending FROM cerpen_submissions GROUP BY key_id')) {
      const map = new Map();
      for (const x of this.cerpenSubmissions) {
        const e = map.get(x.key_id) || { key_id: x.key_id, total: 0, pending: 0 };
        e.total++; if (x.status === 'pending') e.pending++;
        map.set(x.key_id, e);
      }
      return [...map.values()];
    }
    if (s.startsWith('SELECT key_id FROM cerpen_api_keys WHERE key_hash = ?')) return this.cerpenApiKeys.filter(k => k.key_hash === a[0]);
    if (s.startsWith('SELECT key_id FROM cerpen_api_keys WHERE key_id = ?')) return this.cerpenApiKeys.filter(k => k.key_id === a[0]);
    if (s.startsWith('INSERT INTO cerpen_api_keys')) { this.cerpenApiKeys.push({ key_id: a[0], key_hash: a[1], name: a[2], created_at: a[3], revoked: 0, daily_limit: a[4] }); return []; }
    if (s.startsWith('INSERT INTO md_backup_keys')) { this.mdBackupKeys.push({ key_id: a[0], key_hash: a[1], name: a[2], created_at: a[3], revoked: 0, daily_limit: a[4] }); return []; }
    if (s.startsWith('UPDATE cerpen_api_keys SET daily_limit = ?')) { const k = this.cerpenApiKeys.find(x => x.key_id === a[1]); if (k) k.daily_limit = a[0]; return []; }
    if (s.startsWith('UPDATE cerpen_api_keys SET revoked = ?')) { const k = this.cerpenApiKeys.find(x => x.key_id === a[1]); if (k) k.revoked = a[0]; return []; }
    if (s.startsWith('DELETE FROM cerpen_api_keys')) { this.cerpenApiKeys = this.cerpenApiKeys.filter(k => k.key_id !== a[0]); return []; }
    if (s.startsWith('SELECT status, COUNT(*) AS c FROM cerpen_submissions GROUP BY status')) {
      const map = new Map();
      for (const x of this.cerpenSubmissions) map.set(x.status, (map.get(x.status) || 0) + 1);
      return [...map.entries()].map(([status, c]) => ({ status, c }));
    }
    if (s.startsWith('SELECT key_id, status, COUNT(*) AS c FROM cerpen_submissions GROUP BY key_id, status')) {
      const map = new Map();
      for (const x of this.cerpenSubmissions) { const k = x.key_id + '|' + x.status; map.set(k, (map.get(k) || 0) + 1); }
      return [...map.entries()].map(([k, c]) => { const [key_id, status] = k.split('|'); return { key_id, status, c }; });
    }
    if (s === 'SELECT COUNT(*) AS c FROM cerpen_submissions') return [{ c: this.cerpenSubmissions.length }];
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_submissions WHERE created_at >= ?')) return [{ c: this.cerpenSubmissions.filter(x => x.created_at >= a[0]).length }];
    if (s.startsWith('SELECT id, key_id, kind, target_id, title, status, created_at, reviewed_at, review_note FROM cerpen_submissions WHERE 1 = 1')) {
      let rows = [...this.cerpenSubmissions];
      let i = 0;
      if (s.includes('AND status = ?')) { const v = a[i++]; rows = rows.filter(x => x.status === v); }
      if (s.includes('AND key_id = ?')) { const v = a[i++]; rows = rows.filter(x => x.key_id === v); }
      if (s.includes('AND kind = ?')) { const v = a[i++]; rows = rows.filter(x => x.kind === v); }
      const limit = a[i];
      rows.sort((x, y) => y.created_at - x.created_at);
      // D1 nyata hanya mengembalikan kolom yang di-SELECT (tanpa payload_json).
      return rows.slice(0, limit).map(x => ({ id: x.id, key_id: x.key_id, kind: x.kind, target_id: x.target_id, title: x.title, status: x.status, created_at: x.created_at, reviewed_at: x.reviewed_at, review_note: x.review_note }));
    }
    if (s.startsWith('SELECT id, key_id, kind, target_id, title, dedup_hash, payload_json, status, created_at, reviewed_at, review_note FROM cerpen_submissions WHERE id = ?')) return this.cerpenSubmissions.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT id, status FROM cerpen_submissions WHERE id = ?')) return this.cerpenSubmissions.filter(x => x.id === a[0]).map(x => ({ id: x.id, status: x.status }));
    if (s.startsWith('UPDATE cerpen_submissions SET status = ?')) { const x = this.cerpenSubmissions.find(v => v.id === a[3] && v.status === 'pending'); if (x) { x.status = a[0]; x.reviewed_at = a[1]; x.review_note = a[2]; } return []; }
    // v68: pola SQL auto-approve + endpoint submit Cerpen (POST /api/cerpen-submit)
    if (s.startsWith('SELECT key_id, key_hash, name, revoked, daily_limit, auto_approve_mode, auto_approve_until FROM cerpen_api_keys WHERE key_hash = ?')) return this.cerpenApiKeys.filter(k => k.key_hash === a[0]);
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_submissions WHERE key_id = ? AND created_at >= ?')) return [{ c: this.cerpenSubmissions.filter(x => x.key_id === a[0] && x.created_at >= a[1]).length }];
    if (s.startsWith('SELECT id FROM cerpen_series WHERE id = ?')) return this.cerpenSeries.filter(x => x.id === a[0]).map(x => ({ id: x.id }));
    if (s.startsWith('SELECT judul FROM cerpen_series')) return this.cerpenSeries.map(x => ({ judul: x.judul }));
    if (s.startsWith("SELECT title FROM cerpen_submissions WHERE status IN ('pending','approved')")) return this.cerpenSubmissions.filter(x => x.status === 'pending' || x.status === 'approved').map(x => ({ title: x.title }));
    if (s.startsWith("SELECT id FROM cerpen_submissions WHERE dedup_hash = ? AND status IN ('pending','approved')")) return this.cerpenSubmissions.filter(x => x.dedup_hash === a[0] && (x.status === 'pending' || x.status === 'approved')).map(x => ({ id: x.id }));
    if (s.startsWith('INSERT INTO cerpen_submissions')) { this.cerpenSubmissions.push({ id: a[0], key_id: a[1], kind: a[2], target_id: a[3], title: a[4], dedup_hash: a[5], payload_json: a[6], status: a[7], created_at: a[8], reviewed_at: a[9], review_note: a[10] }); return []; }
    if (s.startsWith('UPDATE cerpen_api_keys SET auto_approve_mode = ?')) { const k = this.cerpenApiKeys.find(x => x.key_id === a[2]); if (k) { k.auto_approve_mode = a[0]; k.auto_approve_until = a[1]; } return []; }
    if (s.startsWith('INSERT INTO cerpen_admin_audit')) { this.cerpenAdminAudit.push({ id: a[0], created_at: a[1], actor: 'admin', action: a[2], target_type: a[3], target_id: a[4], note: a[5] }); return []; }
    if (s.startsWith('SELECT id, created_at, actor, action, target_type, target_id, note FROM cerpen_admin_audit ORDER BY created_at DESC LIMIT 20')) return [...this.cerpenAdminAudit].sort((x, y) => y.created_at - x.created_at).slice(0, 20);
    if (s.startsWith('INSERT INTO dracin_api_usage')) { this.dracinUsage.push({ ts: a[0], key_id: a[1], endpoint: a[2], method: a[3], status: a[4], country: a[5], region: a[6], city: a[7] }); return []; }
    if (s.startsWith('INSERT INTO dracin_api_keys')) { this.dracinKeys.push({ id: a[0], name: a[1], key_hash: a[2], scope: a[3], active: a[4], created_at: a[5] }); return []; }
    if (s.startsWith('UPDATE dracin_api_keys SET active = 0')) { const k = this.dracinKeys.find(x => x.id === a[0]); if (k) k.active = 0; return []; }
    if (s.startsWith('INSERT INTO dracin_catalog')) {
      const ex = this.dracinCatalog.find(t => t.platform === a[0] && t.title_id === a[1]);
      const row = { platform: a[0], title_id: a[1], title: a[2], cover_url: a[3], synopsis: a[4], language: a[5], episode_count: a[6], free_count: a[7], locked_count: a[8], updated_at: a[9] };
      if (ex) Object.assign(ex, row); else this.dracinCatalog.push(row);
      return [];
    }
    if (s.startsWith('INSERT OR REPLACE INTO dracin_episodes')) {
      const ex = this.dracinEpisodes.find(e => e.platform === a[0] && e.title_id === a[1] && e.idx === a[2]);
      const row = { platform: a[0], title_id: a[1], idx: a[2], item_id: a[3], duration_s: a[4], locked: a[5] };
      if (ex) Object.assign(ex, row); else this.dracinEpisodes.push(row);
      return [];
    }
    if (s.startsWith('INSERT OR REPLACE INTO dracin_seeds')) {
      const ex = this.dracinSeeds.find(x => x.platform === a[0] && x.query === a[1]);
      if (ex) ex.enabled = a[2]; else this.dracinSeeds.push({ platform: a[0], query: a[1], enabled: a[2] });
      return [];
    }
    if (s.startsWith('UPDATE dracin_seeds SET enabled')) { const x = this.dracinSeeds.find(v => v.platform === a[1] && v.query === a[2]); if (x) x.enabled = a[0]; return []; }
    if (s.startsWith('DELETE FROM dracin_episodes')) { this.dracinEpisodes = this.dracinEpisodes.filter(e => !(e.platform === a[0] && e.title_id === a[1])); return []; }
    if (s.startsWith('DELETE FROM dracin_catalog')) { this.dracinCatalog = this.dracinCatalog.filter(t => !(t.platform === a[0] && t.title_id === a[1])); return []; }
    if (s.startsWith('DELETE FROM dracin_seeds')) { this.dracinSeeds = this.dracinSeeds.filter(x => !(x.platform === a[0] && x.query === a[1])); return []; }
    if (s.startsWith('INSERT INTO cms_backup_dracin_')) { this.backupDracin = (this.backupDracin || 0) + 1; return []; }
    // v67: pola SQL share link Cerpen (/api/share/*, /s/*, /api/admin/cerpen-shares*, panel)
    if (s.startsWith('SELECT id, judul, genre, deskripsi FROM cerpen_series WHERE id = ?')) return this.cerpenSeries.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT judul FROM cerpen_episodes WHERE series_id = ? AND season = ? AND no = ?')) return this.cerpenEpisodes.filter(e => e.series_id === a[0] && e.season === a[1] && e.no === a[2]).map(e => ({ judul: e.judul }));
    if (s.startsWith('SELECT id, judul, genre, deskripsi FROM cerpen_komik WHERE id = ?')) return this.cerpenKomik.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT judul FROM cerpen_komik_episodes WHERE komik_id = ? AND no = ?')) return this.cerpenKomikEpisodes.filter(e => e.komik_id === a[0] && e.no === a[1]).map(e => ({ judul: e.judul }));
    if (s.startsWith('SELECT id, title, summary, topic FROM cerpen_news WHERE id = ?')) return this.cerpenNews.filter(x => x.id === a[0]);
    if (s.startsWith('INSERT INTO cerpen_share_links')) { this.cerpenShareLinks.push({ id: a[0], content_type: a[1], content_id: a[2], season: a[3], episode_no: a[4], created_at: a[5], sharer_ip: a[6], sharer_country: a[7], sharer_city: a[8], sharer_device: a[9], revoked: 0, opens_count: 0 }); return []; }
    if (s.startsWith('INSERT INTO cerpen_share_opens')) { this.cerpenShareOpens.push({ id: a[0], share_id: a[1], opened_at: a[2], ip: a[3], country: a[4], city: a[5], device: a[6], user_agent: a[7], via: a[8] }); return []; }
    if (s.startsWith('UPDATE cerpen_share_links SET opens_count = opens_count + 1')) { const x = this.cerpenShareLinks.find(v => v.id === a[0]); if (x) x.opens_count = (Number(x.opens_count) || 0) + 1; return []; }
    if (s.startsWith('UPDATE cerpen_share_links SET revoked = ?')) { const x = this.cerpenShareLinks.find(v => v.id === a[1]); if (x) x.revoked = a[0]; return []; }
    if (s === 'SELECT COUNT(*) AS c FROM cerpen_share_links') return [{ c: this.cerpenShareLinks.length }];
    if (s.startsWith('SELECT COALESCE(SUM(opens_count), 0) AS c FROM cerpen_share_links')) return [{ c: this.cerpenShareLinks.reduce((t, x) => t + (Number(x.opens_count) || 0), 0) }];
    if (s.startsWith('SELECT id, content_type, content_id, season, episode_no, revoked FROM cerpen_share_links WHERE id = ?')) return this.cerpenShareLinks.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT id FROM cerpen_share_links WHERE id = ?')) return this.cerpenShareLinks.filter(x => x.id === a[0]).map(x => ({ id: x.id }));
    if (s.startsWith('SELECT id, content_type, content_id, season, episode_no, created_at, sharer_ip, sharer_country, sharer_city, sharer_device, revoked, opens_count FROM cerpen_share_links WHERE id = ?')) return this.cerpenShareLinks.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT id, content_type, content_id, season, episode_no, created_at, sharer_country, sharer_city, sharer_device, revoked, opens_count FROM cerpen_share_links WHERE 1 = 1')) {
      let rows = [...this.cerpenShareLinks];
      let i = 0;
      if (s.includes('AND content_type = ?')) { const v = a[i++]; rows = rows.filter(x => x.content_type === v); }
      if (s.includes('AND revoked = ?')) { const v = a[i++]; rows = rows.filter(x => Number(x.revoked) === v); }
      const limit = a[i];
      rows.sort((x, y) => y.created_at - x.created_at);
      return rows.slice(0, limit);
    }
    if (s.startsWith('SELECT id, content_type, content_id, season, episode_no, created_at, sharer_country, sharer_city, sharer_device, revoked, opens_count FROM cerpen_share_links ORDER BY created_at DESC LIMIT 50')) return [...this.cerpenShareLinks].sort((x, y) => y.created_at - x.created_at).slice(0, 50);
    if (s.startsWith('SELECT content_type, content_id, COUNT(*) AS c, SUM(opens_count) AS opens FROM cerpen_share_links GROUP BY content_type, content_id ORDER BY c DESC LIMIT 10')) {
      const map = new Map();
      for (const x of this.cerpenShareLinks) {
        const k = x.content_type + '|' + x.content_id;
        const e = map.get(k) || { content_type: x.content_type, content_id: x.content_id, c: 0, opens: 0 };
        e.c++; e.opens += Number(x.opens_count) || 0;
        map.set(k, e);
      }
      return [...map.values()].sort((x, y) => y.c - x.c).slice(0, 10);
    }
    if (s.startsWith('SELECT id, share_id, opened_at, ip, country, city, device, user_agent, via FROM cerpen_share_opens WHERE share_id = ?')) return this.cerpenShareOpens.filter(o => o.share_id === a[0]).sort((x, y) => y.opened_at - x.opened_at).slice(0, 50);
    if (s.startsWith('SELECT o.id, o.share_id, o.opened_at, o.country, o.city, o.device, o.via, l.content_type, l.content_id FROM cerpen_share_opens o JOIN cerpen_share_links l ON l.id = o.share_id ORDER BY o.opened_at DESC LIMIT 20')) {
      const byId = new Map(this.cerpenShareLinks.map(x => [x.id, x]));
      return this.cerpenShareOpens.map(o => ({ ...o, content_type: (byId.get(o.share_id) || {}).content_type, content_id: (byId.get(o.share_id) || {}).content_id })).sort((x, y) => y.opened_at - x.opened_at).slice(0, 20);
    }
    // v69: auto-backup .md (md_backup_keys + md_backups)
    if (s.startsWith('SELECT key_id, key_hash, name, revoked, daily_limit FROM md_backup_keys WHERE key_hash = ?')) return this.mdBackupKeys.filter(k => k.key_hash === a[0]);
    if (s.startsWith('SELECT COUNT(*) AS c FROM md_backups WHERE key_id = ? AND created_at >= ?')) return [{ c: this.mdBackups.filter(x => x.key_id === a[0] && x.created_at >= a[1]).length }];
    if (s.startsWith('SELECT id, content_hash, version FROM md_backups WHERE path = ? ORDER BY version DESC LIMIT 1')) return this.mdBackups.filter(x => x.path === a[0]).sort((x, y) => y.version - x.version).slice(0, 1).map(x => ({ id: x.id, content_hash: x.content_hash, version: x.version }));
    if (s.startsWith('SELECT version FROM md_backups WHERE path = ? ORDER BY version DESC LIMIT 1')) return this.mdBackups.filter(x => x.path === a[0]).sort((x, y) => y.version - x.version).slice(0, 1).map(x => ({ version: x.version }));
    if (s.startsWith('INSERT INTO md_backups')) { this.mdBackups.push({ id: a[0], key_id: a[1], path: a[2], content: a[3], content_hash: a[4], size: a[5], version: a[6], created_at: a[7] }); return []; }
    if (s.startsWith('DELETE FROM md_backups WHERE id = ?')) { this.mdBackups = this.mdBackups.filter(x => x.id !== a[0]); return []; }
    if (s.startsWith('SELECT key_id, key_hash, name, created_at, revoked, daily_limit FROM md_backup_keys ORDER BY created_at DESC')) return [...this.mdBackupKeys].sort((x, y) => y.created_at - x.created_at);
    if (s.startsWith('SELECT key_id, COUNT(*) AS c FROM md_backups GROUP BY key_id')) {
      const map = new Map();
      for (const x of this.mdBackups) map.set(x.key_id, (map.get(x.key_id) || 0) + 1);
      return [...map.entries()].map(([key_id, c]) => ({ key_id, c }));
    }
    if (s.startsWith('SELECT path, COUNT(*) AS versions, MAX(version) AS latest_version, MAX(created_at) AS latest_at FROM md_backups GROUP BY path ORDER BY latest_at DESC LIMIT ?')) {
      const map = new Map();
      for (const x of this.mdBackups) {
        const e = map.get(x.path) || { path: x.path, versions: 0, latest_version: 0, latest_at: 0 };
        e.versions++;
        if (x.version > e.latest_version) e.latest_version = x.version;
        if (x.created_at > e.latest_at) e.latest_at = x.created_at;
        map.set(x.path, e);
      }
      return [...map.values()].sort((x, y) => y.latest_at - x.latest_at).slice(0, a[0]);
    }
    if (s.startsWith('SELECT b.id, b.key_id, b.path, b.size, b.version, b.created_at FROM md_backups b WHERE b.version = (SELECT MAX(version) FROM md_backups WHERE path = b.path) ORDER BY b.created_at DESC LIMIT ?')) {
      const latest = new Map();
      for (const x of this.mdBackups) {
        const cur = latest.get(x.path);
        if (!cur || x.version > cur.version) latest.set(x.path, x);
      }
      return [...latest.values()].sort((x, y) => y.created_at - x.created_at).slice(0, a[0]);
    }
    if (s.startsWith('SELECT id, key_id, path, size, version, created_at FROM md_backups WHERE path = ? ORDER BY version DESC LIMIT ?')) return this.mdBackups.filter(x => x.path === a[0]).sort((x, y) => y.version - x.version).slice(0, a[1]);
    if (s.startsWith('SELECT id, key_id, path, content, content_hash, size, version, created_at FROM md_backups WHERE id = ?')) return this.mdBackups.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT id, key_id, path, content, content_hash, size, version FROM md_backups WHERE id = ?')) return this.mdBackups.filter(x => x.id === a[0]);
    if (s.startsWith('SELECT id, path, version FROM md_backups WHERE id = ?')) return this.mdBackups.filter(x => x.id === a[0]).map(x => ({ id: x.id, path: x.path, version: x.version }));
    if (s.startsWith('SELECT key_id FROM md_backup_keys WHERE key_id = ?')) return this.mdBackupKeys.filter(k => k.key_id === a[0]);
    if (s.startsWith('UPDATE md_backup_keys SET revoked = ?')) { const k = this.mdBackupKeys.find(x => x.key_id === a[1]); if (k) k.revoked = a[0]; return []; }
    if (s.startsWith('UPDATE md_backup_keys SET daily_limit = ?')) { const k = this.mdBackupKeys.find(x => x.key_id === a[1]); if (k) k.daily_limit = a[0]; return []; }
    // v81: waktu baca + stopwatch abadi (mock upsert/agregasi meniru D1).
    if (s.startsWith('SELECT start_time FROM eternal_stopwatch WHERE user_id')) return this.eternalStopwatch ? [{ start_time: this.eternalStopwatch.start_time }] : [];
    if (s.startsWith('SELECT SUM(seconds) AS total FROM cms_reading_sessions WHERE user_id')) return [{ total: this.readingSessions.filter(x => x.user_id === a[0] && x.day_wib === a[1]).reduce((n, x) => n + x.seconds, 0) }];
    if (s.startsWith('INSERT INTO cms_reading_sessions')) {
      const ex = this.readingSessions.find(x => x.user_id === a[0] && x.day_wib === a[1] && x.post_id === a[2]);
      if (ex) { ex.seconds += a[3]; ex.max_scroll = Math.max(ex.max_scroll, a[4]); ex.updated_at = a[5]; }
      else this.readingSessions.push({ user_id: a[0], day_wib: a[1], post_id: a[2], seconds: a[3], max_scroll: a[4], updated_at: a[5] });
      return [];
    }
    if (s.startsWith('INSERT INTO cms_reading_hours')) {
      const ex = this.readingHours.find(x => x.user_id === a[0] && x.day_wib === a[1] && x.hour_wib === a[2]);
      if (ex) ex.seconds += a[3];
      else this.readingHours.push({ user_id: a[0], day_wib: a[1], hour_wib: a[2], seconds: a[3] });
      return [];
    }
    if (s.startsWith('SELECT day_wib, SUM(seconds) AS s FROM cms_reading_sessions WHERE user_id')) {
      const m = new Map();
      for (const x of this.readingSessions.filter(y => y.user_id === a[0])) m.set(x.day_wib, (m.get(x.day_wib) || 0) + x.seconds);
      return [...m.entries()].map(([day_wib, s]) => ({ day_wib, s }));
    }
    if (s.startsWith('SELECT hour_wib, SUM(seconds) AS s FROM cms_reading_hours WHERE user_id')) {
      const m = new Map();
      for (const x of this.readingHours.filter(y => y.user_id === a[0])) m.set(x.hour_wib, (m.get(x.hour_wib) || 0) + x.seconds);
      return [...m.entries()].map(([hour_wib, s]) => ({ hour_wib, s })).sort((x, y) => y.s - x.s);
    }
    if (s.startsWith('SELECT COUNT(DISTINCT user_id) AS n FROM cms_reading_sessions')) return [{ n: new Set(this.readingSessions.map(x => x.user_id)).size }];
    if (s.startsWith('SELECT user_id, SUM(seconds) AS total FROM cms_reading_sessions GROUP BY user_id')) {
      const m = new Map();
      for (const x of this.readingSessions) m.set(x.user_id, (m.get(x.user_id) || 0) + x.seconds);
      const all = [...m.entries()].map(([user_id, total]) => ({ user_id, total })).sort((x, y) => y.total - x.total);
      return all.slice(a[1], a[1] + a[0]);
    }
    if (s.startsWith('SELECT user_id, day_wib, SUM(seconds) AS s FROM cms_reading_sessions GROUP BY user_id, day_wib')) {
      const m = new Map();
      for (const x of this.readingSessions) { const k = x.user_id + '|' + x.day_wib; m.set(k, { user_id: x.user_id, day_wib: x.day_wib, s: (m.get(k) ? m.get(k).s : 0) + x.seconds }); }
      return [...m.values()];
    }
    if (s.startsWith('SELECT user_id, hour_wib, SUM(seconds) AS s FROM cms_reading_hours GROUP BY user_id, hour_wib')) {
      const m = new Map();
      for (const x of this.readingHours) { const k = x.user_id + '|' + x.hour_wib; m.set(k, { user_id: x.user_id, hour_wib: x.hour_wib, s: (m.get(k) ? m.get(k).s : 0) + x.seconds }); }
      return [...m.values()];
    }
    if (s.startsWith('SELECT id, username FROM cms_users WHERE id')) return [...this.users.values()].filter(u => u.id === a[0]).map(u => ({ id: u.id, username: u.username }));
    if (s.startsWith('SELECT id, username FROM cms_users')) return [...this.users.values()].map(u => ({ id: u.id, username: u.username }));
    // v87: pola SQL Sistem Koin Cerpen (coins.js) + episode BACKUP_DB.
    // --- Dompet ---
    if (s.startsWith('SELECT owner_key, owner_type, user_id, device_id, balance FROM cerpen_wallets WHERE owner_key = ?')) return this.coinWallets.has(a[0]) ? [{ ...this.coinWallets.get(a[0]) }] : [];
    if (s.startsWith('INSERT OR IGNORE INTO cerpen_wallets')) {
      if (!this.coinWallets.has(a[0])) this.coinWallets.set(a[0], { owner_key: a[0], owner_type: a[1], user_id: a[2], device_id: a[3], balance: 0 });
      return [];
    }
    if (s.startsWith('UPDATE cerpen_wallets SET balance = balance - ?, updated_at = ? WHERE owner_key = ? AND balance >= ?')) {
      const w = this.coinWallets.get(a[2]);
      if (w && (Number(w.balance) || 0) >= a[3]) { w.balance = (Number(w.balance) || 0) - a[0]; return { changes: 1 }; }
      return { changes: 0 };
    }
    if (s.startsWith('UPDATE cerpen_wallets SET balance = balance + ?, updated_at = ? WHERE owner_key = ? AND balance + ? >= 0')) {
      const w = this.coinWallets.get(a[2]);
      if (w && (Number(w.balance) || 0) + a[3] >= 0) { w.balance = (Number(w.balance) || 0) + a[0]; return { changes: 1 }; }
      return { changes: 0 };
    }
    if (s.startsWith('UPDATE cerpen_wallets SET balance = balance + ?, updated_at = ? WHERE owner_key = ?')) {
      const w = this.coinWallets.get(a[2]);
      if (w) w.balance = (Number(w.balance) || 0) + a[0];
      return [];
    }
    if (s.startsWith('UPDATE cerpen_wallets SET balance = ?, updated_at = ? WHERE owner_key = ?')) {
      const w = this.coinWallets.get(a[2]);
      if (w) w.balance = a[0];
      return [];
    }
    if (s.startsWith('UPDATE cerpen_wallets SET balance = 0, updated_at = ? WHERE owner_key = ?')) {
      const w = this.coinWallets.get(a[1]);
      if (w) w.balance = 0;
      return [];
    }
    if (s.startsWith('SELECT COALESCE(SUM(balance), 0) AS s FROM cerpen_wallets')) return [{ s: [...this.coinWallets.values()].reduce((t, w) => t + (Number(w.balance) || 0), 0) }];
    if (s.startsWith('SELECT user_id, balance FROM cerpen_wallets WHERE user_id IS NOT NULL')) return [...this.coinWallets.values()].filter(w => w.user_id).map(w => ({ user_id: w.user_id, balance: w.balance }));
    // --- Unlock ---
    if (s.startsWith('INSERT OR IGNORE INTO cerpen_unlocks')) {
      const key = [a[0], a[1], a[2], a[3], a[4]].join('|');
      if (this.coinUnlocks.some(u => [u.owner_key, u.kind, u.target_id, u.season, u.no].join('|') === key)) return { changes: 0 };
      this.coinUnlocks.push({ owner_key: a[0], kind: a[1], target_id: a[2], season: a[3], no: a[4], created_at: a[5] });
      return { changes: 1 };
    }
    if (s.startsWith('DELETE FROM cerpen_unlocks WHERE owner_key = ?')) { this.coinUnlocks = this.coinUnlocks.filter(u => u.owner_key !== a[0]); return []; }
    if (s.startsWith('SELECT owner_key FROM cerpen_unlocks WHERE owner_key = ? AND kind = ?')) return this.coinUnlocks.filter(u => u.owner_key === a[0] && u.kind === a[1] && u.target_id === a[2] && u.season === a[3] && u.no === a[4]).map(u => ({ owner_key: u.owner_key }));
    if (s.startsWith('SELECT kind, target_id, season, no FROM cerpen_unlocks WHERE owner_key = ? ORDER BY created_at ASC')) return [...this.coinUnlocks].filter(u => u.owner_key === a[0]).sort((x, y) => x.created_at - y.created_at).map(u => ({ kind: u.kind, target_id: u.target_id, season: u.season, no: u.no }));
    if (s.startsWith('SELECT kind, target_id, season, no, created_at FROM cerpen_unlocks WHERE owner_key = ?')) return [...this.coinUnlocks].filter(u => u.owner_key === a[0]).map(u => ({ kind: u.kind, target_id: u.target_id, season: u.season, no: u.no, created_at: u.created_at }));
    if (s.startsWith('SELECT kind, target_id, season, no, created_at FROM cerpen_unlocks WHERE owner_key = ? ORDER BY created_at DESC LIMIT 100')) return [...this.coinUnlocks].filter(u => u.owner_key === a[0]).sort((x, y) => y.created_at - x.created_at).slice(0, 100);
    if (s.startsWith('SELECT kind, target_id, season, no FROM cerpen_unlocks WHERE owner_key = ?')) return this.coinUnlocks.filter(u => u.owner_key === a[0]).map(u => ({ kind: u.kind, target_id: u.target_id, season: u.season, no: u.no }));
    if (s.startsWith('SELECT owner_key, COUNT(*) AS n FROM cerpen_unlocks GROUP BY owner_key')) {
      const m = new Map();
      for (const u of this.coinUnlocks) m.set(u.owner_key, (m.get(u.owner_key) || 0) + 1);
      return [...m.entries()].map(([owner_key, n]) => ({ owner_key, n }));
    }
    // --- Ledger ---
    if (s.startsWith('INSERT INTO cerpen_coin_ledger')) { this.coinLedger.push({ id: a[0], owner_key: a[1], user_id: a[2], device_id: a[3], delta: a[4], balance_after: a[5], reason: a[6], ref: a[7], created_at: a[8] }); return []; }
    if (s.startsWith('SELECT owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger WHERE owner_key = ? ORDER BY created_at DESC LIMIT ?')) return [...this.coinLedger].filter(l => l.owner_key === a[0]).sort((x, y) => y.created_at - x.created_at).slice(0, a[1]);
    if (s.startsWith('SELECT owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger ORDER BY created_at DESC LIMIT ?')) return [...this.coinLedger].sort((x, y) => y.created_at - x.created_at).slice(0, a[0]);
    if (s.startsWith('SELECT owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger ORDER BY created_at DESC LIMIT 20')) return [...this.coinLedger].sort((x, y) => y.created_at - x.created_at).slice(0, 20);
    if (s.startsWith('SELECT delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger WHERE owner_key = ? ORDER BY created_at DESC LIMIT 50')) return [...this.coinLedger].filter(l => l.owner_key === a[0]).sort((x, y) => y.created_at - x.created_at).slice(0, 50).map(l => ({ delta: l.delta, balance_after: l.balance_after, reason: l.reason, ref: l.ref, created_at: l.created_at }));
    if (s.startsWith('SELECT owner_key, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger WHERE device_id = ? ORDER BY created_at DESC LIMIT 50')) return [...this.coinLedger].filter(l => l.device_id === a[0]).sort((x, y) => y.created_at - x.created_at).slice(0, 50);
    if (s.startsWith('SELECT device_id, COUNT(*) AS n FROM cerpen_coin_ledger GROUP BY device_id')) {
      const m = new Map();
      for (const l of this.coinLedger) { if (l.device_id) m.set(l.device_id, (m.get(l.device_id) || 0) + 1); }
      return [...m.entries()].map(([device_id, n]) => ({ device_id, n }));
    }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_coin_ledger WHERE created_at >= ?')) return [{ c: this.coinLedger.filter(l => Number(l.created_at) >= a[0]).length }];
    // --- Harga ---
    if (s.startsWith('SELECT kind, target_id, price, free_episodes FROM cerpen_coin_pricing')) return [...this.coinPricing.values()];
    if (s.startsWith('INSERT OR REPLACE INTO cerpen_coin_pricing')) { this.coinPricing.set(a[0] + ':' + a[1], { kind: a[0], target_id: a[1], price: a[2], free_episodes: a[3] }); return []; }
    if (s.startsWith('DELETE FROM cerpen_coin_pricing WHERE kind = ? AND target_id = ?')) { this.coinPricing.delete(a[0] + ':' + a[1]); return []; }
    // --- Audit / events ---
    if (s.startsWith('INSERT INTO coin_admin_audit')) { this.coinAudit.push({ id: a[0], created_at: a[1], action: a[2], target_type: a[3], target_id: a[4], note: a[5] }); return []; }
    if (s.startsWith('SELECT action, target_type, target_id, note, created_at FROM coin_admin_audit ORDER BY created_at DESC LIMIT 20')) return [...this.coinAudit].sort((x, y) => y.created_at - x.created_at).slice(0, 20);
    if (s.startsWith('INSERT INTO cerpen_coin_events')) { this.coinEvents.push({ id: a[0], kind: a[1], device_id: a[2], android_id: a[3], user_id: a[4], detail: a[5], created_at: a[6] }); return []; }
    if (s.startsWith('SELECT kind, detail, created_at FROM cerpen_coin_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 100')) return [...this.coinEvents].filter(e => e.device_id === a[0]).sort((x, y) => y.created_at - x.created_at).slice(0, 100);
    if (s.startsWith("SELECT device_id, COUNT(*) AS n FROM cerpen_coin_events WHERE kind = 'redeem_failed' AND created_at >= ? GROUP BY device_id")) {
      const m = new Map();
      for (const e of this.coinEvents) if (e.kind === 'redeem_failed' && Number(e.created_at) >= a[0]) m.set(e.device_id, (m.get(e.device_id) || 0) + 1);
      return [...m.entries()].map(([device_id, n]) => ({ device_id, n }));
    }
    // --- Pantauan perangkat ---
    if (s.startsWith('INSERT INTO cerpen_device_watch (device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at) VALUES (?, ?, 0, 0,')) {
      const cur = this.coinWatch.get(a[0]);
      if (cur) { cur.updated_at = a[4]; cur.android_id = a[5] || cur.android_id; }
      else this.coinWatch.set(a[0], { device_id: a[0], android_id: a[1] || '', watched: 0, auto_flag: 0, flag_reason: '', note: '', created_at: a[2], updated_at: a[3] });
      return [];
    }
    if (s.startsWith("INSERT INTO cerpen_device_watch (device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at) VALUES (?, '', ?, 0, '', ?, ?, ?)")) {
      const cur = this.coinWatch.get(a[0]);
      if (cur) { cur.watched = a[5]; cur.note = a[6]; cur.updated_at = a[7]; }
      else this.coinWatch.set(a[0], { device_id: a[0], android_id: '', watched: a[1], auto_flag: 0, flag_reason: '', note: a[2], created_at: a[3], updated_at: a[4] });
      return [];
    }
    if (s.startsWith('SELECT device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at FROM cerpen_device_watch WHERE device_id = ?')) return this.coinWatch.has(a[0]) ? [{ ...this.coinWatch.get(a[0]) }] : [];
    if (s.startsWith('SELECT device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at FROM cerpen_device_watch WHERE device_id LIKE ? OR android_id LIKE ?')) {
      const t = String(a[0]).replace(/%/g, '');
      return [...this.coinWatch.values()].filter(w => w.device_id.includes(t) || (w.android_id || '').includes(t)).sort((x, y) => y.updated_at - x.updated_at).slice(0, a[2]);
    }
    if (s.startsWith('SELECT device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at FROM cerpen_device_watch ORDER BY updated_at DESC LIMIT ?')) return [...this.coinWatch.values()].sort((x, y) => y.updated_at - x.updated_at).slice(0, a[0]);
    if (s.startsWith('UPDATE cerpen_device_watch SET auto_flag = ?, flag_reason = ?, updated_at = ? WHERE device_id = ?')) {
      const w = this.coinWatch.get(a[3]);
      if (w) { w.auto_flag = a[0]; w.flag_reason = a[1]; w.updated_at = a[2]; }
      return [];
    }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_device_watch WHERE watched = 1 OR auto_flag = 1')) return [{ c: [...this.coinWatch.values()].filter(w => w.watched === 1 || w.auto_flag === 1).length }];
    // --- Ban ---
    if (s.startsWith('UPDATE cerpen_bans SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?')) {
      for (const b of this.coinBans) if (b.active === 1 && b.expires_at != null && Number(b.expires_at) <= a[0]) b.active = 0;
      return [];
    }
    if (s.startsWith("SELECT id, reason, expires_at FROM cerpen_bans WHERE target_type = 'user' AND target_id = ? AND active = 1")) return this.coinBans.filter(b => b.target_type === 'user' && b.target_id === a[0] && b.active === 1).map(b => ({ id: b.id, reason: b.reason, expires_at: b.expires_at }));
    if (s.startsWith('INSERT INTO cerpen_bans')) {
      if (this.coinBans.some(b => b.target_type === 'user' && b.target_id === a[1] && b.active === 1)) throw new Error('UNIQUE constraint failed: cerpen_bans');
      this.coinBans.push({ id: a[0], target_type: 'user', target_id: a[1], reason: a[2], banned_by: 'admin', created_at: a[3], expires_at: a[4], active: 1, unbanned_at: null, unbanned_by: null, unban_note: '' });
      return [];
    }
    if (s.startsWith("SELECT id, target_id, reason, banned_by, created_at, expires_at, active FROM cerpen_bans WHERE target_type = 'user' AND active = 1 ORDER BY created_at DESC LIMIT 100")) return [...this.coinBans].filter(b => b.target_type === 'user' && b.active === 1).sort((x, y) => y.created_at - x.created_at).slice(0, 100);
    if (s.startsWith("SELECT id, target_id, reason, banned_by, created_at, expires_at, active, unbanned_at, unban_note FROM cerpen_bans WHERE target_type = 'user' ORDER BY created_at DESC LIMIT 100")) return [...this.coinBans].filter(b => b.target_type === 'user').sort((x, y) => y.created_at - x.created_at).slice(0, 100);
    if (s.startsWith("SELECT id, target_id, reason, banned_by, created_at, expires_at FROM cerpen_bans WHERE target_type = 'user' AND active = 1 ORDER BY created_at DESC LIMIT 50")) return [...this.coinBans].filter(b => b.target_type === 'user' && b.active === 1).sort((x, y) => y.created_at - x.created_at).slice(0, 50);
    if (s.startsWith('SELECT target_id FROM cerpen_bans WHERE target_type =')) return this.coinBans.filter(b => b.target_type === 'user' && b.active === 1).map(b => ({ target_id: b.target_id }));
    if (s.startsWith('SELECT target_id FROM cerpen_bans WHERE id = ?')) return this.coinBans.filter(b => b.id === a[0]).map(b => ({ target_id: b.target_id }));
    if (s.startsWith("SELECT id, reason, banned_by, created_at, expires_at, active, unbanned_at, unban_note FROM cerpen_bans WHERE target_type = 'user' AND target_id = ? ORDER BY created_at DESC LIMIT 10")) return [...this.coinBans].filter(b => b.target_type === 'user' && b.target_id === a[0]).sort((x, y) => y.created_at - x.created_at).slice(0, 10);
    if (s.startsWith('UPDATE cerpen_bans SET active = 0, unbanned_at = ?, unbanned_by =')) {
      const b = this.coinBans.find(x => x.id === a[2] && x.active === 1);
      if (!b) return { changes: 0 };
      b.active = 0; b.unbanned_at = a[0]; b.unbanned_by = 'admin'; b.unban_note = a[1];
      return { changes: 1 };
    }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_bans WHERE target_type =')) return [{ c: this.coinBans.filter(b => b.target_type === 'user' && b.active === 1).length }];
    // --- Perangkat terikat ---
    if (s.startsWith('SELECT user_id FROM cerpen_devices WHERE device_id = ?')) return this.coinDevices.has(a[0]) ? [{ user_id: this.coinDevices.get(a[0]).user_id }] : [];
    if (s.startsWith('INSERT INTO cerpen_devices')) { this.coinDevices.set(a[0], { device_id: a[0], user_id: a[1], android_id: a[2] || '', label: '', first_seen: a[3], last_seen: a[4] }); return []; }
    if (s.startsWith('UPDATE cerpen_devices SET last_seen = ?, android_id = ? WHERE device_id = ?')) { const d = this.coinDevices.get(a[2]); if (d) { d.last_seen = a[0]; d.android_id = a[1]; } return []; }
    if (s.startsWith('UPDATE cerpen_devices SET last_seen = ? WHERE device_id = ? AND user_id = ?')) { const d = this.coinDevices.get(a[1]); if (d && d.user_id === a[2]) d.last_seen = a[0]; return []; }
    if (s.startsWith('DELETE FROM cerpen_devices WHERE device_id = ?')) { this.coinDevices.delete(a[0]); return []; }
    if (s.startsWith('SELECT device_id, android_id, label, first_seen, last_seen FROM cerpen_devices WHERE user_id = ? ORDER BY last_seen DESC')) return [...this.coinDevices.values()].filter(d => d.user_id === a[0]).sort((x, y) => y.last_seen - x.last_seen);
    if (s.startsWith('SELECT device_id, user_id, android_id, first_seen, last_seen FROM cerpen_devices WHERE device_id = ? ORDER BY last_seen DESC')) return [...this.coinDevices.values()].filter(d => d.device_id === a[0]).sort((x, y) => y.last_seen - x.last_seen);
    if (s.startsWith('SELECT device_id, user_id FROM cerpen_devices')) return [...this.coinDevices.values()].map(d => ({ device_id: d.device_id, user_id: d.user_id }));
    if (s.startsWith('SELECT device_id, COUNT(DISTINCT user_id) AS n FROM cerpen_devices GROUP BY device_id')) {
      const m = new Map();
      for (const d of this.coinDevices.values()) m.set(d.device_id, (m.get(d.device_id) || 0) + 1);
      return [...m.entries()].map(([device_id, n]) => ({ device_id, n }));
    }
    if (s.startsWith("SELECT android_id, COUNT(DISTINCT user_id) AS n FROM cerpen_devices WHERE android_id != '' GROUP BY android_id")) {
      const m = new Map();
      for (const d of this.coinDevices.values()) if (d.android_id) m.set(d.android_id, (m.get(d.android_id) || 0) + 1);
      return [...m.entries()].map(([android_id, n]) => ({ android_id, n }));
    }
    if (s.startsWith('SELECT user_id, COUNT(*) AS n FROM cerpen_devices GROUP BY user_id')) {
      const m = new Map();
      for (const d of this.coinDevices.values()) m.set(d.user_id, (m.get(d.user_id) || 0) + 1);
      return [...m.entries()].map(([user_id, n]) => ({ user_id, n }));
    }
    if (s.startsWith('SELECT COUNT(DISTINCT user_id) AS c FROM cerpen_devices WHERE device_id = ? OR android_id = ?')) {
      const set = new Set([...this.coinDevices.values()].filter(d => d.device_id === a[0] || d.android_id === a[1]).map(d => d.user_id));
      return [{ c: set.size }];
    }
    if (s.startsWith('SELECT COUNT(DISTINCT user_id) AS c FROM cerpen_devices WHERE device_id = ?')) {
      const set = new Set([...this.coinDevices.values()].filter(d => d.device_id === a[0]).map(d => d.user_id));
      return [{ c: set.size }];
    }
    if (s.startsWith('SELECT COUNT(DISTINCT user_id) AS c FROM cerpen_devices WHERE android_id = ?')) {
      const set = new Set([...this.coinDevices.values()].filter(d => d.android_id === a[0]).map(d => d.user_id));
      return [{ c: set.size }];
    }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_devices')) return [{ c: this.coinDevices.size }];
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_unlocks')) return [{ c: this.coinUnlocks.length }];
    // --- VIP ---
    if (s.startsWith('SELECT expires_at FROM cerpen_vip WHERE user_id = ?')) return this.coinVip.has(a[0]) ? [{ expires_at: this.coinVip.get(a[0]).expires_at }] : [];
    if (s.startsWith('INSERT INTO cerpen_vip')) {
      this.coinVip.set(a[0], { user_id: a[0], expires_at: a[1], granted_by: a[2], reason: a[3], created_at: a[4] });
      return [];
    }
    if (s.startsWith('DELETE FROM cerpen_vip WHERE user_id = ?')) return { changes: this.coinVip.delete(a[0]) ? 1 : 0 };
    if (s.startsWith('SELECT user_id, expires_at, granted_by, reason, created_at FROM cerpen_vip WHERE expires_at IS NULL OR expires_at > ? ORDER BY expires_at ASC')) return [...this.coinVip.values()].filter(v => v.expires_at == null || Number(v.expires_at) > a[0]).sort((x, y) => (x.expires_at || 0) - (y.expires_at || 0));
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_vip WHERE expires_at IS NULL OR expires_at > ?')) return [{ c: [...this.coinVip.values()].filter(v => v.expires_at == null || Number(v.expires_at) > a[0]).length }];
    // --- Voucher ---
    if (s.startsWith('SELECT v.code_hash, v.batch_id, v.redeemed_count, v.active, b.reward_type')) {
      const v = this.coinVouchers.get(a[0]);
      if (!v) return [];
      const b = this.coinBatches.get(v.batch_id);
      if (!b) return [];
      return [{ code_hash: v.code_hash, batch_id: v.batch_id, redeemed_count: v.redeemed_count, active: v.active, reward_type: b.reward_type, reward_coins: b.reward_coins, reward_value: b.reward_value, reward_target_kind: b.reward_target_kind, reward_target_id: b.reward_target_id, reward_season: b.reward_season, reward_no: b.reward_no, total_max: b.total_max, per_device_max: b.per_device_max, valid_from: b.valid_from, expires_at: b.expires_at, batch_active: b.active }];
    }
    if (s.startsWith('INSERT INTO cerpen_voucher_batches')) {
      this.coinBatches.set(a[0], { batch_id: a[0], reward_type: a[1], reward_coins: a[2], reward_value: a[3], reward_target_kind: a[4], reward_target_id: a[5], reward_season: a[6], reward_no: a[7], total_max: a[8], per_device_max: a[9], valid_from: a[10], expires_at: a[11], redeemed_count: 0, active: a[12], note: a[13], created_at: a[14] });
      return [];
    }
    if (s.startsWith('INSERT INTO cerpen_vouchers')) { this.coinVouchers.set(a[0], { code_hash: a[0], batch_id: a[1], code_prefix: a[2], redeemed_count: 0, active: 1, created_at: a[3] }); return []; }
    if (s.startsWith('SELECT batch_id, reward_type, reward_coins, reward_value, reward_target_kind, reward_target_id, reward_season, reward_no, total_max, per_device_max, valid_from, expires_at, redeemed_count, active, note, created_at FROM cerpen_voucher_batches ORDER BY created_at DESC LIMIT 50')) return [...this.coinBatches.values()].sort((x, y) => y.created_at - x.created_at).slice(0, 50);
    if (s.startsWith('SELECT batch_id, reward_type, reward_coins, reward_value, reward_target_kind, reward_target_id, reward_season, reward_no, total_max, per_device_max, valid_from, expires_at, redeemed_count, active, note, created_at FROM cerpen_voucher_batches WHERE batch_id = ?')) return this.coinBatches.has(a[0]) ? [{ ...this.coinBatches.get(a[0]) }] : [];
    if (s.startsWith('SELECT batch_id, COUNT(*) AS total FROM cerpen_vouchers GROUP BY batch_id')) {
      const m = new Map();
      for (const v of this.coinVouchers.values()) m.set(v.batch_id, (m.get(v.batch_id) || 0) + 1);
      return [...m.entries()].map(([batch_id, total]) => ({ batch_id, total }));
    }
    if (s.startsWith('SELECT batch_id, active FROM cerpen_voucher_batches WHERE batch_id = ?')) return this.coinBatches.has(a[0]) ? [{ batch_id: a[0], active: this.coinBatches.get(a[0]).active }] : [];
    if (s.startsWith('SELECT batch_id FROM cerpen_voucher_batches WHERE batch_id = ?')) return this.coinBatches.has(a[0]) ? [{ batch_id: a[0] }] : [];
    if (s.startsWith('SELECT batch_id, reward_type, reward_target_kind, reward_target_id, reward_season, reward_no, active FROM cerpen_voucher_batches WHERE batch_id = ?')) {
      const b = this.coinBatches.get(a[0]);
      return b ? [{ batch_id: b.batch_id, reward_type: b.reward_type, reward_target_kind: b.reward_target_kind, reward_target_id: b.reward_target_id, reward_season: b.reward_season, reward_no: b.reward_no, active: b.active }] : [];
    }
    if (s.startsWith('UPDATE cerpen_voucher_batches SET reward_type = ?')) {
      const b = this.coinBatches.get(a[9]);
      if (b) { b.reward_type = a[0]; b.reward_coins = a[1]; b.reward_value = a[2]; b.reward_target_kind = a[3]; b.reward_target_id = a[4]; b.reward_season = a[5]; b.reward_no = a[6]; b.valid_from = a[7]; b.expires_at = a[8]; }
      return [];
    }
    if (s.startsWith('UPDATE cerpen_voucher_batches SET total_max = ? WHERE batch_id = ?')) { const b = this.coinBatches.get(a[1]); if (b) b.total_max = a[0]; return []; }
    if (s.startsWith('UPDATE cerpen_voucher_batches SET per_device_max = ? WHERE batch_id = ?')) { const b = this.coinBatches.get(a[1]); if (b) b.per_device_max = a[0]; return []; }
    if (s.startsWith('UPDATE cerpen_voucher_batches SET note = ? WHERE batch_id = ?')) { const b = this.coinBatches.get(a[1]); if (b) b.note = a[0]; return []; }
    if (s.startsWith('UPDATE cerpen_voucher_batches SET active = 1 WHERE batch_id = ?')) { const b = this.coinBatches.get(a[0]); if (b) b.active = 1; return []; }
    if (s.startsWith('UPDATE cerpen_voucher_batches SET active = 0 WHERE batch_id = ?')) { const b = this.coinBatches.get(a[0]); if (b) b.active = 0; return []; }
    if (s.startsWith('UPDATE cerpen_voucher_batches SET redeemed_count = redeemed_count + 1 WHERE batch_id = ? AND active = 1 AND redeemed_count < ?')) {
      const b = this.coinBatches.get(a[0]);
      if (b && b.active === 1 && (Number(b.redeemed_count) || 0) < a[1]) { b.redeemed_count = (Number(b.redeemed_count) || 0) + 1; return { changes: 1 }; }
      return { changes: 0 };
    }
    if (s.startsWith('UPDATE cerpen_vouchers SET redeemed_count = redeemed_count + 1 WHERE code_hash = ? AND active = 1')) { const v = this.coinVouchers.get(a[0]); if (v && v.active === 1) v.redeemed_count = (Number(v.redeemed_count) || 0) + 1; return []; }
    if (s.startsWith('UPDATE cerpen_vouchers SET active = 0 WHERE code_hash = ?')) { const v = this.coinVouchers.get(a[0]); if (v) v.active = 0; return []; }
    if (s.startsWith('SELECT code_hash FROM cerpen_vouchers WHERE code_hash = ?')) return this.coinVouchers.has(a[0]) ? [{ code_hash: a[0] }] : [];
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_vouchers WHERE active = 1')) return [{ c: [...this.coinVouchers.values()].filter(v => v.active === 1).length }];
    if (s.startsWith('INSERT INTO cerpen_voucher_redemptions')) { this.coinRedemptions.push({ id: a[0], code_hash: a[1], owner_key: a[2], device_id: a[3], user_id: a[4], created_at: a[5] }); return []; }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_voucher_redemptions r JOIN cerpen_vouchers v ON v.code_hash = r.code_hash WHERE v.batch_id = ? AND r.device_id = ?')) {
      const n = this.coinRedemptions.filter(r => { const v = this.coinVouchers.get(r.code_hash); return v && v.batch_id === a[0] && r.device_id === a[1]; }).length;
      return [{ c: n }];
    }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cerpen_voucher_redemptions r JOIN cerpen_vouchers v ON v.code_hash = r.code_hash WHERE v.batch_id = ? AND r.user_id = ?')) {
      const n = this.coinRedemptions.filter(r => { const v = this.coinVouchers.get(r.code_hash); return v && v.batch_id === a[0] && r.user_id === a[1]; }).length;
      return [{ c: n }];
    }
    if (s.startsWith('SELECT device_id, COUNT(*) AS n FROM cerpen_voucher_redemptions GROUP BY device_id')) {
      const m = new Map();
      for (const r of this.coinRedemptions) m.set(r.device_id, (m.get(r.device_id) || 0) + 1);
      return [...m.entries()].map(([device_id, n]) => ({ device_id, n }));
    }
    if (s.startsWith('SELECT device_id, COUNT(DISTINCT code_hash) AS n FROM cerpen_voucher_redemptions WHERE created_at >= ? GROUP BY device_id')) {
      const m = new Map();
      for (const r of this.coinRedemptions) if (Number(r.created_at) >= a[0]) { const set = m.get(r.device_id) || new Set(); set.add(r.code_hash); m.set(r.device_id, set); }
      return [...m.entries()].map(([device_id, set]) => ({ device_id, n: set.size }));
    }
    if (s.startsWith('SELECT code_hash, owner_key, user_id, created_at FROM cerpen_voucher_redemptions WHERE device_id = ? ORDER BY created_at DESC LIMIT 50')) return [...this.coinRedemptions].filter(r => r.device_id === a[0]).sort((x, y) => y.created_at - x.created_at).slice(0, 50);
    // --- Waktu baca v81 (dipakai leaderboard + riwayat) ---
    if (s.startsWith('SELECT SUM(seconds) AS total FROM cms_reading_sessions WHERE user_id = ? AND day_wib = ?')) return [{ total: this.readingSessions.filter(x => x.user_id === a[0] && x.day_wib === a[1]).reduce((t, x) => t + (Number(x.seconds) || 0), 0) }];
    if (s.startsWith('INSERT INTO cms_reading_sessions')) {
      const cur = this.readingSessions.find(x => x.user_id === a[0] && x.day_wib === a[1] && x.post_id === a[2]);
      if (cur) { cur.seconds = (Number(cur.seconds) || 0) + a[3]; cur.max_scroll = Math.max(Number(cur.max_scroll) || 0, a[4]); cur.updated_at = a[5]; }
      else this.readingSessions.push({ user_id: a[0], day_wib: a[1], post_id: a[2], seconds: a[3], max_scroll: a[4], updated_at: a[5] });
      return [];
    }
    if (s.startsWith('INSERT INTO cms_reading_hours')) {
      const cur = this.readingHours.find(x => x.user_id === a[0] && x.day_wib === a[1] && x.hour_wib === a[2]);
      if (cur) cur.seconds = (Number(cur.seconds) || 0) + a[3];
      else this.readingHours.push({ user_id: a[0], day_wib: a[1], hour_wib: a[2], seconds: a[3] });
      return [];
    }
    if (s.startsWith("SELECT user_id, SUM(seconds) AS total FROM cms_reading_sessions WHERE day_wib >= ? AND (post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%') GROUP BY user_id ORDER BY total DESC LIMIT ?")) {
      const m = new Map();
      for (const x of this.readingSessions) if (x.day_wib >= a[0] && (x.post_id.startsWith('cerpen:') || x.post_id.startsWith('komik:'))) m.set(x.user_id, (m.get(x.user_id) || 0) + (Number(x.seconds) || 0));
      return [...m.entries()].map(([user_id, total]) => ({ user_id, total })).sort((x, y) => y.total - x.total).slice(0, a[1]);
    }
    if (s.startsWith("SELECT user_id, SUM(seconds) AS total FROM cms_reading_sessions WHERE post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%' GROUP BY user_id ORDER BY total DESC LIMIT ?")) {
      const m = new Map();
      for (const x of this.readingSessions) if (x.post_id.startsWith('cerpen:') || x.post_id.startsWith('komik:')) m.set(x.user_id, (m.get(x.user_id) || 0) + (Number(x.seconds) || 0));
      return [...m.entries()].map(([user_id, total]) => ({ user_id, total })).sort((x, y) => y.total - x.total).slice(0, a[0]);
    }
    if (s.startsWith("SELECT post_id, SUM(seconds) AS s, MAX(day_wib) AS last_day FROM cms_reading_sessions WHERE user_id = ? AND (post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%') GROUP BY post_id ORDER BY last_day DESC LIMIT 50")) {
      const m = new Map();
      for (const x of this.readingSessions) if (x.user_id === a[0] && (x.post_id.startsWith('cerpen:') || x.post_id.startsWith('komik:'))) { const e = m.get(x.post_id) || { post_id: x.post_id, s: 0, last_day: '' }; e.s += Number(x.seconds) || 0; if (x.day_wib > e.last_day) e.last_day = x.day_wib; m.set(x.post_id, e); }
      return [...m.values()].sort((x, y) => y.last_day.localeCompare(x.last_day)).slice(0, 50);
    }
    if (s.startsWith("SELECT post_id, SUM(seconds) AS s, MAX(day_wib) AS last_day FROM cms_reading_sessions WHERE user_id = ? AND (post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%') GROUP BY post_id ORDER BY last_day DESC LIMIT 20")) {
      const m = new Map();
      for (const x of this.readingSessions) if (x.user_id === a[0] && (x.post_id.startsWith('cerpen:') || x.post_id.startsWith('komik:'))) { const e = m.get(x.post_id) || { post_id: x.post_id, s: 0, last_day: '' }; e.s += Number(x.seconds) || 0; if (x.day_wib > e.last_day) e.last_day = x.day_wib; m.set(x.post_id, e); }
      return [...m.values()].sort((x, y) => y.last_day.localeCompare(x.last_day)).slice(0, 20);
    }
    // --- User koin (admin) ---
    if (s.startsWith('SELECT id, username, reading_private FROM cms_users')) return [...this.users.values()].map(u => ({ id: u.id, username: u.username, reading_private: Number(u.reading_private) || 0 }));
    if (s.startsWith('SELECT id FROM cms_users WHERE id')) return [...this.users.values()].filter(u => u.id === a[0]).map(u => ({ id: u.id }));
    if (s.startsWith('SELECT id, username, email, created_at, email_verified, locked FROM cms_users WHERE username LIKE ? OR email LIKE ?')) {
      const t = String(a[0]).replace(/%/g, '');
      return [...this.users.values()].filter(u => u.username.includes(t) || (u.email || '').includes(t)).sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, a[2]).map(u => ({ id: u.id, username: u.username, email: u.email || '', created_at: u.created_at, email_verified: Number(u.email_verified) || 0, locked: Number(u.locked) || 0 }));
    }
    if (s.startsWith('SELECT id, username, email, created_at, email_verified, locked FROM cms_users ORDER BY created_at DESC LIMIT')) return [...this.users.values()].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, a[0] || 20).map(u => ({ id: u.id, username: u.username, email: u.email || '', created_at: u.created_at, email_verified: Number(u.email_verified) || 0, locked: Number(u.locked) || 0 }));
    if (s.startsWith('SELECT id, username, email, created_at, email_verified, locked, reading_private FROM cms_users WHERE id = ?')) return [...this.users.values()].filter(u => u.id === a[0]).map(u => ({ id: u.id, username: u.username, email: u.email || '', created_at: u.created_at, email_verified: Number(u.email_verified) || 0, locked: Number(u.locked) || 0, reading_private: Number(u.reading_private) || 0 }));
    if (s.startsWith('UPDATE cms_users SET locked = ? WHERE id = ?')) { const u = this.users.get(a[1]); if (u) u.locked = a[0]; return []; }
    if (s.startsWith('UPDATE cms_users SET reading_private = ? WHERE id = ?')) { const u = this.users.get(a[1]); if (u) u.reading_private = a[0]; return []; }
    if (s.startsWith('SELECT COUNT(*) AS c FROM cms_users')) return [{ c: this.users.size }];
    // --- Episode BACKUP_DB (resolveVoucherEpisodes + targets) ---
    if (s.startsWith('SELECT series_id FROM cerpen_episodes WHERE series_id = ? AND season = ? AND no = ?')) return this.cerpenEpisodes.filter(e => e.series_id === a[0] && e.season === a[1] && e.no === a[2]).map(e => ({ series_id: e.series_id }));
    if (s.startsWith('SELECT komik_id FROM cerpen_komik_episodes WHERE komik_id = ? AND no = ?')) return this.cerpenKomikEpisodes.filter(e => e.komik_id === a[0] && e.no === a[1]).map(e => ({ komik_id: e.komik_id }));
    if (s.startsWith('SELECT season, no FROM cerpen_episodes WHERE series_id = ? AND season = ? ORDER BY no ASC')) return this.cerpenEpisodes.filter(e => e.series_id === a[0] && e.season === a[1]).sort((x, y) => x.no - y.no).map(e => ({ season: e.season, no: e.no }));
    if (s.startsWith('SELECT no FROM cerpen_komik_episodes WHERE komik_id = ? ORDER BY no ASC')) return this.cerpenKomikEpisodes.filter(e => e.komik_id === a[0]).sort((x, y) => x.no - y.no).map(e => ({ no: e.no }));
    if (s.startsWith('SELECT season, no FROM cerpen_episodes WHERE series_id = ? ORDER BY season ASC, no ASC')) return this.cerpenEpisodes.filter(e => e.series_id === a[0]).sort((x, y) => (x.season - y.season) || (x.no - y.no)).map(e => ({ season: e.season, no: e.no }));
    if (s.startsWith('SELECT id, judul FROM cerpen_series ORDER BY judul ASC LIMIT 200')) return [...this.cerpenSeries].sort((x, y) => x.judul.localeCompare(y.judul)).slice(0, 200).map(x => ({ id: x.id, judul: x.judul }));
    if (s.startsWith('SELECT id, judul FROM cerpen_komik ORDER BY judul ASC LIMIT 200')) return [...this.cerpenKomik].sort((x, y) => x.judul.localeCompare(y.judul)).slice(0, 200).map(x => ({ id: x.id, judul: x.judul }));
    if (s.startsWith('SELECT DISTINCT season FROM cerpen_episodes WHERE series_id = ? ORDER BY season ASC')) return [...new Set(this.cerpenEpisodes.filter(e => e.series_id === a[0]).map(e => e.season))].sort((x, y) => x - y).map(season => ({ season }));
    if (s.startsWith('SELECT season, no, judul FROM cerpen_episodes WHERE series_id = ? ORDER BY season ASC, no ASC LIMIT 500')) return this.cerpenEpisodes.filter(e => e.series_id === a[0]).sort((x, y) => (x.season - y.season) || (x.no - y.no)).slice(0, 500).map(e => ({ season: e.season, no: e.no, judul: e.judul }));
    if (s.startsWith('SELECT no, judul FROM cerpen_komik_episodes WHERE komik_id = ? ORDER BY no ASC LIMIT 500')) return this.cerpenKomikEpisodes.filter(e => e.komik_id === a[0]).sort((x, y) => x.no - y.no).slice(0, 500).map(e => ({ no: e.no, judul: e.judul }));
    throw new Error('Mock SQL tidak dikenal: ' + s);
  }
}
const env = { DB: new MockDB(), BACKUP_DB: new MockDB(), ADMIN_TOKEN: 'test-admin-token', CERPEN_PATH_KEY: '11'.repeat(32), RESEND_API_KEY: 're_test' };
// v83: stub fetch untuk pengiriman OTP — hanya panggilan Resend yang dicegat,
// sisanya diteruskan ke fetch asli supaya tes lain tidak berubah.
const resendCalls = [];
const realFetch0 = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.resend.com')) {
    resendCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ id: 're_test123' }), text: async () => '{}' };
  }
  return realFetch0(url, init);
};
const base = 'https://cms.test';
async function call(method, path, body = null, cookie = '') {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const req = new Request(base + path, { method, headers, body: body ? new URLSearchParams(body).toString() : undefined });
  return worker.fetch(req, env);
}
function assert(cond, label) { console.log((cond ? 'OK  ' : 'GAGAL ') + label); if (!cond) process.exitCode = 1; }

// 1. Beranda menampilkan post sambutan
let r = await call('GET', '/'); let t = await r.text();
assert(t.includes('Selamat Datang di WorkerCMS'), 'beranda: post sambutan tampil');
assert(t.includes('menit baca'), 'beranda: plugin waktu baca aktif');
assert(t.includes('id="copyr"') && t.includes('<a href="/uptime">Uptime</a>') && !t.includes('id="uptime"'), 'beranda: footer copyright + tautan Uptime (tanpa detik berjalan)');

// 2. Login terpadu di form biasa /akun: nama 'admin' + token admin
// (salah -> 403 generik, benar -> token akses + refresh + dashboard super-admin)
function cookiesOf(res) { const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [(res.headers.get('set-cookie') || '')]; return list.map(c => c.split(';')[0]).filter(Boolean); }
function cookieHeader(list) { return list.join('; '); }
// v83: helper verifikasi OTP — kode dibaca dari email yang ditangkap stub.
function kodeTerakhir() {
  const last = resendCalls[resendCalls.length - 1];
  const m = last && last.body && last.body.html ? last.body.html.match(/(\d{6})/) : null;
  return m ? m[1] : '';
}
async function verifikasiKode(email) {
  const t = await call('GET', '/akun/verifikasi?email=' + encodeURIComponent(email));
  const vcsrf = ((await t.text()).match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
  const r = await call('POST', '/akun/verifikasi', { email, code: kodeTerakhir(), csrf: vcsrf });
  assert(r.status === 303, 'otp: kode benar mengaktifkan akun ' + email);
  return cookieHeader(cookiesOf(r));
}
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'salah' }); assert(r.status === 403, 'login admin salah ditolak (pesan generik)');
// v74: login gagal tercatat di security_events (sumber globe /uptime)
const secBefore = env.DB.securityEvents.length;
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'salah' });
assert(r.status === 403 && env.DB.securityEvents.length === secBefore + 1 && env.DB.securityEvents[env.DB.securityEvents.length - 1].kind === 'login_gagal', 'login gagal tercatat di security_events');
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'test-admin-token', remember: '1' });
let cookie = cookieHeader(cookiesOf(r));
assert(cookie.includes('cms_access=') && cookie.includes('cms_refresh='), 'login admin benar memberi token akses + refresh');
assert(env.DB.refreshTokens.length === 1 && env.DB.refreshTokens[0].remember === 1, 'login admin ingat saya menyimpan refresh 30 hari');
assert((r.headers.get('location') || '') === '/kendali', 'login admin dialihkan ke dashboard /kendali');
r = await call('POST', '/akun/login', { username: 'admin', password: 'test-admin-token' }); assert(r.status === 403, 'login admin lama (nama admin) sudah tidak berlaku');
// Header publik tidak lagi menonjolkan Admin, tapi Akun
r = await call('GET', '/'); t = await r.text();
assert(t.includes('href="/akun"') && !t.includes('href="/kendali"') && !t.includes('href="/admin"'), 'header: link Akun tampil, link Admin/Kendali tidak tampil');
// Jalur /admin lama dialihkan ke form biasa /akun
r = await call('GET', '/admin'); assert(r.status === 303 && (r.headers.get('location') || '') === '/akun', '/admin lama dialihkan ke /akun');
// Nama 'admin' tidak bisa didaftarkan sebagai komentator
r = await call('POST', '/akun/daftar', { username: 'admin', password: 'password123' }); assert(r.status === 409, 'daftar nama admin ditolak');
// Ambil token CSRF dari dashboard admin, semua aksi admin wajib pakai token ini
r = await call('GET', '/kendali', null, cookie); t = await r.text();
const csrf = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(csrf.length > 10, 'dashboard memberi token CSRF');
assert(t.includes('Super-Super-Admin'), 'dashboard menandai peran super-super-admin');
// Aksi admin tanpa CSRF harus ditolak
r = await call('POST', '/kendali/posts', { title: 'Post Jahat', category: 'X', body: 'x' }, cookie); assert(r.status === 403, 'aksi admin tanpa CSRF ditolak');
// Rate-limit login admin: 5x salah -> percobaan ke-6 tetap ditolak 403 generik
env.DB.attempts = [];
for (let i = 0; i < 5; i++) await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'salah' });
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'salah' }); assert(r.status === 403, 'login admin ke-6 setelah 5 gagal tetap ditolak');
env.DB.attempts = [];

// 3. Admin buat post baru
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Uji', category: 'Tekno', body: 'Isi post uji kedua.' }, cookie);
assert(r.status === 303, 'admin buat post redirect');
r = await call('GET', '/'); t = await r.text(); assert(t.includes('Post Uji'), 'post baru tampil di beranda');

// 4. Komentar WAJIB akun: tanpa akun ditolak ke /akun, dengan akun -> pending
// (tidak tampil), admin setujui -> tampil
r = await call('POST', '/post/post-uji/comment', { text: 'Komentar anonim' }); assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun'), 'komentar tanpa akun dialihkan ke /akun');
assert(!env.DB.comments.some(c => c.text === 'Komentar anonim'), 'komentar anonim tidak tersimpan');
r = await call('POST', '/akun/daftar', { username: 'budi', password: 'password123', email: 'budi@example.com' }); assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun/verifikasi'), 'daftar akun komentator redirect ke verifikasi');
let userCookie = await verifikasiKode('budi@example.com');
assert(userCookie.includes('cms_user='), 'daftar memberi sesi komentator');
r = await call('GET', '/post/post-uji', null, userCookie); t = await r.text();
const userCsrf = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(userCsrf.length > 10, 'halaman post memberi CSRF komentator');
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Komentar uji' }, userCookie); assert(r.status === 303, 'kirim komentar redirect');
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(!t.includes('Komentar uji'), 'komentar pending belum tampil');
const commentId = env.DB.comments[0].id;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(commentId) }, cookie); assert(r.status === 303, 'admin setujui komentar');
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(t.includes('Komentar uji'), 'komentar disetujui tampil');

// 5. Ganti tema ke gelap + nonaktifkan plugin share, cek halaman berubah
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'gelap' }, cookie);
r = await call('GET', '/'); t = await r.text(); assert(t.includes('#05070d'), 'tema gelap terpakai (identitas situs lama, bukan slate generik)');
r = await call('POST', '/kendali/plugins/toggle', { csrf, id: 'share', enabled: '0' }, cookie);
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(!t.includes('Bagikan:'), 'plugin share nonaktif hilang dari post');

// 6. XSS: komentar berisi tag script harus di-escape, bukan dieksekusi
await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: '<script>alert(1)</script>' }, userCookie);
const cid2 = env.DB.comments[env.DB.comments.length - 1].id;
await call('POST', '/kendali/comments/approve', { csrf, id: String(cid2) }, cookie);
r = await call('GET', '/post/post-uji'); t = await r.text();
assert(!t.includes('<script>alert(1)</script>') && t.includes('&lt;script&gt;'), 'komentar jahat di-escape');

// 7. Backup ke stopwatch: tombol admin -> salinan di BACKUP_DB + riwayat BERHASIL tampil
r = await call('POST', '/kendali/backup', { csrf }, cookie); assert(r.status === 303, 'tombol backup redirect');
r = await call('GET', '/kendali/backup', null, cookie); t = await r.text();
assert(t.includes('Backup ke Stopwatch') && t.includes('BERHASIL'), 'riwayat backup BERHASIL tampil di halaman Backup');
assert(env.BACKUP_DB.backupPosts >= 2, 'backup menyalin post ke stopwatch');
// Backup tanpa BACKUP_DB -> dicatat GAGAL, bukan crash
const savedBak = env.BACKUP_DB; delete env.BACKUP_DB;
r = await call('POST', '/kendali/backup', { csrf }, cookie); assert(r.status === 303, 'backup gagal tetap redirect');
r = await call('GET', '/kendali/backup', null, cookie); t = await r.text();
assert(t.includes('GAGAL'), 'riwayat backup GAGAL tampil di halaman Backup');
env.BACKUP_DB = savedBak;

// 8. Sistem token: refresh memutar, pakai ulang mencabut semua, logout-all
// Catatan desain (sama seperti di video): token akses stateless tetap sah
// sampai kedaluwarsa (maks 1 jam) meski refresh dicabut; yang dicabut
// seketika adalah kemampuan memperpanjang sesi. Jadi cek pasca-logout
// memakai cookie refresh saja, bukan akses yang masih hidup.
const refreshOnly = cookie.split('; ').find(c => c.startsWith('cms_refresh='));
r = await call('GET', '/kendali', null, refreshOnly); t = await r.text();
assert(t.includes('Dashboard Admin'), 'refresh saja bisa masuk dashboard (akses diperpanjang otomatis)');
assert(cookiesOf(r).some(c => c.startsWith('cms_access=')), 'refresh memutar memberi token akses baru');
assert(env.DB.refreshTokens.some(x => x.revoked === 1 && x.replaced_by), 'refresh lama dicabut + ditandai pengganti');
// Pakai ulang refresh lama DALAM jeda tenggang 10 detik (dua request
// bersamaan dengan token akses kedaluwarsa): tetap berhasil, tidak
// mencabut semua — ini jeda anti logout-massal-palsu, bukan celah.
r = await call('GET', '/kendali', null, refreshOnly); t = await r.text();
assert(r.status === 200 && t.includes('Dashboard Admin'), 'refresh lama dalam jeda tenggang tetap bisa masuk (dua request bersamaan)');
assert(env.DB.refreshTokens.some(x => x.revoked === 0), 'refresh dalam jeda tenggang tidak mencabut semua sesi');
// Pakai ulang refresh lama DI LUAR jeda tenggang -> tanda pencurian ->
// semua sesi dicabut (tuakan created_at semua pengganti supaya lewat 10 detik)
for (const rt of env.DB.refreshTokens) rt.created_at = '2026-01-01T00:00:00.000Z';
r = await call('GET', '/kendali', null, refreshOnly); t = await r.text();
assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun'), 'refresh lama di luar jeda tenggang dialihkan ke /akun');
assert(env.DB.refreshTokens.every(x => x.revoked === 1), 'pakai ulang refresh di luar jeda mencabut semua sesi');
// Login ulang + daftar sesi + logout-all
// (Simulasi lewat 15 menit: rate-limit dari tes sebelumnya harus sudah lewat.)
env.DB.attempts = [];
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'test-admin-token' });
cookie = cookieHeader(cookiesOf(r));
const refreshOnly2 = cookie.split('; ').find(c => c.startsWith('cms_refresh='));
r = await call('GET', '/kendali/sessions', null, cookie); t = await r.text();
assert(t.includes('Sesi & Perangkat'), 'halaman Sesi menampilkan daftar sesi & perangkat');
const csrf2 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
r = await call('POST', '/kendali/logout-all', { csrf: csrf2 }, cookie); assert(r.status === 303, 'logout semua perangkat redirect');
assert(env.DB.refreshTokens.every(x => x.revoked === 1), 'logout semua mencabut semua refresh');
r = await call('GET', '/kendali', null, refreshOnly2); t = await r.text();
assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun'), 'setelah logout semua, refresh lama dialihkan ke /akun');
// Logout satu perangkat
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'test-admin-token' });
cookie = cookieHeader(cookiesOf(r));
const refreshOnly3 = cookie.split('; ').find(c => c.startsWith('cms_refresh='));
r = await call('GET', '/kendali', null, cookie); t = await r.text();
const csrf3 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
r = await call('POST', '/kendali/logout', { csrf: csrf3 }, cookie); assert(r.status === 303, 'logout satu perangkat redirect');
r = await call('GET', '/kendali', null, refreshOnly3); t = await r.text();
assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun'), 'setelah logout, refresh perangkat itu dialihkan ke /akun');
// 9. Failsafe = halaman Pemeliharaan berbahasa Inggris untuk SELURUH situs
// saat database hilang/error (perintah pemilik 29 Okt 2026 20:44 WIB;
// sebelumnya 20:42-20:43: tanpa detail teknis di situs, bentuk pemeliharaan).
// DB yang selalu melempar mensimulasikan database yang tidak bisa diakses.
const throwingDB = { prepare() { throw new Error('D1_ERROR: limit'); }, async batch() { throw new Error('D1_ERROR: limit'); } };
const downEnv = { DB: throwingDB, BACKUP_DB: throwingDB, ADMIN_TOKEN: 'test-admin-token' };
async function callDown(method, path) {
  const req = new Request(base + path, { method });
  return worker.fetch(req, downEnv);
}
r = await callDown('GET', '/'); t = await r.text();
assert(r.status === 503 && t.includes('Under Maintenance') && t.includes('currently under maintenance') && !t.includes('Selamat Datang di WorkerCMS') && !t.includes('D1') && !t.includes('kuota'), 'failsafe beranda: halaman pemeliharaan Inggris, tanpa detail teknis');
r = await callDown('GET', '/kendali'); t = await r.text();
// Dashboard tanpa sesi tidak butuh DB (token akses stateless), jadi saat
// DB mati pun ia tetap dialihkan ke form biasa /akun, bukan 503.
assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun'), 'failsafe kendali tanpa sesi: dialihkan ke /akun, bukan halaman admin');
r = await callDown('GET', '/post/post-uji'); t = await r.text();
assert(r.status === 503 && t.includes('Under Maintenance') && !t.includes('D1'), 'failsafe halaman lain: halaman pemeliharaan Inggris, tanpa detail teknis');

// 10. Tema v2 ala WordPress: 4 tema, responsif lintas platform
assert(Object.keys(themes).join(',') === 'terang,gelap,majalah,minimal', 'tema: 4 tema tersedia (terang, gelap, majalah, minimal)');
assert(themes.gelap.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' }).includes('#05070d'), 'tema gelap: identitas default dipertahankan');
assert(themes.majalah.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' }).includes('Georgia'), 'tema majalah: font serif berbeda dari terang/gelap');
assert(themes.minimal.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' }).includes('border-radius:8px'), 'tema minimal: radius kartu berbeda');
const terangHtml = themes.terang.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' });
assert(terangHtml.includes('width=device-width') && terangHtml.includes('@media (max-width:600px)') && terangHtml.includes('min-height:44px'), 'tema responsif: viewport + breakpoint HP + target sentuh 44px');
// 10b. Navbar modern (11 Nov 2026): klasik default tidak berubah,
// modern memuat pill + tab bar + palette + endpoint postingan.
const klasikHtml = themes.terang.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' });
assert(!klasikHtml.includes('nav-pill') && !klasikHtml.includes('tabbar') && !klasikHtml.includes('palette'), 'navbar klasik: render default tanpa pill/tab/palette');
const modernHtml = themes.terang.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '', navbar: 'modern' });
assert(modernHtml.includes('nav-pill') && modernHtml.includes('tabbar') && modernHtml.includes('palette') && modernHtml.includes('/api/nav-posts') && modernHtml.includes('href="/akun"') && modernHtml.includes('href="/bio"'), 'navbar modern: pill + tab bar + palette + endpoint tampil, link Akun/Bio ada');
assert(modernHtml.includes('translateY(-18px)') && modernHtml.includes('button[data-palette-open]{flex:0 0 52px') && modernHtml.includes('scale(.96)') && !modernHtml.includes('padding-top:5px'), 'navbar modern: tombol Cari jadi bubble menonjol di tab bar, pill mengecil pakai transform (anti-lag)');

// 11. Editor post: HTML disanitasi, teks di-escape, header keamanan, honeypot, rate-limit komentar
r = await call('POST', '/kendali/posts', { csrf, title: 'Post HTML', category: 'Tekno', body: '<script>alert(1)</script><p>Halo <b>Dunia</b></p><a href="javascript:alert(1)">x</a><img src="https://x.test/a.png" onerror="alert(1)"><video controls src="https://x.test/v.mp4"></video>', body_mode: 'html' }, cookie);
r = await call('GET', '/post/post-html'); t = await r.text();
// Cek HANYA isi <main> (konten post hasil sanitasi): shell halaman sendiri
// sah memuat script tepercaya (tombol Salin blok kode, deteksi bahasa
// 'javascript:'), jadi string itu tidak boleh dihitung sebagai bocor.
const mainHtml = t.split('<main>')[1].split('</main>')[0];
assert(mainHtml.includes('<p>Halo <b>Dunia</b></p>') && mainHtml.includes('<video') && !mainHtml.includes('<script>alert(1)') && !mainHtml.includes('javascript:') && !mainHtml.includes('onerror'), 'mode HTML: tag aman lolos, script/javascript/onerror dibuang');
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Teks', category: 'Tekno', body: 'Ada <b>tebal</b> palsu.' }, cookie);
r = await call('GET', '/post/post-teks'); t = await r.text();
assert(t.includes('&lt;b&gt;') && !t.includes('Ada <b>tebal</b>'), 'mode teks: HTML di-escape');
r = await call('GET', '/'); assert((r.headers.get('content-security-policy') || '').includes("object-src 'none'") && (r.headers.get('permissions-policy') || '').includes('camera=()'), 'header keamanan: CSP object-src none + permissions-policy');
env.DB.rateLimits = new Map();
for (let i = 0; i < 5; i++) await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Spam ' + i }, userCookie);
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Spam 5' }, userCookie); assert(r.status === 429, 'komentar ke-6 dalam 10 menit dibatasi 429');
env.DB.rateLimits = new Map();
const beforeHoney = env.DB.comments.length;
await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Bot', website: 'http://spam.test' }, userCookie);
assert(env.DB.comments.length === beforeHoney, 'honeypot: komentar bot tidak tersimpan');

// 12. Visibilitas: terjadwal / private / link saja / password (isi tidak dimuat sebelum kunci dibuka) + view mata
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Jadwal', category: 'Tekno', body: 'Belum terbit.', publish_at_iso: '2099-01-01T00:00:00.000Z' }, cookie);
r = await call('GET', '/'); t = await r.text(); assert(!t.includes('Post Jadwal'), 'terjadwal: tidak di beranda sebelum waktunya');
r = await call('GET', '/post/post-jadwal'); assert(r.status === 404, 'terjadwal: pengunjung dapat 404');
r = await call('GET', '/post/post-jadwal', null, cookie); t = await r.text(); assert(t.includes('Belum terbit.') && t.includes('Terjadwal'), 'terjadwal: admin bisa pratinjau');
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Private', category: 'Tekno', body: 'Rahasia admin.', visibility: 'private' }, cookie);
r = await call('GET', '/post/post-private'); assert(r.status === 404, 'private: pengunjung dapat 404');
r = await call('GET', '/post/post-private', null, cookie); t = await r.text(); assert(t.includes('Rahasia admin.'), 'private: admin bisa buka');
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Link', category: 'Tekno', body: 'Hanya lewat link.', visibility: 'unlisted' }, cookie);
r = await call('GET', '/'); t = await r.text(); assert(!t.includes('Post Link'), 'link saja: tidak di beranda');
r = await call('GET', '/post/post-link'); t = await r.text(); assert(t.includes('Hanya lewat link.'), 'link saja: bisa dibuka lewat link langsung');
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Kunci', category: 'Tekno', body: 'Isi sangat rahasia 12345.', visibility: 'password', post_password: 'rahasia123' }, cookie);
r = await call('GET', '/post/post-kunci'); t = await r.text();
assert(t.includes('Post Terkunci') && !t.includes('Isi sangat rahasia 12345') && !t.includes('Post Kunci'), 'password: sebelum kunci dibuka, judul + isi TIDAK dimuat sama sekali');
r = await call('POST', '/post/post-kunci/unlock', { password: 'salah1234' }); assert(r.status === 403, 'password salah ditolak');
r = await call('POST', '/post/post-kunci/unlock', { password: 'rahasia123' }); assert(r.status === 303, 'password benar redirect');
let unlockCookie = cookieHeader(cookiesOf(r));
r = await call('GET', '/post/post-kunci', null, unlockCookie); t = await r.text(); assert(t.includes('Isi sangat rahasia 12345'), 'password benar: isi baru dimuat setelah kunci dibuka');
// View: hanya logo mata + angka, sekali per perangkat per hari
r = await call('GET', '/post/selamat-datang'); t = await r.text();
assert(t.includes('class="view-eye"') && t.includes('> 1') && !t.includes('👁'), 'view: ikon mata SVG + angka tampil, tanpa emoji dan tanpa kata dilihat');
const viewCookie = cookieHeader(cookiesOf(r));
r = await call('GET', '/post/selamat-datang', null, viewCookie); t = await r.text();
assert(t.includes('class="view-eye"') && t.includes('> 1'), 'view: kunjungan ulang perangkat sama tidak menambah angka');

// 13. Komentar: balasan + like/dislike (bisa batal / ganti)
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Balasan untuk Budi', parent_id: String(commentId) }, userCookie); assert(r.status === 303, 'balasan komentar redirect');
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(!t.includes('Balasan untuk Budi'), 'balasan pending belum tampil');
const replyId = env.DB.comments[env.DB.comments.length - 1].id;
await call('POST', '/kendali/comments/approve', { csrf, id: String(replyId) }, cookie);
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(t.includes('Balasan untuk Budi'), 'balasan disetujui tampil di bawah induknya');
r = await call('POST', '/post/post-uji/comment/vote', { csrf: userCsrf, comment_id: String(commentId), vote: '1' }, userCookie); assert(r.status === 303, 'like redirect');
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(!t.includes('👍') && !t.includes('👎') && t.includes(' 1 ·'), 'like terhitung (tampilan publik), ikon SVG bukan emoji');
r = await call('GET', '/post/post-uji', null, userCookie); t = await r.text(); assert(t.includes('data-vote="like" data-count="1"'), 'like terhitung (tombol login)');
r = await call('POST', '/post/post-uji/comment/vote', { csrf: userCsrf, comment_id: String(commentId), vote: '1' }, userCookie);
r = await call('GET', '/post/post-uji', null, userCookie); t = await r.text(); assert(t.includes('data-vote="like" data-count="0"'), 'like kedua kalinya membatalkan');
// Vote AJAX tanpa reload: header X-Requested-With -> JSON, bukan redirect
{
  const ajaxReq = new Request(base + '/post/post-uji/comment/vote', { method: 'POST', headers: { cookie: userCookie, 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'fetch' }, body: new URLSearchParams({ csrf: userCsrf, comment_id: String(commentId), vote: '-1' }).toString() });
  const ajaxRes = await worker.fetch(ajaxReq, env);
  const ajaxData = await ajaxRes.json();
  assert(ajaxRes.status === 200 && ajaxData.like === 0 && ajaxData.mine === -1, 'vote AJAX: dislike JSON, bukan redirect');
}
r = await call('GET', '/post/post-uji'); t = await r.text();
assert(t.includes('data-vote="dislike"') && !t.includes('👎'), 'dislike: tombol ada, angka dislike tidak tampil (ala YouTube)');
// Hapus/edit langsung dari halaman post: pemilik bisa, orang lain tidak
r = await call('GET', '/post/post-uji', null, userCookie); t = await r.text();
assert(t.includes('/comment/delete') && t.includes('Hapus komentar'), 'hapus dari post: pemilik melihat tombol hapus');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Komentar untuk dihapus' }, userCookie);
const ownDelId = env.DB.comments[env.DB.comments.length - 1].id;
r = await call('POST', '/post/post-uji/comment/delete', { csrf: userCsrf, comment_id: String(ownDelId) }, userCookie); assert(r.status === 303, 'hapus dari post: pemilik redirect');
assert(!env.DB.comments.some(c => c.id === ownDelId), 'hapus dari post: komentar pemilik terhapus');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf, text: 'Komentar admin' }, cookie);
const adminCid = env.DB.comments[env.DB.comments.length - 1].id;
r = await call('POST', '/post/post-uji/comment/delete', { csrf: userCsrf, comment_id: String(adminCid) }, userCookie);
assert(env.DB.comments.some(c => c.id === adminCid), 'hapus dari post: komentar admin tidak terhapus oleh bukan pemilik');
r = await call('POST', '/post/post-uji/comment/delete', { csrf, comment_id: String(adminCid) }, cookie); assert(r.status === 303, 'hapus dari post: admin redirect');
assert(!env.DB.comments.some(c => c.id === adminCid), 'hapus dari post: admin bisa hapus komentar siapa pun');
// 14. Branding instance: logo SVG animasi + SITE_TITLE menang atas D1
const brandHtml = themes.terang.render({ siteTitle: 'Hozin King', pageTitle: 'X', content: '' });
assert(brandHtml.includes('<svg') && brandHtml.includes('animateTransform') && brandHtml.includes('>H</text>') && brandHtml.includes('Hozin King'), 'logo SVG: animasi kilau + mark H untuk Hozin King');
assert(envSiteTitle({ SITE_TITLE: '  Hozin King  ' }) === 'Hozin King' && envSiteTitle({}) === '' && envSiteTitle({ SITE_TITLE: '   ' }) === '', 'envSiteTitle: trim, kosong bila tidak ada');
r = await renderPage({ DB: env.DB, SITE_TITLE: 'Hozin King' }, 'Beranda', '<p>uji</p>'); t = r;
assert(t.includes('Hozin King') && !t.includes('>WorkerCMS<') && t.includes('>H</text>'), 'renderPage: SITE_TITLE menang atas site_title D1 (WorkerCMS)');
const downEnvTitle = { ...downEnv, SITE_TITLE: 'Hozin King' };
r = await worker.fetch(new Request(base + '/', { method: 'GET' }), downEnvTitle); t = await r.text();
assert(r.status === 503 && t.includes('Hozin King') && t.includes('>H</text>') && !t.includes('WorkerCMS'), 'maintenance: SITE_TITLE tampil, bukan WorkerCMS, saat D1 mati');
// 15. Redesign beranda + edit post (perintah pemilik 30 Okt 2026 12:12)
// Buat post bergambar, cek kartu: sampul, Selengkapnya, FAB hanya admin, Edit hanya admin
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Sampul Uji', category: 'Tekno', body: '<p>Isi bergambar.</p><img src="https://x.test/cover.png" alt="sampul">', body_mode: 'html' }, cookie);
assert(r.status === 303, 'post sampul dibuat');
const sampul = env.DB.posts.find(x => x.title === 'Post Sampul Uji');
assert(sampul && sampul.slug, 'post sampul tersimpan dengan slug');
r = await call('GET', '/', null, cookie); t = await r.text();
assert(t.includes('class="post-cover"') && t.includes('https://x.test/cover.png'), 'kartu beranda: sampul gambar pertama tampil');
assert(t.includes('Selengkapnya'), 'kartu beranda: tombol Selengkapnya tampil');
assert(t.includes('id="fabPost"') && t.includes('/kendali/posts/new'), 'beranda admin: FAB posting tampil ke halaman Post Baru');
assert(t.includes('/kendali/posts/edit?id=' + sampul.id), 'kartu beranda admin: link Edit tampil');
r = await call('GET', '/'); t = await r.text();
assert(!t.includes('id="fabPost"') && !t.includes('/kendali/posts/edit'), 'beranda pengunjung: FAB dan Edit tidak tampil');
// Halaman edit: prefilled + simpan, slug tetap
r = await call('GET', '/kendali/posts/edit?id=' + sampul.id, null, cookie); t = await r.text();
assert(t.includes('Edit Post') && t.includes('Post Sampul Uji') && t.includes('Simpan Perubahan'), 'halaman edit: prefilled judul + tombol simpan');
r = await call('POST', '/kendali/posts/update', { csrf, id: sampul.id, title: 'Post Sampul Diubah', category: 'Tekno', body: 'Isi diubah.', body_mode: 'text', visibility: 'public' }, cookie);
assert(r.status === 303, 'update post redirect');
const diubah = env.DB.posts.find(x => x.id === sampul.id);
assert(diubah.title === 'Post Sampul Diubah' && diubah.slug === sampul.slug, 'update post: judul berubah, slug tetap');
r = await call('GET', '/post/' + sampul.slug); t = await r.text();
assert(t.includes('Post Sampul Diubah'), 'post lama tetap dibuka lewat slug lama');
// Edit tanpa CSRF ditolak
r = await call('POST', '/kendali/posts/update', { id: sampul.id, title: 'Jahat', body: 'x' }, cookie);
assert(r.status === 403, 'update post tanpa CSRF ditolak');
// 16. Foto profil + iklan manual + pagination (perintah pemilik 30 Okt 2026 12:19)
// Simpan foto + iklan lewat Pengaturan, cek tampil di beranda dan detail
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'gelap', site_avatar: 'https://x.test/avatar.png', ad_image: 'https://x.test/banner.png', ad_link: 'https://x.test/promo', ad_text: 'Promo Uji' }, cookie);
assert(r.status === 303, 'pengaturan foto + iklan tersimpan');
r = await call('GET', '/'); t = await r.text();
assert(t.includes('https://x.test/avatar.png'), 'header: foto profil tampil bila diisi');
assert(t.includes('Iklan') && t.includes('https://x.test/banner.png') && t.includes('https://x.test/promo'), 'beranda: slot iklan tampil bila diisi');
r = await call('GET', '/post/' + sampul.slug); t = await r.text();
assert(t.includes('https://x.test/banner.png'), 'detail post: slot iklan tampil di bawah isi');
// URL aneh dibersihkan, tidak tampil
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'gelap', site_avatar: 'javascript:alert(1)', ad_image: '', ad_link: '', ad_text: '' }, cookie);
r = await call('GET', '/'); t = await r.text();
assert(!t.includes('javascript:alert(1)') && !t.includes('Iklan'), 'foto + iklan: URL aneh dibersihkan, slot kosong tidak tampil');
// Pagination: tambah 12 post dummy, halaman 1 hanya 10 terbaru, halaman 2 sisanya
for (let i = 1; i <= 12; i++) {
  env.DB.posts.push({ id: 'pg-' + i, slug: 'paginasi-' + i, title: 'Paginasi ' + String(i).padStart(2, '0'), body: 'Isi paginasi ' + i, category: 'Umum', status: 'published', created_at: '2026-01-01T00:' + String(i).padStart(2, '0') + ':00.000Z', updated_at: '2026-01-01T00:00:00.000Z', body_mode: 'text', visibility: 'public', publish_at: '2026-01-01T00:' + String(i).padStart(2, '0') + ':00.000Z', post_password_hash: '', post_password_salt: '', views: 0 });
}
r = await call('GET', '/', null, 'cms_fv=1'); t = await r.text();
assert(t.includes('Paginasi 12') && !t.includes('Paginasi 01') && t.includes('Post lama'), 'pagination halaman 1: 10 terbaru + link Post lama');
// (v81: cookie cms_fv=1 di atas = pengunjung kembali; pengunjung baru dapat
// komposisi first-visit yang memang boleh memuat item halaman 2 di rotasi.)
r = await call('GET', '/?page=2'); t = await r.text();
assert(t.includes('Paginasi 01') && !t.includes('Paginasi 12') && t.includes('Post baru'), 'pagination halaman 2: sisanya + link Post baru');
// 17. Halaman /akun profesional: satu kartu tab, bukan dua kartu bertumpuk
r = await call('GET', '/akun'); t = await r.text();
assert(t.includes('id="tabLoginBtn"') && t.includes('id="tabDaftarBtn"') && t.includes('id="loginForm"') && t.includes('id="daftarForm"'), 'halaman akun: tab Login/Daftar tampil');
assert(t.includes('class="remember"') && t.includes('Ingat saya di perangkat ini'), 'halaman akun: checkbox Ingat saya sebaris dengan label');
assert(!t.includes('tidak bisa membuat post atau membuka dashboard'), 'halaman akun: teks penjelasan panjang dipersingkat');
assert(t.includes('max-width:440px'), 'halaman akun: kartu sempit di tengah, tidak selebar penuh');
// 18. Dashboard pisah halaman (perintah pemilik 30 Okt 2026 12:29)
// /kendali = ringkasan saja, Post Baru = halaman sendiri, bukan kartu di mega page
r = await call('GET', '/kendali', null, cookie); t = await r.text();
assert(t.includes('Dashboard Admin') && t.includes('/kendali/posts/new') && !t.includes('Buat Backup Sekarang') && !t.includes('Simpan Pengaturan'), 'dashboard: ringkasan + navigasi saja, tanpa kartu Backup/Pengaturan');
r = await call('GET', '/kendali/posts/new', null, cookie); t = await r.text();
assert(t.includes('Post Baru') && t.includes('id="post-baru"') && t.includes('Terbitkan'), 'halaman Post Baru: editor sendiri, bukan di dashboard');
r = await call('GET', '/kendali/posts', null, cookie); t = await r.text();
assert(t.includes('<h2>Post</h2>') && t.includes('/kendali/posts/new'), 'halaman Post: daftar + link Post Baru');
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('Simpan Pengaturan') && t.includes('Foto profil situs'), 'halaman Pengaturan: form sendiri');
r = await call('GET', '/kendali/comments', null, cookie); t = await r.text();
assert(t.includes('<h2>Komentar</h2>'), 'halaman Komentar: sendiri');
// 18b. Teleport komentar (v82): panel admin -> anchor di halaman post
r = await call('GET', '/kendali/comments', null, cookie); t = await r.text();
assert(t.includes(`href="/post/post-uji#comment-${commentId}"`) && t.includes('target="_blank"'), 'panel komentar: tautan Lihat di postingan ke anchor #comment-<id> di tab baru');
r = await call('GET', '/post/post-uji'); t = await r.text();
assert(t.includes(`id="comment-${commentId}"`), 'halaman post: komentar punya anchor id="comment-<id>"');
assert(t.includes('.card:target'), 'halaman post: gaya :target untuk highlight komentar tujuan');
// 18c. Tarik persetujuan (v82): approved -> tombol Tarik, kembali pending
r = await call('GET', '/kendali/comments', null, cookie); t = await r.text();
assert(t.includes('action="/kendali/comments/withdraw"') && t.includes('>Tarik</button>'), 'tarik: komentar approved menampilkan tombol Tarik, bukan Setujui');
r = await call('POST', '/kendali/comments/withdraw', { csrf, id: String(commentId) }, cookie); assert(r.status === 303, 'tarik: redirect');
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(!t.includes('Komentar uji'), 'tarik: komentar tidak tampil publik lagi');
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(commentId) }, cookie); assert(r.status === 303, 'tarik: setujui ulang redirect (pulihkan)');
// 19. Ikon mata animasi sinkron WIB (perintah pemilik 30 Okt 2026 12:31)
// Bukan emoji; SVG + keyframes kedip 4 detik + footer script sinkron fase
r = await call('GET', '/'); t = await r.text();
assert(t.includes('class="view-eye"') && t.includes('eyeBlink') && t.includes('Date.now()%4000'), 'mata: SVG animasi kedip sinkron jam dinding, bukan emoji');
assert(t.includes('viewBox="0 0 32 28"') && t.includes('width:22px'), 'mata: bentuk bulat terbuka, bukan sipit, dan ukuran lebih besar');
assert(!t.includes('👁'), 'mata: tidak ada emoji mata di halaman mana pun');
// 20. URL post profesional + sitemap + AdSense + plugin keamanan
r = await call('GET', '/post/selamat-datang'); t = await r.text();
assert(t.includes('Selamat Datang di WorkerCMS'), 'URL post baru /post/<slug> tampil');
assert(r.headers.get('strict-transport-security') === 'max-age=31536000; includeSubDomains', 'HSTS Worker: max-age 1 tahun + includeSubDomains');
r = await call('GET', '/p/selamat-datang'); assert(r.status === 301 && (r.headers.get('location') || '') === '/post/selamat-datang', 'URL lama /p/ dialihkan permanen 301 ke /post/');
r = await call('GET', '/sitemap.xml'); t = await r.text();
assert(r.headers.get('content-type') && r.headers.get('content-type').includes('application/xml'), 'sitemap: content-type XML');
assert(t.includes('/post/selamat-datang') && !t.includes('/post/post-private') && !t.includes('/post/post-kunci'), 'sitemap: hanya post publik, bukan private/password');
r = await call('GET', '/robots.txt'); t = await r.text();
assert(t.includes('Disallow: /kendali/') && t.includes('/sitemap.xml'), 'robots: larang admin + tunjuk sitemap');
r = await call('GET', '/api/nav-posts'); t = await r.text();
const navPosts = JSON.parse(t);
assert(r.status === 200 && navPosts.ok === true && Array.isArray(navPosts.posts) && navPosts.posts.some(p => p.slug === 'selamat-datang') && !navPosts.posts.some(p => p.slug === 'post-private'), 'nav-posts: daftar post publik untuk Command Palette');
r = await call('GET', '/api/github-streak'); t = await r.text();
const streak = JSON.parse(t);
assert(typeof streak.ok === 'boolean' && (r.status === 200 || r.status === 502) && (r.status !== 200 || (typeof streak.totalContributions === 'number' && streak.currentStreak && typeof streak.currentStreak.length === 'number')), 'github-streak: proxy endpoint menjawab JSON (200 data / 502 fallback)');
r = await call('GET', '/bio'); t = await r.text();
assert(t.includes('Link donasi segera hadir'), 'bio: tanpa link donasi, tombol segera hadir');
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'terang', donate_url: 'https://saweria.co/hozin' }, cookie); assert(r.status === 303, 'pengaturan: link donasi tersimpan');
r = await call('GET', '/bio'); t = await r.text();
assert(t.includes('https://saweria.co/hozin') && t.includes('Donasi sekarang'), 'bio: link donasi dari pengaturan tampil + tombol aktif');
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('<label>AdSense</label>') && t.includes('Mati'), 'pengaturan: satu kolom AdSense tampil + status Mati saat kosong');
assert(t.includes('name="donate_url"'), 'pengaturan: kolom link donasi tampil');
r = await call('POST', '/kendali/settings', { csrf, site_title: 'Hozin King', theme: 'gelap', adsense_client: 'ca-pub-1234567890123456', adsense_slot: '1234567890' }, cookie); assert(r.status === 303, 'pengaturan AdSense tersimpan');
r = await call('GET', '/'); t = await r.text();
assert(t.includes('adsbygoogle') && t.includes('ca-pub-1234567890123456'), 'AdSense: unit tampil di beranda bila client diisi');
assert(t.includes('class="card adsense-box"') && t.includes('data-ad-status') && t.includes('MutationObserver'), 'AdSense: unit kosong disembunyikan — wrapper adsense-box + observer data-ad-status');
assert(t.includes('class="card adsense-box" style="text-align:center;display:none"') && t.includes("'filled'"), 'AdSense: unit mulai tersembunyi, baru tampil bila data-ad-status=filled');
assert(r.headers.get('content-security-policy') && r.headers.get('content-security-policy').includes('pagead2.googlesyndication.com'), 'AdSense: CSP dilonggarkan hanya untuk domain Google Ads');
// AdSense: satu kolom — tempel script lengkap diekstrak jadi ID polos
r = await call('POST', '/kendali/settings', { csrf, site_title: 'Hozin King', theme: 'gelap', adsense_client: '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9999999999999999" crossorigin="anonymous"></script>' }, cookie); assert(r.status === 303, 'AdSense: tempelan script lengkap tersimpan');
r = await call('GET', '/'); t = await r.text();
assert(t.includes('<meta name="google-adsense-account" content="ca-pub-9999999999999999">') && t.includes('adsbygoogle.js?client=ca-pub-9999999999999999'), 'AdSense: script + meta verifikasi tampil di <head> beranda');
assert(t.indexOf('google-adsense-account') < t.indexOf('</head>'), 'AdSense: meta verifikasi berada di dalam <head>');
r = await call('GET', '/ads.txt'); t = await r.text();
assert(r.status === 200 && t === 'google.com, pub-9999999999999999, DIRECT, f08c47fec0942fa0\n', 'ads.txt: baris persis saat setting terisi');
r = await call('GET', '/bio'); t = await r.text();
assert(t.includes('adsbygoogle.js?client=ca-pub-9999999999999999'), 'AdSense: script verifikasi tampil di <head> /bio');
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('value="ca-pub-9999999999999999"') && t.includes('Aktif'), 'AdSense: kolom terisi ID polos hasil ekstraksi + status Aktif');
// AdSense: input tanpa ID valid ditolak, nilai lama tetap
r = await call('POST', '/kendali/settings', { csrf, site_title: 'Hozin King', theme: 'gelap', adsense_client: 'bukan-id-adsense' }, cookie); assert(r.status === 303 && (r.headers.get('location') || '').includes('adsense-tidak-valid'), 'AdSense: input tanpa ID valid ditolak dengan pesan jelas');
r = await call('GET', '/'); t = await r.text();
assert(t.includes('ca-pub-9999999999999999') && !t.includes('bukan-id-adsense'), 'AdSense: nilai lama tetap dipakai setelah input ditolak');
// AdSense: kolom dikosongkan = ketiganya mati
r = await call('POST', '/kendali/settings', { csrf, site_title: 'Hozin King', theme: 'gelap', adsense_client: '' }, cookie); assert(r.status === 303, 'AdSense: kolom dikosongkan tersimpan');
r = await call('GET', '/'); t = await r.text();
assert(!t.includes('adsbygoogle') && !t.includes('google-adsense-account'), 'AdSense: script + meta hilang saat setting dikosongkan');
r = await call('GET', '/ads.txt'); assert(r.status === 404, 'ads.txt: 404 saat setting kosong');
r = await call('GET', '/kendali/plugins', null, cookie); t = await r.text();
assert(t.includes('Filter Kata Kotor') && t.includes('Tahan Komentar Berlink') && t.includes('Tahan Komentar Panjang'), 'plugin keamanan: 3 plugin baru tampil di panel');
// 21. Plugin keamanan benar-benar jalan (bukan saklar mati)
r = await call('POST', '/post/post-uji/comment', { csrf, text: 'Halo anjing yang baik' }, cookie); assert(r.status === 303, 'komentar kotor admin redirect');
r = await call('GET', '/post/post-uji'); t = await r.text();
assert(t.includes('***') && !t.includes('Halo anjing'), 'filter kata kotor: pengunjung melihat *** bukan kata asli');
r = await call('GET', '/post/post-uji', null, cookie); t = await r.text();
assert(t.includes('Edit komentar'), 'filter: admin tetap bisa edit langsung dari halaman post (teks asli hanya di form admin)');
r = await call('POST', '/post/post-uji/comment', { csrf, text: 'Cek link ini https://spam.test' }, cookie); assert(r.status === 303, 'komentar berlink admin redirect');
r = await call('GET', '/post/post-uji', null, cookie); t = await r.text();
assert(!t.includes('spam.test'), 'tahan link: komentar berlink admin ditahan, tidak tampil');
r = await call('POST', '/post/post-uji/comment', { csrf, text: 'x'.repeat(1001) }, cookie); assert(r.status === 303, 'komentar panjang admin redirect');
r = await call('GET', '/post/post-uji', null, cookie); t = await r.text();
assert(!t.includes('x'.repeat(100)), 'tahan panjang: komentar >1000 karakter ditahan, tidak tampil');
// 22. Plugin blokir otomatis (perintah pemilik 30 Okt 2026 12:57)
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Cek https://spam.test' }, userCookie); assert(r.status === 403, 'blokir link: komentator ditolak 403, tidak disimpan');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'kamu anjing' }, userCookie); assert(r.status === 403, 'blokir kata kotor: komentator ditolak 403');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'slot gacor maxwin togel daftar' }, userCookie); assert(r.status === 403, 'blokir judol: komentator ditolak 403');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'slot RAM laptop saya 16GB' }, userCookie); assert(r.status === 303, 'blokir judol: kata slot saja tidak diblokir');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf, text: 'togel' }, cookie); assert(r.status === 303, 'blokir judol: admin dikecualikan, tidak ditolak');
r = await call('GET', '/post/post-uji', null, cookie); t = await r.text();
assert(t.includes('togel'), 'blokir judol: komentar admin tetap tampil');
r = await call('GET', '/kendali/plugins', null, cookie); t = await r.text();
assert(t.includes('Blokir Komentar Berlink') && t.includes('Blokir Kata Kotor') && t.includes('Blokir Judol Otomatis'), 'plugin blokir: 3 plugin baru tampil di panel');
// 23. Upload gambar via ImgBB (perintah pemilik 30 Okt 2026 13:04, "tidak ribet")
r = await call('POST', '/kendali/upload-image', { csrf }, userCookie); assert(r.status === 303, 'upload imgbb: non-admin dialihkan ke /akun');
r = await call('POST', '/kendali/upload-image', {}, cookie); assert(r.status === 403, 'upload imgbb: admin tanpa CSRF ditolak');
r = await call('POST', '/kendali/upload-image', { csrf }, cookie); t = await r.text(); assert(r.status === 400 && t.includes('Kunci API ImgBB belum diset'), 'upload imgbb: tanpa kunci di Pengaturan ditolak 400, tidak panggil ImgBB');
r = await call('POST', '/kendali/imgbb/add', { csrf, new_key: 'testimgbbkey123456' }, cookie); assert(r.status === 303, 'pengaturan: tambah kunci ImgBB redirect');
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('Kunci 1') && !t.includes('testimgbbkey123456'), 'pengaturan: kunci ImgBB tampil tersamar, bukan mentah');
r = await call('POST', '/kendali/upload-image', { csrf }, cookie); t = await r.text(); assert(r.status === 400 && t.includes('Pilih file gambar dulu'), 'upload imgbb: kunci sudah ada, tanpa file ditolak 400');
r = await call('GET', '/kendali/posts/new', null, cookie); t = await r.text();
assert(t.includes('Upload Gambar (ImgBB)') && t.includes('imgbbFile'), 'editor: tombol upload ImgBB tampil di post baru');
// 24. Super Panel untuk semuanya (perintah pemilik 30 Okt 2026 13:11, "untuk semuanya")
r = await call('GET', '/kendali/super', null, userCookie); assert(r.status === 303, 'super panel: non-admin dialihkan');
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('Super Panel') && t.includes('Komentar & Keamanan') && t.includes('Event PC Builder'), 'super panel: admin melihat situs + komentar + PC Builder');
assert(t.includes('Traffic Lengkap') && t.includes('views total') && t.includes('Per Hari') && t.includes('Per Post'), 'super panel: traffic lengkap tampil (total, per-hari, per-post)');
env.DB.viewEvents.push({ post_id: 'p1', viewed_at: new Date().toISOString() });
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(t.includes('background:#3b82f6') && t.includes('width:100%'), 'super panel: grafik batang per-hari tampil (hari tertinggi = batang penuh)');
r = await call('GET', '/api/pcbuilder-events'); t = await r.text();
assert(r.status === 200 && !t.toLowerCase().includes('discount'), 'pcbuilder events: nonaktif tidak mengandung kata discount (game tidak salah diskon)');
r = await call('POST', '/kendali/super/pcbuilder', { csrf, pcbuilder_active: '1', pcbuilder_message: 'Event akhir pekan' }, cookie); assert(r.status === 303 && (r.headers.get('location') || '') === '/kendali/super?notice=event-disimpan', 'super panel: simpan event PC Builder redirect ke super + notice');
r = await call('GET', '/api/pcbuilder-events'); t = await r.text();
assert(t.includes('discount') && t.includes('10'), 'pcbuilder events: aktif mengandung discount 10');
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'terang', return_to: '/kendali/super' }, cookie); assert((r.headers.get('location') || '') === '/kendali/super?notice=pengaturan-disimpan', 'pengaturan: return_to ke super panel jalan + notice');
// 25. Kunci ImgBB ganda + edit + pin + plugin toggle simpan (perintah pemilik 30 Okt 2026 13:13-13:15)
env.DB.rateLimits = new Map();
r = await call('POST', '/kendali/imgbb/add', { csrf, new_key: 'secondimgbbkey789012' }, cookie); assert(r.status === 303, 'imgbb ganda: tambah kunci kedua redirect');
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('Kunci 1') && t.includes('Kunci 2') && t.includes('⚪'), 'imgbb ganda: 2 kunci tampil, status belum dicoba abu');
r = await call('POST', '/kendali/imgbb/delete', { csrf, index: '1' }, cookie); assert(r.status === 303, 'imgbb ganda: hapus kunci kedua redirect');
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('Kunci 1') && !t.includes('Kunci 2'), 'imgbb ganda: kunci kedua terhapus, kunci pertama tetap');
// Edit + pin: buat komentar baru, setujui, sematkan, edit pemilik
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Komentar untuk pin' }, userCookie); assert(r.status === 303, 'pin: komentar baru redirect');
const pinCid = env.DB.comments[env.DB.comments.length - 1].id;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(pinCid) }, cookie); assert(r.status === 303, 'pin: setujui komentar');
r = await call('POST', '/kendali/comments/pin', { csrf, id: String(pinCid) }, cookie); assert(r.status === 303, 'pin: sematkan redirect');
r = await call('GET', '/post/post-uji', null, cookie); t = await r.text();
assert(t.includes('📌 Disematkan') && t.includes('Komentar untuk pin'), 'pin: komentar disematkan tampil di atas');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment/edit', { csrf: userCsrf, comment_id: String(pinCid), text: 'Komentar untuk pin (diedit)' }, userCookie); assert(r.status === 303, 'edit: pemilik edit redirect');
assert(env.DB.comments.find(c => c.id === pinCid).status === 'pending', 'edit: komentar pemilik kembali pending');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment/edit', { csrf: userCsrf, comment_id: String(pinCid), text: 'slot gacor' }, userCookie); assert(r.status === 403, 'edit: edit ke judol ditolak blokir');
r = await call('POST', '/kendali/comments/update', { csrf, id: String(pinCid), text: 'Komentar untuk pin (edit admin)' }, cookie); assert(r.status === 303, 'edit: admin edit redirect');
assert(env.DB.comments.find(c => c.id === pinCid).text.includes('edit admin'), 'edit: admin edit tersimpan');
// Plugin toggle + simpan massal
r = await call('GET', '/kendali/plugins', null, cookie); t = await r.text();
assert(t.includes('Simpan Plugin') && t.includes('plugin-toggle') && !t.includes('/kendali/plugins/toggle'), 'plugin: halaman pakai toggle + tombol simpan, bukan tombol per plugin');
r = await call('POST', '/kendali/plugins/save', { csrf, 'plugin_reading-time': '1' }, cookie); assert(r.status === 303, 'plugin: simpan massal redirect');
r = await call('GET', '/kendali/plugins', null, cookie); t = await r.text();
assert(t.includes('name="plugin_reading-time" value="1" checked'), 'plugin: simpan massal menyimpan status toggle');
// 26. Dashboard lengkap (perintah pemilik 30 Okt 2026 17:50)
r = await call('GET', '/post/post-uji', null, cookie); t = await r.text();
env.DB.viewEvents.push({ post_id: 'p-mvul0ei4', viewed_at: new Date().toISOString() });
r = await call('GET', '/kendali', null, cookie); t = await r.text();
assert(t.includes('Post Terpopuler') && t.includes('views total') && t.includes('Post Paling Banyak Dikomentari') && t.includes('Komentator Teraktif') && t.includes('Post Terbaru'), 'dashboard: ringkasan + terpopuler + dikomentari + teraktif + terbaru tampil');
assert(t.includes('7 hari terakhir'), 'dashboard: views 7 hari terakhir tampil (bukan grafik palsu)');
// 27. Balasan otomatis komentar (perintah pemilik 31 Okt 2026): model teks Dahono gratis,
// pemicu saat disetujui, 1 balasan per komentar, label bot jelas, gagal = diam (bukan crash)
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('Balasan Otomatis') && t.includes('DAHONO_API_KEY'), 'auto-reply: pengaturan menampilkan toggle + status secret');
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Komentar auto-reply' }, userCookie); assert(r.status === 303, 'auto-reply: komentar baru redirect');
const arCid = env.DB.comments[env.DB.comments.length - 1].id;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(arCid) }, cookie); assert(r.status === 303, 'auto-reply: setujui tanpa secret tetap redirect (nonaktif default)');
assert(!env.DB.comments.some(c => c.parent_id === arCid && c.name === 'Balasan Otomatis'), 'auto-reply: nonaktif/tanpa secret = tidak ada balasan bot');
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'terang', auto_reply: '1' }, cookie); assert(r.status === 303, 'auto-reply: aktifkan toggle redirect');
env.DAHONO_API_KEY = 'test-dahono-key';
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Terima kasih atas komentarnya!' } }] }) });
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Komentar auto-reply dua' }, userCookie);
const arCid2 = env.DB.comments[env.DB.comments.length - 1].id;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(arCid2) }, cookie); assert(r.status === 303, 'auto-reply: setujui dengan secret redirect');
assert(env.DB.comments.some(c => c.parent_id === arCid2 && c.name === 'Balasan Otomatis' && c.text === 'Terima kasih atas komentarnya!' && c.status === 'approved'), 'auto-reply: balasan bot tersimpan sebagai anak komentar, status approved');
r = await call('GET', '/post/post-uji'); t = await r.text();
assert(t.includes('Balasan Otomatis') && t.includes('Terima kasih atas komentarnya!'), 'auto-reply: balasan bot tampil di halaman post');
const botCount = env.DB.comments.filter(c => c.parent_id === arCid2 && c.name === 'Balasan Otomatis').length;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(arCid2) }, cookie);
assert(env.DB.comments.filter(c => c.parent_id === arCid2 && c.name === 'Balasan Otomatis').length === botCount, 'auto-reply: setujui ulang tidak menggandakan balasan');
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Komentar auto-reply gagal' }, userCookie);
const arCid3 = env.DB.comments[env.DB.comments.length - 1].id;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(arCid3) }, cookie); assert(r.status === 303, 'auto-reply: Dahono gagal tetap redirect (persetujuan tidak gagal)');
assert(!env.DB.comments.some(c => c.parent_id === arCid3 && c.name === 'Balasan Otomatis'), 'auto-reply: Dahono gagal = tidak ada balasan, bukan crash');
globalThis.fetch = realFetch;
// 28. Fitur tag (perintah pemilik 1 Nov 2026): normalisasi, link aman,
// simpan saat buat post, tampil di detail, arsip /tag/<slug> hanya cocok
// persis (bukan LIKE, supaya "hp" tidak menarik "hape")
assert(JSON.stringify(parseTags('HP, hp,  , keamanan, android')) === JSON.stringify(['HP', 'keamanan', 'android']), 'tag: dedup tak peduli huruf besar, kosong dibuang');
assert(parseTags('a,b,c,d,e,f,g,h,i,j,k,l').length === 10, 'tag: maks 10 tag');
assert(tagSlug('Keamanan Akun') === 'keamanan-akun', 'tag: slug dari nama tag');
assert(tagLinks({ tags: '<script>, hp' }).includes('/tag/hp') && !tagLinks({ tags: '<script>, hp' }).includes('<script>'), 'tag: link di-escape, markup tidak lolos');
r = await call('POST', '/kendali/posts', { csrf, title: 'Post Bertag', category: 'Tekno', body: 'Isi bertag.', tags: 'hp, Keamanan, hp' }, cookie); assert(r.status === 303, 'tag: buat post bertag redirect');
r = await call('GET', '/post/post-bertag'); t = await r.text(); assert(t.includes('/tag/hp') && t.includes('/tag/keamanan'), 'tag: detail post menampilkan link tag');
r = await call('GET', '/tag/hp'); t = await r.text(); assert(t.includes('Post Bertag'), 'tag: arsip /tag/hp memuat post bertag hp');
r = await call('GET', '/tag/hape'); t = await r.text(); assert(!t.includes('Post Bertag'), 'tag: arsip /tag/hape tidak menarik post bertag hp');
r = await call('GET', '/kendali/posts/new', null, cookie); t = await r.text(); assert(t.includes('name="tags"'), 'tag: editor menampilkan input tag');
// 29. Load test: endpoint bertoken khusus + kartu Super Panel + traffic tes tidak dihitung
async function callJson(method, path, obj, headers = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  const req = new Request(base + path, { method, headers: h, body: obj === null ? undefined : JSON.stringify(obj) });
  return worker.fetch(req, env);
}
const ltGood = { vu: 10, duration_s: 60, p95_ms: 320.5, failed_rate: 0.02, passed: true, paths: [{ path: '/', status: 200, p95_ms: 310, failed_rate: 0, checks_passed: true }] };
r = await callJson('POST', '/api/loadtest-results', ltGood);
assert(r.status === 503, 'loadtest: secret belum diset ditolak 503 (fail-closed)');
assert(env.DB.loadtestRuns.length === 0, 'loadtest: 503 tidak menyimpan run');
env.LOADTEST_TOKEN = 'test-loadtest-token';
r = await callJson('POST', '/api/loadtest-results', ltGood);
assert(r.status === 401, 'loadtest: tanpa token ditolak 401');
r = await callJson('POST', '/api/loadtest-results', ltGood, { authorization: 'Bearer salah' });
assert(r.status === 401, 'loadtest: token salah ditolak 401');
assert(env.DB.loadtestRuns.length === 0, 'loadtest: 401 tidak menyimpan run');
r = await callJson('POST', '/api/loadtest-results', { ...ltGood, vu: 'sepuluh' }, { authorization: 'Bearer test-loadtest-token' });
assert(r.status === 400, 'loadtest: vu bukan angka ditolak 400');
r = await callJson('POST', '/api/loadtest-results', { ...ltGood, failed_rate: 1.5 }, { authorization: 'Bearer test-loadtest-token' });
assert(r.status === 400, 'loadtest: failed_rate di luar 0-1 ditolak 400');
r = await callJson('POST', '/api/loadtest-results', { ...ltGood, passed: 'ya' }, { authorization: 'Bearer test-loadtest-token' });
assert(r.status === 400, 'loadtest: passed bukan boolean ditolak 400');
r = await callJson('POST', '/api/loadtest-results', { ...ltGood, paths: Array.from({ length: 21 }, () => ({ path: '/', status: 200, p95_ms: 1, failed_rate: 0, checks_passed: true })) }, { authorization: 'Bearer test-loadtest-token' });
assert(r.status === 400, 'loadtest: paths lebih dari 20 ditolak 400');
r = await callJson('POST', '/api/loadtest-results', { ...ltGood, paths: [{ path: 'x'.repeat(201), status: 200, p95_ms: 1, failed_rate: 0, checks_passed: true }] }, { authorization: 'Bearer test-loadtest-token' });
assert(r.status === 400, 'loadtest: path lebih dari 200 karakter ditolak 400');
r = await callJson('POST', '/api/loadtest-results', { ...ltGood, junk: 'x'.repeat(25000) }, { authorization: 'Bearer test-loadtest-token' });
assert(r.status === 413, 'loadtest: body lebih dari 20 KB ditolak 413');
assert(env.DB.loadtestRuns.length === 0, 'loadtest: semua payload invalid tidak menyimpan run');
r = await callJson('POST', '/api/loadtest-results', ltGood, { authorization: 'Bearer test-loadtest-token' });
assert(r.status === 201, 'loadtest: token benar tersimpan 201 (tanpa sesi admin)');
assert(env.DB.loadtestRuns.length === 1 && env.DB.loadtestRuns[0].vu === 10, 'loadtest: run tersimpan di cms_loadtest_runs');
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(t.includes('Hasil Load Test') && t.includes('Lulus') && t.includes('10 VU') && t.includes('320.5 ms') && t.includes('gagal 2%') && t.includes('WIB'), 'loadtest: run muncul di Super Panel (Lulus, VU, p95, gagal%, WIB)');
assert(t.includes('status 200') && t.includes('checks lulus'), 'loadtest: per-jalur tampil di Super Panel');
r = await call('GET', '/kendali/super', null, userCookie); assert(r.status === 303, 'loadtest: Super Panel tetap hanya admin');
// Token load test tidak bisa dipakai login admin
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'test-loadtest-token' }); assert(r.status === 403, 'loadtest: token khusus tidak bisa login admin');
// Detail post dengan header X-Load-Test tidak menambah views
const ujiPost = env.DB.posts.find(x => x.slug === 'post-uji');
const viewsBefore = Number(ujiPost.views) || 0;
const eventsBefore = env.DB.viewEvents.length;
{
  const ltReq = new Request(base + '/post/post-uji', { method: 'GET', headers: { 'x-load-test': '1' } });
  r = await worker.fetch(ltReq, env); t = await r.text();
  assert(r.status === 200 && t.includes('Post Uji'), 'loadtest: detail post dengan header tes tetap tampil');
}
assert(Number(env.DB.posts.find(x => x.slug === 'post-uji').views) === viewsBefore, 'loadtest: header X-Load-Test tidak menambah counter views');
assert(env.DB.viewEvents.length === eventsBefore, 'loadtest: header X-Load-Test tidak menambah riwayat view_events');
r = await call('GET', '/post/post-uji'); assert(Number(env.DB.posts.find(x => x.slug === 'post-uji').views) === viewsBefore + 1, 'loadtest: tanpa header tes, views tetap bertambah normal');
// Backup ikut menyalin run load test
r = await call('POST', '/kendali/backup', { csrf }, cookie); assert(r.status === 303, 'loadtest: tombol backup redirect');
assert(env.BACKUP_DB.backupLoadtests >= 1, 'loadtest: backup menyalin run ke cms_backup_loadtest_runs');
// 30. Rate limit atomik (B1): batas ditegakkan, yang ditolak tidak menambah counter
env.DB.rateLimits = new Map();
assert(await checkRateLimit(env, 'uji', 3, 60000) === true, 'rate-limit atomik: 1 dari 3 lolos');
assert(await checkRateLimit(env, 'uji', 3, 60000) === true, 'rate-limit atomik: 2 dari 3 lolos');
assert(await checkRateLimit(env, 'uji', 3, 60000) === true, 'rate-limit atomik: 3 dari 3 lolos');
assert(await checkRateLimit(env, 'uji', 3, 60000) === false, 'rate-limit atomik: ke-4 ditolak');
assert(await checkRateLimit(env, 'uji', 3, 60000) === false, 'rate-limit atomik: ke-5 tetap ditolak');
const rlKey = 'uji:' + Math.floor(Date.now() / 60000);
assert(env.DB.rateLimits.get(rlKey).count === 3, 'rate-limit atomik: yang ditolak tidak menambah counter (tetap 3)');
assert(await checkRateLimit(env, 'uji', 3, 1000) === true, 'rate-limit atomik: jendela lain = bucket baru');
env.DB.rateLimits = new Map();
// 31. Batas panjang password komentator 8–128 (B2)
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'pw7', password: '1234567' }); assert(r.status === 400, 'password: 7 karakter ditolak 400');
r = await call('POST', '/akun/daftar', { username: 'pw8', password: '12345678', email: 'pw8@example.com' }); assert(r.status === 303, 'password: 8 karakter lolos');
await verifikasiKode('pw8@example.com');
r = await call('POST', '/akun/daftar', { username: 'pw128', password: 'x'.repeat(128), email: 'pw128@example.com' }); assert(r.status === 303, 'password: 128 karakter lolos');
await verifikasiKode('pw128@example.com');
r = await call('POST', '/akun/daftar', { username: 'pw129', password: 'x'.repeat(129) }); assert(r.status === 400, 'password: 129 karakter ditolak 400');
assert(![...env.DB.users.values()].some(u => u.username === 'pw129'), 'password: 129 karakter tidak membuat akun');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/login', { username: 'pw8', password: 'x'.repeat(200) }); assert(r.status === 403, 'password: login 200 karakter ditolak 403 generik');
r = await call('POST', '/akun/login', { username: 'pw8', password: '12345678' }); assert(r.status === 303, 'password: login benar tetap lolos setelah percobaan panjang');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'pwspasi', password: '  rahasia123  ', email: 'pwspasi@example.com' }); assert(r.status === 303, 'password: spasi di awal/akhir diterima sebagai bagian password');
await verifikasiKode('pwspasi@example.com');
r = await call('POST', '/akun/login', { username: 'pwspasi', password: 'rahasia123' }); assert(r.status === 403, 'password: login dengan spasi di-trim ditolak (tidak di-trim)');
r = await call('POST', '/akun/login', { username: 'pwspasi', password: '  rahasia123  ' }); assert(r.status === 303, 'password: login dengan spasi persis lolos');
const savedToken = env.ADMIN_TOKEN;
env.ADMIN_TOKEN = 't'.repeat(200);
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 't'.repeat(200) }); assert(r.status === 303 && (r.headers.get('location') || '') === '/kendali', 'password: login admin dengan token 200 karakter tetap lolos (tidak dibatasi)');
env.ADMIN_TOKEN = savedToken;
// 32. Retensi analitik + prune bertahap (B6)
assert(VIEW_EVENTS_RETENTION_DAYS === 90, 'retensi: view events disimpan 90 hari');
const oldIso = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
const newIso = new Date().toISOString();
env.DB.viewEvents = [];
for (let i = 0; i < 3; i++) env.DB.viewEvents.push({ id: ++env.DB.viewEventSeq, post_id: 'p-lama', viewed_at: oldIso });
for (let i = 0; i < 2; i++) env.DB.viewEvents.push({ id: ++env.DB.viewEventSeq, post_id: 'p-baru', viewed_at: newIso });
let pruned = await pruneAnalytics(env);
assert(pruned === 3, 'prune: 3 event lama terhapus');
assert(env.DB.viewEvents.length === 2 && env.DB.viewEvents.every(e => e.post_id === 'p-baru'), 'prune: event baru dipertahankan');
pruned = await pruneAnalytics(env);
assert(pruned === 0, 'prune: pemanggilan kedua tidak menghapus apa-apa');
env.DB.viewEvents = [];
for (let i = 0; i < 1200; i++) env.DB.viewEvents.push({ id: ++env.DB.viewEventSeq, post_id: 'p-lama', viewed_at: oldIso });
pruned = await pruneAnalytics(env);
assert(pruned === 500 && env.DB.viewEvents.length === 700, 'prune bertahap: pemanggilan pertama 500');
pruned = await pruneAnalytics(env);
assert(pruned === 500 && env.DB.viewEvents.length === 200, 'prune bertahap: pemanggilan kedua 500');
pruned = await pruneAnalytics(env);
assert(pruned === 200 && env.DB.viewEvents.length === 0, 'prune bertahap: pemanggilan ketiga 200, bersih');
env.DB.rateLimits = new Map();
env.DB.rateLimits.set('lama:1', { count: 5, window_start: oldIso });
env.DB.rateLimits.set('baru:1', { count: 2, window_start: newIso });
env.DB.attempts = [{ id: ++env.DB.attemptSeq, ip: '1.2.3.4', created_at: oldIso }, { id: ++env.DB.attemptSeq, ip: '5.6.7.8', created_at: newIso }];
pruned = await pruneRateTables(env);
assert(pruned === 2, 'prune rate: bucket lama + jejak login lama terhapus (2)');
assert(!env.DB.rateLimits.has('lama:1') && env.DB.rateLimits.has('baru:1'), 'prune rate: bucket baru dipertahankan');
assert(env.DB.attempts.length === 1 && env.DB.attempts[0].ip === '5.6.7.8', 'prune rate: jejak login baru dipertahankan');
const cutoff30 = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
env.DB.viewEvents = [{ id: ++env.DB.viewEventSeq, post_id: 'p-lama', viewed_at: oldIso }, { id: ++env.DB.viewEventSeq, post_id: 'p-baru', viewed_at: newIso }];
const evs30 = await env.DB.prepare(`SELECT post_id, viewed_at FROM cms_view_events WHERE viewed_at >= ? ORDER BY viewed_at DESC`).bind(cutoff30).all();
assert(evs30.results.length === 1 && evs30.results[0].post_id === 'p-baru', 'dashboard: query view events hanya 30 hari terakhir');
env.DB.viewEvents = [];
env.DB.rateLimits = new Map();
env.DB.attempts = [];
// 33. Super Panel bisa dilipat + pagination admin + notice aksi (A)
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(t.includes('<details') && t.includes('<summary>Traffic Lengkap</summary>') && t.includes('<summary>Situs</summary>') && t.includes('<summary>Event PC Builder (game)</summary>'), 'super panel: kartu dalam <details>/<summary>');
assert(t.includes('Traffic Lengkap') && t.includes('views total') && t.includes('Per Hari') && t.includes('Per Post'), 'super panel: isi traffic tetap lengkap setelah dilipat');
assert(t.includes('20 teratas'), 'super panel: per-post dibatasi 20 teratas (bukan semua post)');
r = await call('GET', '/'); t = await r.text();
assert(t.includes(':focus-visible'), 'a11y: CSS :focus-visible ada di semua halaman');
for (let i = 1; i <= 25; i++) {
  env.DB.posts.push({ id: 'pgadm-' + i, slug: 'admin-pg-' + i, title: 'AdminPg ' + String(i).padStart(2, '0'), body: 'x', category: 'Umum', status: 'published', created_at: '2026-02-01T00:' + String(i).padStart(2, '0') + ':00.000Z', updated_at: '2026-02-01T00:00:00.000Z', body_mode: 'text', visibility: 'public', publish_at: '2026-02-01T00:' + String(i).padStart(2, '0') + ':00.000Z', post_password_hash: '', post_password_salt: '', views: i });
}
r = await call('GET', '/kendali/posts', null, cookie); t = await r.text();
assert(t.includes('AdminPg 25') && !t.includes('AdminPg 01') && t.includes('Halaman 1 dari'), 'pagination post: halaman 1 berisi 20 terbaru + info halaman');
r = await call('GET', '/kendali/posts?page=2', null, cookie); t = await r.text();
assert(t.includes('AdminPg 01') && !t.includes('AdminPg 25') && t.includes('Halaman 2 dari'), 'pagination post: halaman 2 berisi sisanya');
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'terang' }, cookie);
assert((r.headers.get('location') || '') === '/kendali/settings?notice=pengaturan-disimpan', 'notice: simpan pengaturan redirect membawa notice');
r = await call('GET', '/kendali/settings?notice=pengaturan-disimpan', null, cookie); t = await r.text();
assert(t.includes('Berhasil:') && t.includes('Pengaturan disimpan.'), 'notice: banner berhasil tampil di halaman tujuan');
r = await call('GET', '/kendali/settings?notice=tidak-ada', null, cookie); t = await r.text();
assert(!t.includes('Berhasil:'), 'notice: slug tidak dikenal tidak menampilkan banner');
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(commentId) }, cookie);
assert((r.headers.get('location') || '').includes('notice=komentar-disetujui'), 'notice: setujui komentar redirect membawa notice');
// 34. Sanitasi HTML: baterai vektor serangan (B3)
const badVectors = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="java&#115;cript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<iframe src="https://evil.test"></iframe>',
  '<object data="https://evil.test/x.swf"></object>',
  '<form action="https://evil.test"><input type="submit"></form>',
  '<details open ontoggle=alert(1)>x</details>',
  '<math><mi//xlink:href="data:x,<script>alert(4)</script>">',
  '<select><option><style></option></select><img src=x onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<div style="xss:expr/*XSS*/ession(alert(1))">x</div>',
  '<a href="https://ok.test" title=\'"><img src=x onerror=alert(1)>\'>x</a>',
  '<body background="javascript:alert(1)">x</body>',
  '<link rel="stylesheet" href="https://evil.test/x.css">',
];
for (const v of badVectors) {
  const out = sanitizeHtml(v);
  assert(!/<script/i.test(out) && !/on\w+\s*=/.test(out) && !/javascript:/i.test(out) && !/vbscript:/i.test(out) && !/data:text\/html/i.test(out) && !/<iframe/i.test(out) && !/<object/i.test(out) && !/<form/i.test(out) && !/<style/i.test(out), 'sanitasi: vektor dibersihkan: ' + v.slice(0, 40));
}
const goodHtml = sanitizeHtml('<p>Halo <b>Dunia</b></p><a href="https://ok.test">tautan</a><img src="https://ok.test/a.png" alt="gambar"><video controls src="https://ok.test/v.mp4"></video>');
assert(goodHtml.includes('<p>Halo <b>Dunia</b></p>') && goodHtml.includes('<a href="https://ok.test">tautan</a>') && goodHtml.includes('<img src="https://ok.test/a.png" alt="gambar" />') && goodHtml.includes('<video controls src="https://ok.test/v.mp4">'), 'sanitasi: tag + media yang diizinkan tetap lolos');
// 35. Batas ukuran request tanpa Content-Length (B4)
async function callStream(method, path, bodyText, cookie = '') {
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(bodyText)); c.close(); } });
  const req = new Request(base + path, { method, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: stream, duplex: 'half' });
  return worker.fetch(req, env);
}
env.DB.rateLimits = new Map();
r = await callStream('POST', '/akun/daftar', 'username=stream1&password=' + 'y'.repeat(300000));
assert(r.status === 413, 'body cap: POST 300 KB tanpa Content-Length ditolak 413');
env.DB.rateLimits = new Map();
r = await callStream('POST', '/akun/daftar', 'username=streamok&password=password123&email=streamok@example.com');
assert(r.status === 303, 'body cap: POST kecil tanpa Content-Length tetap jalan (daftar lolos)');
assert([...env.DB.users.values()].some(u => u.username === 'streamok'), 'body cap: akun dari body chunked tersimpan');
// 36. Grace rantai multi-lompatan (B5): tiga request bersamaan dengan
// token refresh lama yang sama — ketiganya berhasil, tanpa pencabutan massal
env.DB.attempts = [];
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'test-admin-token' });
const cookie36 = cookieHeader(cookiesOf(r));
const refresh36 = cookie36.split('; ').find(c => c.startsWith('cms_refresh='));
r = await call('GET', '/kendali', null, refresh36); assert(r.status === 200, 'grace rantai: pemakaian pertama (rotasi) berhasil');
r = await call('GET', '/kendali', null, refresh36); assert(r.status === 200, 'grace rantai: pemakaian kedua (lompatan 1) berhasil');
r = await call('GET', '/kendali', null, refresh36); assert(r.status === 200, 'grace rantai: pemakaian ketiga (lompatan 2) berhasil');
assert(env.DB.refreshTokens.some(x => x.revoked === 0), 'grace rantai: tidak ada pencabutan massal');
// 37. Port 11 Nov 2026: /bio + /uptime + HackLab + API Dracin + H2 backup
// (fitur live v44 yang sempat hilang di deploy v45 lalu di-port ke repo)
// callJson sudah didefinisikan di seksi 29 — dipakai ulang di sini.
r = await call('GET', '/bio'); t = await r.text();
assert(r.status === 200 && t.includes('Link Bio'), '/bio: halaman Link Bio tampil');
r = await call('GET', '/uptime'); t = await r.text();
assert(r.status === 200 && t.includes('Status Situs') && t.includes('Online sejak 1 Januari 2024'), '/uptime: halaman status tampil');
// v74: grafik kunjungan 30 hari + globe serangan (data fixture security_events)
assert(t.includes('Kunjungan tercatat') && t.includes('attack-globe') && t.includes('"c":"US"') && t.includes('"c":"CN"') && t.includes('login admin gagal'), '/uptime: grafik kunjungan + globe serangan tampil (data fixture)');
// v76: globe interaktif — seret untuk putar, warna busur per negara, ketuk titik untuk detail
assert(t.includes('id="globe-detail"') && t.includes('Ketuk titik') && t.includes('Seret globe'), '/uptime: globe interaktif (seret + ketuk detail)');
assert(t.includes('"col":"#') && t.includes('pointerdown'), '/uptime: warna busur per negara (drag + warna)');
r = await callJson('GET', '/api/hacklab/lessons', null);
let j = await r.json();
assert(r.status === 200 && Array.isArray(j.lessons) && j.lessons.length === 0, 'hacklab: katalog pelajaran kosong di mock');
// ---- v62: API konten Cerpen dari D1 (path muter tiap jam) ----
async function cerpenHashForTest(offsetMs = 0) {
  const keyHex = env.CERPEN_PATH_KEY;
  const keyBytes = new Uint8Array(keyHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const d = new Date(Date.now() + offsetMs + 7 * 3600000);
  const hour = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCHours()).padStart(2, '0');
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(hour));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}
const cHash = await cerpenHashForTest(0);
r = await callJson('GET', `/api/c/${cHash}/cerpen/manifest`, null);
j = await r.json();
assert(r.status === 200 && j.version === '1' && j.counts && j.counts.cerpen_series === 1, 'cerpen-api: manifest terbaca dengan hash jam ini');
r = await callJson('GET', `/api/c/${'0'.repeat(12)}/cerpen/manifest`, null);
assert(r.status === 404, 'cerpen-api: hash salah ditolak 404');
r = await callJson('GET', `/api/c/${cHash}/cerpen/series`, null);
j = await r.json();
assert(r.status === 200 && Array.isArray(j.series) && j.series.length === 1 && j.series[0].id === 'cerpen-01', 'cerpen-api: daftar series terbaca');
r = await callJson('GET', `/api/c/${cHash}/cerpen/episodes?series=cerpen-01&season=1`, null);
j = await r.json();
assert(r.status === 200 && Array.isArray(j.episodes) && j.episodes.length === 2, 'cerpen-api: daftar episode terbaca');
r = await callJson('GET', `/api/c/${cHash}/cerpen/episode?series=cerpen-01&season=1&no=1`, null);
j = await r.json();
assert(r.status === 200 && j.episode && j.episode.isi_cipher === 'QUJD', 'cerpen-api: isi episode terbaca (cipher)');
r = await callJson('GET', `/api/c/${cHash}/cerpen/episode?series=cerpen-01&season=1`, null);
assert(r.status === 400, 'cerpen-api: parameter kurang ditolak 400');
r = await callJson('GET', `/api/c/${cHash}/cerpen/episode?series=cerpen-01&season=1&no=99`, null);
assert(r.status === 404, 'cerpen-api: episode tidak ada ditolak 404');
r = await callJson('GET', `/api/c/${cHash}/cerpen/komik`, null);
j = await r.json();
assert(r.status === 200 && Array.isArray(j.komik) && j.komik.length === 1, 'cerpen-api: daftar komik terbaca');
r = await callJson('GET', `/api/c/${cHash}/cerpen/komik-episode?komik=komik-01&no=1`, null);
j = await r.json();
assert(r.status === 200 && j.episode && j.episode.panels_cipher === 'UEFORQ==', 'cerpen-api: episode komik terbaca (cipher)');
r = await callJson('GET', `/api/c/${cHash}/cerpen/news?limit=1`, null);
j = await r.json();
assert(r.status === 200 && Array.isArray(j.news) && j.news.length === 1, 'cerpen-api: berita terbaca');
const oldHash = await cerpenHashForTest(-3600000);
r = await callJson('GET', `/api/c/${oldHash}/cerpen/manifest`, null);
assert(r.status === 200, 'cerpen-api: hash jam sebelumnya masih diterima (toleransi ±1 jam)');
r = await callJson('GET', `/api/c/${cHash}/cerpen/all`, null);
j = await r.json();
assert(r.status === 200 && j.version === '1' && j.series.length === 1 && j.episodes.length === 2 && j.komik.length === 1 && j.komik_episodes.length === 1 && j.news.length === 1 && j.counts.cerpen_episodes === 2, 'cerpen-api: dump penuh all berisi semua koleksi + counts');
const savedCerpenBak = env.BACKUP_DB; delete env.BACKUP_DB;
r = await callJson('GET', `/api/c/${cHash}/cerpen/manifest`, null);
assert(r.status === 503, 'cerpen-api: tanpa BACKUP_DB -> 503');
env.BACKUP_DB = savedCerpenBak;
r = await callJson('GET', '/api/dracin/catalog', null);
j = await r.json();
assert(r.status === 200 && j.ok === true && Array.isArray(j.titles), 'dracin: katalog publik bisa dibaca tanpa kunci');
r = await callJson('POST', '/api/dracin/sync', { titles: [] });
assert(r.status === 401, 'dracin: sync tanpa kunci ditolak 401');
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(t.includes('API Dracin') && t.includes('Buat Kunci Baru'), 'super panel: kartu API Dracin tampil');
const csrf37 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
r = await call('POST', '/kendali/super/dracin-keys', { csrf: csrf37, action: 'create', name: 'tes-sync', scope: 'sync' }, cookie);
t = await r.text();
const rawKey = (t.match(/<code>([^<]+)<\/code>/) || [])[1] || '';
assert(r.status === 200 && rawKey.length > 20, 'dracin: kunci baru tampil sekali setelah dibuat');
r = await callJson('POST', '/api/dracin/sync', { titles: [{ platform: 'tes', title_id: 't1', title: 'Judul Tes', episodes: [{ idx: 0, item_id: 'e0' }] }] }, { authorization: 'Bearer ' + rawKey });
j = await r.json();
assert(r.status === 200 && j.ok === true && j.titles === 1 && j.episodes === 1, 'dracin: sync 1 judul + 1 episode berhasil');
r = await callJson('GET', '/api/dracin/catalog', null);
j = await r.json();
assert(j.titles.some(x => x.title_id === 't1' && x.title === 'Judul Tes'), 'dracin: judul hasil sync tampil di katalog');
env.DB.settings.set('imgbb_api_keys', '["rahasia"]');
env.DB.settings.set('csrf_secret', 'rahasia-csrf');
env.BACKUP_DB.backupSettings = [];
r = await call('POST', '/kendali/backup', { csrf: csrf37 }, cookie); assert(r.status === 303, 'backup H2: tombol backup redirect');
const bakKeys = (env.BACKUP_DB.backupSettings || []).map(x => x.key);
assert(!bakKeys.includes('imgbb_api_keys') && !bakKeys.includes('csrf_secret'), 'backup H2: kunci ImgBB + csrf_secret tidak disalin');
assert(bakKeys.includes('site_title'), 'backup H2: pengaturan biasa tetap disalin');
// 37b. Code viewer <pre> (11 Nov 2026): kode satu baris + geser horizontal,
// BUKAN patah mid-word; tombol Salin + label bahasa tersaji (port live v44).
const htmlTerang = themes.terang.render({ siteTitle: 'T', pageTitle: 'P', content: '' });
assert(htmlTerang.includes('pre{max-width:100%;overflow-x:auto') && htmlTerang.includes('white-space:pre;') && !htmlTerang.includes('pre-wrap'), 'tema: blok <pre> code viewer satu baris + geser horizontal');
assert(htmlTerang.includes('copy-btn') && htmlTerang.includes('Salin'), 'tema: tombol Salin blok kode tersaji');
// Regresi 11 Nov 2026: penutup <\/script> di copyScript sempat ganda
// (\\), sehingga tag script tidak tertutup dan tombol Salin tidak jalan.
assert(!htmlTerang.includes('<\\/script>'), 'tema: tidak ada penutup script ber-backslash (copyScript harus jalan)');
// 37c. Footer (11 Nov 2026): teks "Online sejak..." diganti tautan Uptime ke /uptime
assert(htmlTerang.includes('<a href="/uptime">Uptime</a>'), 'tema: footer berisi tautan Uptime ke /uptime');
// 37d. Performa (11 Nov 2026): ensureSchema + hitung views WAJIB lewat
// batch D1 — tanpa ini isolate dingin butuh ~30 round-trip berurutan
// (TTFB 3–4,5 detik di situs sepi). Mock menghitung pemakaian batch.
assert(env.DB.batchCalls >= 1, 'performa: ensureSchema memakai DB.batch (bukan puluhan prepare berurutan)');
// 38. Remote config Cerpen Hozin (v61, 11 Nov 2026): endpoint publik
// /api/cerpen-config + pengaturan cerpen_config di /kendali/settings.
r = await call('GET', '/api/cerpen-config'); t = await r.text();
let cerpenCfg = JSON.parse(t);
assert(r.status === 200 && r.headers.get('content-type').includes('application/json') && cerpenCfg.version === 1 && Array.isArray(cerpenCfg.tabs) && cerpenCfg.tabs.length === 4 && cerpenCfg.tabs[0].id === 'cerbung' && cerpenCfg.tabs[0].label === 'Cerita' && cerpenCfg.banner === '' && cerpenCfg.accent === '', 'cerpen-config: endpoint publik mengembalikan default saat belum diset');
assert(r.headers.get('cache-control') === 'public, max-age=60', 'cerpen-config: header cache 60 detik');
// 13 Nov 2026 (v87): link donasi disalurkan ke config aplikasi.
env.DB.settings.set('donate_url', 'https://saweria.co/hozinking');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(cerpenCfg.donate_url === 'https://saweria.co/hozinking', 'cerpen-config: donate_url valid ikut ke respons');
env.DB.settings.set('donate_url', 'http://saweria.co/hozinking');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(!('donate_url' in cerpenCfg), 'cerpen-config: donate_url http (bukan https) tidak disertakan');
env.DB.settings.set('donate_url', 'https://saweria.co/hozinking\nhttps://jahat.test');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(!('donate_url' in cerpenCfg), 'cerpen-config: donate_url berisi whitespace/baris baru tidak disertakan');
env.DB.settings.set('donate_url', '');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(!('donate_url' in cerpenCfg), 'cerpen-config: donate_url kosong -> kunci tidak ada (aplikasi sembunyikan baris)');
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
const csrf38 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(t.includes('name="cerpen_config"') && t.includes('Remote Config — Cerpen Hozin'), 'cerpen-config: textarea + kartu tampil di Pengaturan');
// 38b. Editor visual Remote Config Cerpen (v79): baris per tab (label +
// tampil + naik/turun), banner, accent; textarea tetap pembawa submit.
assert(t.includes('id="cerpen-editor"') && t.includes('cerpen-tab-row') && t.includes('cerpen-tab-up') && t.includes('cerpen-tab-down') && t.includes('class="cerpen-tab-visible"') && t.includes('id="cerpen-banner"') && t.includes('id="cerpen-accent"') && t.includes('id="cerpen-accent-color"') && t.includes('id="cerpen-cfg-json"') && t.includes('id="cerpen_config"'), 'cerpen-editor: baris tab + tombol naik/turun + toggle tampil + banner + accent tampil di Pengaturan');
assert(t.includes('data-id="cerbung"') && t.includes('data-id="berita"') && t.includes('data-id="komik"') && t.includes('data-id="koleksi"'), 'cerpen-editor: keempat tab dirender sebagai baris (id read-only)');
assert(csrf38.length > 10, 'cerpen-config: token CSRF baru untuk tes simpan');
const cerpenValid = JSON.stringify({ version: 1, tabs: [{ id: 'komik', label: 'Komik Baru', visible: true }, { id: 'cerbung', label: 'Cerita', visible: true }, { id: 'berita', label: 'Berita', visible: false }, { id: 'koleksi', label: 'Koleksi', visible: true }], banner: 'Episode baru tiap hari!', accent: '#3b82f6' });
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: '{bukan json' }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('cerpen-config-tidak-valid'), 'cerpen-config: JSON tidak valid ditolak + notice gagal');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(cerpenCfg.tabs.length === 4 && cerpenCfg.tabs[0].id === 'cerbung' && cerpenCfg.banner === '', 'cerpen-config: JSON tidak valid tidak menimpa nilai lama (tetap default)');
r = await call('GET', '/kendali/settings?notice=cerpen-config-tidak-valid', null, cookie); t = await r.text();
assert(t.includes('Gagal:') && t.includes('tidak valid'), 'cerpen-config: notice gagal tampil di halaman Pengaturan');
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: JSON.stringify({ version: 1, tabs: [{ id: 'ngawur', label: 'X', visible: true }], banner: '', accent: '' }) }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('cerpen-config-tidak-valid'), 'cerpen-config: id tab di luar daftar ditolak');
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: JSON.stringify({ version: 1, tabs: [], banner: '', accent: 'biru' }) }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('cerpen-config-tidak-valid'), 'cerpen-config: accent bukan #RRGGBB ditolak');
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: JSON.stringify({ version: 1, tabs: [], banner: 'x'.repeat(141), accent: '' }) }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('cerpen-config-tidak-valid'), 'cerpen-config: banner >140 karakter ditolak');
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: cerpenValid }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('pengaturan-disimpan'), 'cerpen-config: config valid tersimpan');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(cerpenCfg.tabs[0].id === 'komik' && cerpenCfg.tabs[0].label === 'Komik Baru' && cerpenCfg.tabs[2].visible === false && cerpenCfg.banner === 'Episode baru tiap hari!' && cerpenCfg.accent === '#3b82f6', 'cerpen-config: config valid terbaca di endpoint (urutan + label + visible + banner + accent)');
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: JSON.stringify({ version: 1, tabs: [{ id: 'cerbung', label: 'x'.repeat(31), visible: true }], banner: '', accent: '' }) }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('cerpen-config-tidak-valid'), 'cerpen-config: label >30 karakter ditolak');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(cerpenCfg.tabs[0].id === 'komik' && cerpenCfg.accent === '#3b82f6', 'cerpen-config: penolakan tidak menimpa config valid yang sudah tersimpan');
// Regresi: form Super Panel (tanpa field cerpen_config) tetap menyimpan.
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', return_to: '/kendali/super' }, cookie);
assert((r.headers.get('location') || '') === '/kendali/super?notice=pengaturan-disimpan', 'cerpen-config: form tanpa field cerpen_config tetap jalan (Super Panel)');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(cerpenCfg.tabs[0].id === 'komik', 'cerpen-config: simpan tanpa field tidak menghapus config');
// Regresi: nilai rusak di DB -> endpoint tetap mengembalikan default.
env.DB.settings.set('cerpen_config', '{rusak');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(cerpenCfg.version === 1 && cerpenCfg.tabs.length === 4 && cerpenCfg.tabs[0].id === 'cerbung', 'cerpen-config: nilai rusak di DB -> endpoint mengembalikan default');
// 38c. Editor visual: bila config tersimpan rusak, editor tidak tampil —
// textarea mentah tetap ada (fallback). Lalu simpan hasil edit visual
// (urutan + tampil + banner) lewat kolom yang sama, dan pulihkan config
// valid sebelumnya supaya tes sesudahnya tidak berubah.
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(!t.includes('cerpen-tab-row') && !t.includes('id="cerpen-editor"') && t.includes('name="cerpen_config"'), 'cerpen-editor: config rusak di DB -> editor tidak tampil, textarea mentah tetap ada');
const cerpenEdited = JSON.stringify({ version: 1, tabs: [{ id: 'berita', label: 'Berita', visible: true }, { id: 'cerbung', label: 'Cerita', visible: true }, { id: 'komik', label: 'Komik', visible: true }, { id: 'koleksi', label: 'Koleksi', visible: false }], banner: 'Baca dulu!', accent: '' });
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: cerpenEdited }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('pengaturan-disimpan'), 'cerpen-editor: hasil edit visual tersimpan');
r = await call('GET', '/api/cerpen-config'); cerpenCfg = JSON.parse(await r.text());
assert(cerpenCfg.tabs[0].id === 'berita' && cerpenCfg.tabs[3].visible === false && cerpenCfg.banner === 'Baca dulu!' && cerpenCfg.accent === '', 'cerpen-editor: urutan + tampil + banner hasil edit terbaca di endpoint');
r = await call('POST', '/kendali/settings', { csrf: csrf38, site_title: 'WorkerCMS', theme: 'terang', cerpen_config: cerpenValid }, cookie);
assert(r.status === 303 && (r.headers.get('location') || '').includes('pengaturan-disimpan'), 'cerpen-editor: config valid sebelumnya dipulihkan');
// 39. Admin API Cerpen (v66, 12 Nov 2026): panel /kendali/cerpen-api + endpoint /api/admin/cerpen-*
r = await call('GET', '/kendali', null, cookie); t = await r.text();
const csrf39 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(csrf39.length > 10, 'cerpen-admin: token CSRF untuk tes API admin');
const admH = { cookie, 'x-csrf': csrf39 };
// Tanpa auth -> 401
r = await callJson('GET', '/api/admin/cerpen-keys', null, {}); assert(r.status === 401, 'cerpen-admin: daftar key tanpa auth ditolak 401');
r = await callJson('GET', '/api/admin/cerpen-submissions/stats', null, {}); assert(r.status === 401, 'cerpen-admin: stats tanpa auth ditolak 401');
r = await callJson('POST', '/api/admin/cerpen-keys', { key_hash: 'c'.repeat(64), name: 'x', daily_limit: 10 }, {}); assert(r.status === 401, 'cerpen-admin: daftar key tanpa auth ditolak 401');
// Dengan auth tapi tanpa CSRF -> 403
r = await callJson('GET', '/api/admin/cerpen-keys', null, { cookie }); assert(r.status === 403, 'cerpen-admin: daftar key tanpa CSRF ditolak 403');
// Daftar key: hash hanya 8 karakter pertama, tidak pernah utuh
r = await callJson('GET', '/api/admin/cerpen-keys', null, admH); let jj = await r.json();
assert(r.status === 200 && jj.ok && jj.keys.length === 2 && jj.keys.find(k => k.key_id === 'key-be663fc2').key_hash_prefix === 'aaaaaaaa' && !jj.keys.some(k => 'key_hash' in k), 'cerpen-admin: daftar key tampil, hash hanya 8 karakter pertama');
// Validasi daftar key baru
r = await callJson('POST', '/api/admin/cerpen-keys', { key_hash: 'tidak-valid', name: 'x', daily_limit: 10 }, admH); assert(r.status === 400, 'cerpen-admin: hash invalid ditolak 400');
r = await callJson('POST', '/api/admin/cerpen-keys', { key_hash: 'c'.repeat(64), name: 'x', daily_limit: 0 }, admH); assert(r.status === 400, 'cerpen-admin: limit 0 ditolak 400');
r = await callJson('POST', '/api/admin/cerpen-keys', { key_hash: 'a'.repeat(64), name: 'duplikat', daily_limit: 10 }, admH); assert(r.status === 409, 'cerpen-admin: hash duplikat ditolak 409');
// Daftar key baru OK + audit tercatat
r = await callJson('POST', '/api/admin/cerpen-keys', { key_hash: 'c'.repeat(64), name: 'kunci-baru', daily_limit: 20 }, admH); jj = await r.json();
assert(r.status === 201 && jj.ok && /^key-[0-9a-f]{8}$/.test(jj.key_id) && jj.key_hash_prefix === 'cccccccc', 'cerpen-admin: key baru terdaftar (201)');
const newKeyId = jj.key_id;
assert(env.BACKUP_DB.cerpenAdminAudit.some(a => a.action === 'key_create' && a.target_id === newKeyId), 'cerpen-admin: daftar key menulis audit');
// Revoke + unrevoke + limit
r = await callJson('POST', '/api/admin/cerpen-keys/' + newKeyId + '/revoke', {}, admH); jj = await r.json();
assert(r.status === 200 && jj.revoked === 1, 'cerpen-admin: revoke key');
r = await callJson('POST', '/api/admin/cerpen-keys/' + newKeyId + '/unrevoke', {}, admH); jj = await r.json();
assert(r.status === 200 && jj.revoked === 0, 'cerpen-admin: unrevoke key');
r = await callJson('POST', '/api/admin/cerpen-keys/' + newKeyId + '/limit', { daily_limit: 3 }, admH); jj = await r.json();
assert(r.status === 200 && jj.daily_limit === 3, 'cerpen-admin: ubah limit key');
r = await callJson('POST', '/api/admin/cerpen-keys/' + newKeyId + '/limit', { daily_limit: 101 }, admH); assert(r.status === 400, 'cerpen-admin: limit 101 ditolak 400');
// Hapus key (submission lama tetap tersimpan — dicek lewat stats sesudahnya)
r = await callJson('DELETE', '/api/admin/cerpen-keys/' + newKeyId, null, admH); assert(r.status === 200, 'cerpen-admin: hapus key');
r = await callJson('DELETE', '/api/admin/cerpen-keys/' + newKeyId, null, admH); assert(r.status === 404, 'cerpen-admin: hapus key yang sudah hilang -> 404');
// Stats per status + 24 jam terakhir
r = await callJson('GET', '/api/admin/cerpen-submissions/stats', null, admH); jj = await r.json();
assert(r.status === 200 && jj.ok && jj.total === 3 && jj.per_status.pending === 1 && jj.per_status.approved === 1 && jj.per_status.rejected === 1 && jj.per_status.applied === 0 && jj.last_24h === 3, 'cerpen-admin: stats per status + 24 jam');
// Daftar submissions + filter (payload_json TIDAK ada di daftar)
r = await callJson('GET', '/api/admin/cerpen-submissions', null, admH); jj = await r.json();
assert(r.status === 200 && jj.submissions.length === 3, 'cerpen-admin: daftar submissions (3)');
r = await callJson('GET', '/api/admin/cerpen-submissions?status=pending', null, admH); jj = await r.json();
assert(jj.submissions.length === 1 && jj.submissions[0].id === 'sub-aaaaaaaaaaaa' && !('payload_json' in jj.submissions[0]), 'cerpen-admin: filter status=pending, tanpa payload_json di daftar');
r = await callJson('GET', '/api/admin/cerpen-submissions?status=bogus', null, admH); assert(r.status === 400, 'cerpen-admin: filter status tidak valid -> 400');
// Detail: payload_json hanya di endpoint admin
r = await callJson('GET', '/api/admin/cerpen-submissions/sub-aaaaaaaaaaaa', null, admH); jj = await r.json();
assert(r.status === 200 && jj.submission.payload_json.includes('cerpen-99'), 'cerpen-admin: detail submission berisi payload_json');
r = await callJson('GET', '/api/admin/cerpen-submissions/sub-xxxxxxxxxxxx', null, admH); assert(r.status === 400, 'cerpen-admin: id submission tidak valid -> 400');
r = await callJson('GET', '/api/admin/cerpen-submissions/sub-000000000000', null, admH); assert(r.status === 404, 'cerpen-admin: detail submission hilang -> 404');
// Approve dari status bukan-pending -> 409
r = await callJson('POST', '/api/admin/cerpen-submissions/sub-bbbbbbbbbbbb/approve', {}, admH); assert(r.status === 409, 'cerpen-admin: approve dari status approved ditolak 409');
// Reject tanpa note / note terlalu pendek -> 400
r = await callJson('POST', '/api/admin/cerpen-submissions/sub-aaaaaaaaaaaa/reject', {}, admH); assert(r.status === 400, 'cerpen-admin: reject tanpa note ditolak 400');
r = await callJson('POST', '/api/admin/cerpen-submissions/sub-aaaaaaaaaaaa/reject', { note: 'ab' }, admH); assert(r.status === 400, 'cerpen-admin: reject note <3 karakter ditolak 400');
// Approve pending -> approved + audit; approve kedua -> 409
r = await callJson('POST', '/api/admin/cerpen-submissions/sub-aaaaaaaaaaaa/approve', { note: 'lolos' }, admH); jj = await r.json();
assert(r.status === 200 && jj.status === 'approved', 'cerpen-admin: approve pending -> approved');
assert(env.BACKUP_DB.cerpenAdminAudit.some(a => a.action === 'submission_approve' && a.target_id === 'sub-aaaaaaaaaaaa'), 'cerpen-admin: approve menulis audit');
r = await callJson('POST', '/api/admin/cerpen-submissions/sub-aaaaaaaaaaaa/approve', {}, admH); assert(r.status === 409, 'cerpen-admin: approve kedua ditolak 409');
// Halaman panel: tanpa auth -> redirect /akun; dengan auth -> tampil + masuk nav
r = await call('GET', '/kendali/cerpen-api'); assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun'), 'cerpen-admin: halaman panel tanpa auth dialihkan ke /akun');
r = await call('GET', '/kendali/cerpen-api', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('Cerpen API') && t.includes('Cerpen Uji Pending') && t.includes('key-be663fc2') && t.includes('Riwayat admin'), 'cerpen-admin: halaman panel tampil (statistik + keys + submissions + audit)');
assert(t.includes('href="/kendali/cerpen-api"'), 'cerpen-admin: panel masuk nav admin');
// Regresi v83.2 (13 Nov 2026): skrip inline panel harus valid. '\n' di dalam
// string kutip-tunggal pada prompt auto-approve (v68) dievaluasi template
// literal menjadi newline literal -> SyntaxError -> SELURUH blok skrip mati
// (tombol Detail tidak bereaksi sama sekali). Cek parse semua blok <script>.
for (const p83 of ['/kendali/cerpen-api', '/kendali/md-backup']) {
  const rr83 = await call('GET', p83, null, cookie); const hh83 = await rr83.text();
  const blocks83 = [...hh83.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert(blocks83.length > 0, 'skrip-inline: halaman ' + p83 + ' punya blok <script>');
  for (const b83 of blocks83) { let ok83 = true; try { new vm.Script(b83); } catch (e) { ok83 = false; } assert(ok83, 'skrip-inline: blok <script> di ' + p83 + ' lolos parse'); }
}
// 40. Share link Cerpen (v67, 12 Nov 2026): assetlinks + token AES-GCM +
// landing + resolve + admin revoke/unrevoke + rate limit.
r = await call('GET', '/.well-known/assetlinks.json'); t = await r.text();
assert(r.status === 200 && (r.headers.get('content-type') || '').includes('application/json'), 'share: assetlinks.json 200 + content-type JSON');
const assetlinks = JSON.parse(t);
assert(Array.isArray(assetlinks) && assetlinks.length === 1 && assetlinks[0].relation[0] === 'delegate_permission/common.handle_all_urls' && assetlinks[0].target.namespace === 'android_app' && assetlinks[0].target.package_name === 'com.hozinking.cerpen' && assetlinks[0].target.sha256_cert_fingerprints[0] === '75ba028f4f9b401b3f414a2b9e63617fa35b503c692c5f6c188e3724a7a01c1d', 'share: assetlinks berisi package + fingerprint rilis yang benar');
// Tanpa secret -> create fail-closed 503, token apa pun 404
delete env.SHARE_LINK_KEY;
r = await callJson('POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-01' });
assert(r.status === 503, 'share: tanpa SHARE_LINK_KEY, create ditolak 503 (fail-closed)');
r = await call('GET', '/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); assert(r.status === 404, 'share: tanpa secret, landing token apa pun 404');
env.SHARE_LINK_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
r = await callJson('POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-tidak-ada' });
assert(r.status === 404, 'share: create konten tak ada ditolak 404');
r = await callJson('POST', '/api/share/create', { content_type: 'video', content_id: 'cerpen-01' });
assert(r.status === 400, 'share: create content_type tidak valid ditolak 400');
r = await callJson('POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-01', device: 'POCO X6 Pro' });
jj = await r.json();
assert(r.status === 201 && jj.ok && /^https:\/\/cms\.test\/s\/[A-Za-z0-9_-]+$/.test(jj.url) && !jj.url.includes('cerpen-01'), 'share: create cerpen-01 -> 201 + URL opaque (tanpa id konten, ikut origin request)');
const shareUrl = jj.url;
const shareToken = shareUrl.split('/s/')[1];
const shareRow = env.BACKUP_DB.cerpenShareLinks.find(x => x.content_id === 'cerpen-01' && x.content_type === 'cerpen');
assert(shareRow && /^shr-[0-9a-f]{16}$/.test(shareRow.id) && Number(shareRow.revoked) === 0 && Number(shareRow.opens_count) === 0, 'share: baris link tersimpan (id shr-*, revoked 0, opens 0)');
r = await callJson('GET', '/api/share/resolve?token=' + shareToken, null);
jj = await r.json();
assert(r.status === 200 && jj.ok && jj.content_type === 'cerpen' && jj.content_id === 'cerpen-01' && jj.season === null && jj.episode_no === null, 'share: resolve token valid -> konten benar');
assert(env.BACKUP_DB.cerpenShareOpens.length === 1 && env.BACKUP_DB.cerpenShareOpens[0].via === 'app' && env.BACKUP_DB.cerpenShareOpens[0].share_id === shareRow.id, 'share: resolve mencatat pembukaan via=app');
r = await call('GET', '/s/' + shareToken); t = await r.text();
assert(r.status === 200 && t.includes('Surat Tanpa Nama') && t.includes('Buka di Aplikasi') && t.includes('intent://cms.test/s/') && t.includes('package=com.hozinking.cerpen') && t.includes('Download Aplikasi') && t.includes('github.com/hozin-king/cerpen-hozin/releases/latest'), 'share: landing berisi judul + tombol aplikasi (intent) + download');
// Backup host: request lewat workers.dev -> URL share + intent ikut host itu
async function callHost(host, method, path, obj = null) {
  const req = new Request(host + path, { method, headers: { 'content-type': 'application/json' }, body: obj === null ? undefined : JSON.stringify(obj) });
  return worker.fetch(req, env);
}
const _linksBefore = env.BACKUP_DB.cerpenShareLinks.length; const _opensBefore = env.BACKUP_DB.cerpenShareOpens.length;
r = await callHost('https://hozin-cms.muchammadhozin.workers.dev', 'POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-01', device: 'POCO X6 Pro' });
jj = await r.json();
assert(r.status === 201 && jj.ok && /^https:\/\/hozin-cms\.muchammadhozin\.workers\.dev\/s\/[A-Za-z0-9_-]+$/.test(jj.url), 'share: create via workers.dev -> 201 + URL backup (bukan hozinking.my.id)');
const wdToken = jj.url.split('/s/')[1];
r = await callHost('https://hozin-cms.muchammadhozin.workers.dev', 'GET', '/s/' + wdToken);
t = await r.text();
assert(r.status === 200 && t.includes('intent://hozin-cms.muchammadhozin.workers.dev/s/') && t.includes('Surat Tanpa Nama'), 'share: landing via workers.dev -> intent ikut host backup');
env.BACKUP_DB.cerpenShareLinks.splice(_linksBefore); env.BACKUP_DB.cerpenShareOpens.splice(_opensBefore);
assert(Number(env.BACKUP_DB.cerpenShareLinks.find(x => x.id === shareRow.id).opens_count) === 2 && env.BACKUP_DB.cerpenShareOpens.length === 2 && env.BACKUP_DB.cerpenShareOpens[1].via === 'browser', 'share: landing mencatat pembukaan via=browser + opens_count naik');
// Token rusak / token lain -> 404 (tidak dibedakan)
const badToken = shareToken.slice(0, -1) + (shareToken.slice(-1) === 'A' ? 'B' : 'A');
r = await callJson('GET', '/api/share/resolve?token=' + badToken, null); assert(r.status === 404, 'share: resolve token rusak ditolak 404');
r = await call('GET', '/s/' + badToken); assert(r.status === 404, 'share: landing token rusak ditolak 404');
r = await callJson('GET', '/api/share/resolve', null); assert(r.status === 404, 'share: resolve tanpa token ditolak 404');
r = await call('GET', '/s/!!!'); assert(r.status === 404, 'share: landing token karakter tidak valid ditolak 404');
// Episode spesifik + komik + berita
r = await callJson('POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-01', season: 1, episode_no: 2 });
jj = await r.json();
assert(r.status === 201 && jj.ok, 'share: create episode spesifik -> 201');
const epToken = jj.url.split('/s/')[1];
r = await callJson('GET', '/api/share/resolve?token=' + epToken, null); jj = await r.json();
assert(r.status === 200 && jj.season === 1 && jj.episode_no === 2, 'share: resolve episode mengembalikan season + episode_no');
r = await call('GET', '/s/' + epToken); t = await r.text();
assert(r.status === 200 && t.includes('Yang Tidak Beres'), 'share: landing episode menampilkan judul episode');
r = await callJson('POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-01', season: 1, episode_no: 99 });
assert(r.status === 404, 'share: create episode tak ada ditolak 404');
r = await callJson('POST', '/api/share/create', { content_type: 'komik', content_id: 'komik-01' });
assert(r.status === 201, 'share: create komik -> 201');
r = await callJson('POST', '/api/share/create', { content_type: 'berita', content_id: 'news-1' });
assert(r.status === 201, 'share: create berita -> 201');
// Admin: tanpa auth 401, tanpa CSRF 403, daftar + filter + detail
r = await callJson('GET', '/api/admin/cerpen-shares', null, {}); assert(r.status === 401, 'share-admin: daftar tanpa auth ditolak 401');
r = await callJson('GET', '/api/admin/cerpen-shares', null, { cookie }); assert(r.status === 403, 'share-admin: daftar tanpa CSRF ditolak 403');
r = await callJson('GET', '/api/admin/cerpen-shares', null, admH); jj = await r.json();
assert(r.status === 200 && jj.ok && jj.shares.length === 4 && jj.shares.some(s => s.id === shareRow.id) && Array.isArray(jj.top) && jj.top.some(s => s.content_id === 'cerpen-01'), 'share-admin: daftar 4 link + top shared berisi cerpen-01');
r = await callJson('GET', '/api/admin/cerpen-shares?content_type=komik', null, admH); jj = await r.json();
assert(jj.shares.length === 1 && jj.shares[0].content_type === 'komik', 'share-admin: filter content_type=komik');
r = await callJson('GET', '/api/admin/cerpen-shares?revoked=1', null, admH); jj = await r.json();
assert(jj.shares.length === 0, 'share-admin: filter revoked=1 kosong sebelum ada yang dicabut');
r = await callJson('GET', '/api/admin/cerpen-shares?content_type=bogus', null, admH); assert(r.status === 400, 'share-admin: filter content_type tidak valid -> 400');
r = await callJson('GET', '/api/admin/cerpen-shares/' + shareRow.id, null, admH); jj = await r.json();
assert(r.status === 200 && jj.share.id === shareRow.id && Array.isArray(jj.opens) && jj.opens.length === 2, 'share-admin: detail link + 2 pembukaan tercatat');
r = await callJson('GET', '/api/admin/cerpen-shares/shr-0000000000000000', null, admH); assert(r.status === 404, 'share-admin: detail link hilang -> 404');
r = await callJson('GET', '/api/admin/cerpen-shares/bukan-id', null, admH); assert(r.status === 400, 'share-admin: detail id tidak valid -> 400');
// Revoke: resolve + landing 404; unrevoke: pulih lagi; audit tercatat
r = await callJson('POST', '/api/admin/cerpen-shares/' + shareRow.id + '/revoke', {}, admH); jj = await r.json();
assert(r.status === 200 && jj.revoked === 1, 'share-admin: revoke link');
assert(env.BACKUP_DB.cerpenAdminAudit.some(a => a.action === 'share_revoke' && a.target_id === shareRow.id), 'share-admin: revoke menulis audit');
r = await callJson('GET', '/api/share/resolve?token=' + shareToken, null); assert(r.status === 404, 'share: resolve link dicabut ditolak 404');
r = await call('GET', '/s/' + shareToken); assert(r.status === 404, 'share: landing link dicabut ditolak 404');
r = await callJson('POST', '/api/admin/cerpen-shares/' + shareRow.id + '/unrevoke', {}, admH); jj = await r.json();
assert(r.status === 200 && jj.revoked === 0, 'share-admin: unrevoke link');
r = await callJson('GET', '/api/share/resolve?token=' + shareToken, null); assert(r.status === 200, 'share: resolve pulih setelah unrevoke');
r = await callJson('POST', '/api/admin/cerpen-shares/shr-0000000000000000/revoke', {}, admH); assert(r.status === 404, 'share-admin: revoke link hilang -> 404');
// Rate limit: create 20/jam, resolve 30/10 menit
env.DB.rateLimits = new Map();
for (let i = 0; i < 20; i++) {
  r = await callJson('POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-01' });
  assert(r.status === 201, 'share: rate-limit create ke-' + (i + 1) + ' dari 20 lolos');
}
r = await callJson('POST', '/api/share/create', { content_type: 'cerpen', content_id: 'cerpen-01' });
assert(r.status === 429, 'share: rate-limit create ke-21 ditolak 429');
env.DB.rateLimits = new Map();
for (let i = 0; i < 30; i++) {
  r = await callJson('GET', '/api/share/resolve?token=' + shareToken, null);
  assert(r.status === 200, 'share: rate-limit resolve ke-' + (i + 1) + ' dari 30 lolos');
}
r = await callJson('GET', '/api/share/resolve?token=' + shareToken, null);
assert(r.status === 429, 'share: rate-limit resolve ke-31 ditolak 429');
env.DB.rateLimits = new Map();
// Halaman panel memuat seksi Share
r = await call('GET', '/kendali/cerpen-api', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('Share Link') && t.includes('Konten paling sering di-share') && t.includes('Buka terakhir') && t.includes(shareRow.id) && t.includes('data-cerpen-share="revoke"'), 'share-admin: halaman panel memuat seksi Share + tombol cabut');
// 41. Auto-approve usulan Cerpen (v68, 12 Nov 2026): mode per key (off /
// always / 1d / 1w / 1mo / until) — submit dari key yang aktif langsung
// 'approved', applier VM yang menerapkannya. Default semua key: mati.
const aaKeyPlain = 'kunci-uji-auto-approve-' + Date.now().toString(36);
const aaKeyHash = await sha256Hex(aaKeyPlain);
r = await callJson('POST', '/api/admin/cerpen-keys', { key_hash: aaKeyHash, name: 'kunci-aa', daily_limit: 10 }, admH); jj = await r.json();
assert(r.status === 201 && jj.ok && jj.auto_approve_mode === 'off' && jj.auto_approve_until === null, 'auto-approve: key baru default mati (off)');
const aaKeyId = jj.key_id;
const aaSubmit = (n) => callJson('POST', '/api/cerpen-submit', { kind: 'cerpen', id: 'cerpen-aa-' + n, judul: 'Cerpen AA Uji ' + n, genre: 'Misteri', deskripsi: '', seasons: [{ season: 1, episodes: [{ no: 1, judul: 'Ep 1', isi: 'x'.repeat(300) }] }] }, { Authorization: 'Bearer ' + aaKeyPlain });
// Tanpa auth -> 401; tanpa CSRF -> 403
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'always' }, {}); assert(r.status === 401, 'auto-approve: set mode tanpa auth ditolak 401');
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'always' }, { cookie }); assert(r.status === 403, 'auto-approve: set mode tanpa CSRF ditolak 403');
// Validasi mode + until
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'bogus' }, admH); assert(r.status === 400, 'auto-approve: mode tidak valid ditolak 400');
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'until' }, admH); assert(r.status === 400, 'auto-approve: until tanpa tanggal ditolak 400');
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'until', until: Math.floor(Date.now() / 1000) - 60 }, admH); assert(r.status === 400, 'auto-approve: until di masa lalu ditolak 400');
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'until', until: Math.floor(Date.now() / 1000) + 366 * 86400 }, admH); assert(r.status === 400, 'auto-approve: until >1 tahun ditolak 400');
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'always' }, admH); jj = await r.json();
assert(r.status === 200 && jj.auto_approve_mode === 'always' && jj.auto_approve_until === null, 'auto-approve: set always');
assert(env.BACKUP_DB.cerpenAdminAudit.some(a => a.action === 'auto_approve_set' && a.target_id === aaKeyId && a.note.includes('mode=always')), 'auto-approve: set always menulis audit');
// Mode off -> submit pending
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'off' }, admH); jj = await r.json();
assert(r.status === 200 && jj.auto_approve_mode === 'off', 'auto-approve: set off');
r = await aaSubmit(1); jj = await r.json();
assert(r.status === 201 && jj.ok && jj.status === 'pending', 'auto-approve: mode off -> submit pending');
// Mode always -> submit approved + review_note auto-approved
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'always' }, admH); assert(r.status === 200, 'auto-approve: set always lagi');
r = await aaSubmit(2); jj = await r.json();
assert(r.status === 201 && jj.ok && jj.status === 'approved', 'auto-approve: mode always -> submit approved');
const aaRow2 = env.BACKUP_DB.cerpenSubmissions.find(x => x.id === jj.id);
assert(aaRow2 && aaRow2.status === 'approved' && (aaRow2.review_note || '').includes('auto-approved'), 'auto-approve: baris tersimpan approved + review_note auto-approved');
// Mode 1d -> expiry ~24 jam + submit approved
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: '1d' }, admH); jj = await r.json();
const aaNowSec = Math.floor(Date.now() / 1000);
assert(r.status === 200 && jj.auto_approve_mode === 'until' && jj.auto_approve_until > aaNowSec + 86000 && jj.auto_approve_until <= aaNowSec + 86400 + 5, 'auto-approve: 1d -> until ~24 jam');
r = await aaSubmit(3); jj = await r.json();
assert(r.status === 201 && jj.status === 'approved', 'auto-approve: mode 1d -> submit approved');
// Until kedaluwarsa -> submit pending (simulasikan lewat dengan mengubah baris mock)
const aaKeyRow = env.BACKUP_DB.cerpenApiKeys.find(k => k.key_id === aaKeyId);
aaKeyRow.auto_approve_mode = 'until'; aaKeyRow.auto_approve_until = Math.floor(Date.now() / 1000) - 10;
r = await aaSubmit(4); jj = await r.json();
assert(r.status === 201 && jj.status === 'pending', 'auto-approve: until kedaluwarsa -> submit pending');
// Until manual valid (1 jam) -> submit approved
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'until', until: Math.floor(Date.now() / 1000) + 3600 }, admH); jj = await r.json();
assert(r.status === 200 && jj.auto_approve_mode === 'until' && jj.auto_approve_until > aaNowSec, 'auto-approve: until manual 1 jam');
r = await aaSubmit(5); jj = await r.json();
assert(r.status === 201 && jj.status === 'approved', 'auto-approve: until manual valid -> submit approved');
// Dimatikan lagi -> submit pending; GET keys menampilkan setting
r = await callJson('POST', '/api/admin/cerpen-keys/' + aaKeyId + '/auto-approve', { mode: 'off' }, admH); assert(r.status === 200, 'auto-approve: dimatikan lagi');
r = await aaSubmit(6); jj = await r.json();
assert(r.status === 201 && jj.status === 'pending', 'auto-approve: dimatikan -> submit pending lagi');
r = await callJson('GET', '/api/admin/cerpen-keys', null, admH); jj = await r.json();
const aaKeyView = jj.keys.find(k => k.key_id === aaKeyId);
assert(aaKeyView && aaKeyView.auto_approve_mode === 'off' && aaKeyView.auto_approve_until === null, 'auto-approve: GET keys menampilkan setting (off)');
// Panel memuat kontrol Auto-approve
r = await call('GET', '/kendali/cerpen-api', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('Auto-approve') && t.includes('data-cerpen-aa='), 'auto-approve: panel memuat status + tombol Auto-approve per key');
// Key hilang -> 404
r = await callJson('POST', '/api/admin/cerpen-keys/key-00000000/auto-approve', { mode: 'always' }, admH); assert(r.status === 404, 'auto-approve: key hilang -> 404');
// 42. Auto-backup .md (v69, 12 Nov 2026): POST /api/md-backup + endpoint
// admin /api/admin/md-backup* + halaman /kendali/md-backup + viewer.
const mdPlain = 'md-uji-plain-1234567890';
const mdHash = await sha256Hex(mdPlain);
env.BACKUP_DB.mdBackupKeys.push({ key_id: 'mdk-cccccccc', key_hash: mdHash, name: 'kunci-uji-md', created_at: Date.now(), revoked: 0, daily_limit: 50 });
const mdLimitPlain = 'md-limit-uji-abcdef';
const mdLimitHash = await sha256Hex(mdLimitPlain);
env.BACKUP_DB.mdBackupKeys.push({ key_id: 'mdk-dddddddd', key_hash: mdLimitHash, name: 'kunci-limit', created_at: Date.now(), revoked: 0, daily_limit: 1 });
const mdAuth = { Authorization: 'Bearer ' + mdPlain };
const mdCall = (p, c) => callJson('POST', '/api/md-backup', p, c);
// Tanpa key / key salah -> 401
r = await mdCall({ path: 'a.md', content: 'x' }, {}); assert(r.status === 401, 'md-backup: tanpa key ditolak 401');
r = await mdCall({ path: 'a.md', content: 'x' }, { Authorization: 'Bearer salah' }); assert(r.status === 401, 'md-backup: key salah ditolak 401');
// Path tidak valid -> 400
r = await mdCall({ path: '../jahat.md', content: 'x' }, mdAuth); assert(r.status === 400, 'md-backup: path .. ditolak 400');
r = await mdCall({ path: '/absolut.md', content: 'x' }, mdAuth); assert(r.status === 400, 'md-backup: path absolut ditolak 400');
r = await mdCall({ path: 'a b.md', content: 'x' }, mdAuth); assert(r.status === 400, 'md-backup: path berisi spasi ditolak 400');
r = await mdCall({ path: 'a.md', content: '' }, mdAuth); assert(r.status === 400, 'md-backup: content kosong ditolak 400');
// Konten baru -> 201 v1; kirim ulang isi sama -> 409; isi beda -> 201 v2
r = await mdCall({ path: 'data/uji.md', content: '# Uji\n\nIsi pertama.' }, mdAuth); jj = await r.json();
assert(r.status === 201 && jj.ok && jj.version === 1 && /^mdb-[0-9a-f]{12}$/.test(jj.id) && !('content' in jj), 'md-backup: konten baru -> 201 v1 (tanpa echo content)');
const mdIdV1 = jj.id;
r = await mdCall({ path: 'data/uji.md', content: '# Uji\n\nIsi pertama.' }, mdAuth); assert(r.status === 409, 'md-backup: isi sama -> 409 duplicate_content');
r = await mdCall({ path: 'data/uji.md', content: '# Uji\n\nIsi kedua.' }, mdAuth); jj = await r.json();
assert(r.status === 201 && jj.version === 2, 'md-backup: isi beda -> 201 v2');
const mdIdV2 = jj.id;
// Rate limit harian: key limit 1 -> kirim ke-2 ditolak 429
r = await mdCall({ path: 'data/limit.md', content: 'satu' }, { Authorization: 'Bearer ' + mdLimitPlain }); assert(r.status === 201, 'md-backup: key limit 1 kirim pertama 201');
r = await mdCall({ path: 'data/limit.md', content: 'dua' }, { Authorization: 'Bearer ' + mdLimitPlain }); assert(r.status === 429, 'md-backup: key limit 1 kirim kedua 429');
// Admin tanpa auth -> 401; tanpa CSRF -> 403
r = await callJson('GET', '/api/admin/md-backups', null, {}); assert(r.status === 401, 'md-backup-admin: daftar tanpa auth ditolak 401');
r = await callJson('GET', '/api/admin/md-backup-keys', null, { cookie }); assert(r.status === 403, 'md-backup-admin: daftar key tanpa CSRF ditolak 403');
// Daftar file: tanpa content, path + jumlah versi tampil
r = await callJson('GET', '/api/admin/md-backups', null, admH); jj = await r.json();
assert(r.status === 200 && jj.ok && jj.files.some(f => f.path === 'data/uji.md' && f.versions === 2 && f.latest_version === 2) && !JSON.stringify(jj.files).includes('Isi pertama'), 'md-backup-admin: daftar file tanpa content (versi benar)');
// Daftar versi satu path
r = await callJson('GET', '/api/admin/md-backups?path=data%2Fuji.md', null, admH); jj = await r.json();
assert(r.status === 200 && jj.versions.length === 2 && jj.versions[0].version === 2, 'md-backup-admin: daftar versi satu path');
// Detail satu versi mengembalikan content
r = await callJson('GET', '/api/admin/md-backups/' + mdIdV2, null, admH); jj = await r.json();
assert(r.status === 200 && jj.backup.content.includes('Isi kedua'), 'md-backup-admin: detail versi mengembalikan content');
// Restore membuat versi baru (v3) dengan isi v1
r = await callJson('POST', '/api/admin/md-backups/' + mdIdV1 + '/restore', {}, admH); jj = await r.json();
assert(r.status === 200 && jj.version === 3, 'md-backup-admin: restore membuat v3');
r = await callJson('GET', '/api/admin/md-backups/' + jj.id, null, admH); jj = await r.json();
assert(r.status === 200 && jj.backup.content.includes('Isi pertama'), 'md-backup-admin: hasil restore berisi isi v1');
// Hapus satu versi -> 404 setelahnya; audit tercatat
r = await callJson('DELETE', '/api/admin/md-backups/' + mdIdV1, null, admH); assert(r.status === 200, 'md-backup-admin: hapus versi');
r = await callJson('GET', '/api/admin/md-backups/' + mdIdV1, null, admH); assert(r.status === 404, 'md-backup-admin: versi terhapus -> 404');
assert(env.BACKUP_DB.cerpenAdminAudit.some(a => a.action === 'md_restore' || a.action === 'md_delete'), 'md-backup-admin: restore/hapus menulis audit');
// Kunci .md: daftar (hash hanya 8 karakter), revoke -> submit 401, unrevoke, limit
r = await callJson('GET', '/api/admin/md-backup-keys', null, admH); jj = await r.json();
assert(r.status === 200 && jj.keys.some(k => k.key_id === 'mdk-cccccccc' && k.key_hash_prefix.length === 8 && !('key_hash' in k)), 'md-backup-admin: daftar key, hash hanya 8 karakter');
r = await callJson('POST', '/api/admin/md-backup-keys/mdk-cccccccc/revoke', {}, admH); jj = await r.json();
assert(r.status === 200 && jj.revoked === 1, 'md-backup-admin: revoke key');
r = await mdCall({ path: 'data/uji.md', content: 'x baru' }, mdAuth); assert(r.status === 401, 'md-backup: key dicabut -> submit 401');
r = await callJson('POST', '/api/admin/md-backup-keys/mdk-cccccccc/unrevoke', {}, admH); assert(r.status === 200, 'md-backup-admin: unrevoke key');
r = await callJson('POST', '/api/admin/md-backup-keys/mdk-cccccccc/limit', { daily_limit: 101 }, admH); assert(r.status === 400, 'md-backup-admin: limit 101 ditolak 400');
r = await callJson('POST', '/api/admin/md-backup-keys/mdk-00000000/revoke', {}, admH); assert(r.status === 404, 'md-backup-admin: key hilang -> 404');
// Daftarkan kunci baru dari plaintext (v73): tanpa auth -> 401;
// kunci pendek -> 400; berhasil -> key_id mdk-... dan plaintext TIDAK
// kembali; kunci sama -> 409; kunci baru langsung bisa submit.
r = await callJson('POST', '/api/admin/md-backup-keys', { name: 'uji-baru', key: 'kunci-rahasia-uji-1234', daily_limit: 50 }, {}); assert(r.status === 401, 'md-backup-admin: daftar kunci tanpa auth ditolak 401');
r = await callJson('POST', '/api/admin/md-backup-keys', { name: 'uji-baru', key: 'pendek', daily_limit: 50 }, admH); assert(r.status === 400, 'md-backup-admin: kunci pendek ditolak 400');
r = await callJson('POST', '/api/admin/md-backup-keys', { name: 'uji-baru', key: 'kunci-rahasia-uji-1234', daily_limit: 50 }, admH); jj = await r.json();
assert(r.status === 200 && jj.ok && /^mdk-[0-9a-f]{8}$/.test(jj.key_id) && !('key_hash' in jj) && !('key' in jj), 'md-backup-admin: daftar kunci baru, plaintext tidak kembali');
r = await callJson('POST', '/api/admin/md-backup-keys', { name: 'duplikat', key: 'kunci-rahasia-uji-1234', daily_limit: 50 }, admH); assert(r.status === 409, 'md-backup-admin: kunci sama ditolak 409');
r = await mdCall({ path: 'data/baru.md', content: 'dari kunci baru' }, { Authorization: 'Bearer kunci-rahasia-uji-1234' }); assert(r.status === 201, 'md-backup: kunci baru terdaftar bisa submit');
// Halaman admin + viewer render ala GitHub
r = await call('GET', '/kendali/md-backup'); assert(r.status === 303 && (r.headers.get('location') || '') === '/akun?pesan=login', 'md-backup: halaman tanpa auth dialihkan ke login');
r = await call('GET', '/kendali/md-backup', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('Backup .md') && t.includes('data/uji.md'), 'md-backup: halaman admin memuat daftar file');
r = await call('GET', '/kendali/md-backup?view=mdb-111111111111', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('<h1>Panduan Muse Lain</h1>') && t.includes('<table>') && t.includes('<strong>tebal</strong>') && t.includes('☑'), 'md-backup: viewer merender heading/tabel/bold/task list');
// Renderer unit: XSS di-escape, link jahat tidak jadi <a>
assert(!renderMarkdown('<script>alert(1)</script>').includes('<script>'), 'md-render: script di-escape');
assert(renderMarkdown('[klik](javascript:alert(1))').includes('klik') && !renderMarkdown('[klik](javascript:alert(1))').includes('javascript:'), 'md-render: link javascript tidak dirender sebagai <a>');
assert(renderMarkdown('```js\nconst a = 1;\n```').includes('<pre><code>const a = 1;'), 'md-render: code block berpagar');
assert(renderMarkdown('snake_case tetap').includes('snake_case') && !renderMarkdown('snake_case tetap').includes('<em>'), 'md-render: snake_case tidak jadi miring');
// 42c. Laporan tamper FB Manager (v1.0.33, 13 Nov 2026): POST /api/app-tamper
// + halaman /kendali/tamper.
r = await callJson('POST', '/api/app-tamper', { package_found: 'com.palsu.fbmanager', label_found: 'FB Manager Palsu', signer_found: 'AA:BB:CC:DD', version_code: 34, version_name: '1.0.33', device_model: 'POCO X6 Pro', android_version: '14', timestamp: 1794444000000 });
jj = await r.json();
assert(r.status === 200 && jj.ok === true, 'app-tamper: laporan valid -> 200 {ok:true}');
assert(env.BACKUP_DB.tamperReports.length === 1 && env.BACKUP_DB.tamperReports[0].package_found === 'com.palsu.fbmanager' && env.BACKUP_DB.tamperReports[0].version_code === 34 && env.BACKUP_DB.tamperReports[0].device_model === 'POCO X6 Pro', 'app-tamper: baris tersimpan di BACKUP_DB (paket + version_code + perangkat)');
r = await callJson('POST', '/api/app-tamper', {});
assert(r.status === 400, 'app-tamper: body kosong ditolak 400');
r = await callJson('POST', '/api/app-tamper', []);
assert(r.status === 400, 'app-tamper: body array ditolak 400');
{
  const req = new Request(base + '/api/app-tamper', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bukan json' });
  r = await worker.fetch(req, env);
  assert(r.status === 400, 'app-tamper: body bukan JSON ditolak 400');
}
r = await call('GET', '/kendali/tamper'); assert(r.status === 303 && (r.headers.get('location') || '') === '/akun?pesan=login', 'app-tamper: halaman tanpa auth dialihkan ke login');
r = await call('GET', '/kendali/tamper', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('Laporan Tamper') && t.includes('com.palsu.fbmanager') && t.includes('POCO X6 Pro') && t.includes('Tamper'), 'app-tamper: halaman admin memuat laporan terbaru + nav Tamper');
// 43. Layout mobile panel admin (v70, 12 Nov 2026): baris .adm-row
// membungkus (flex-wrap) supaya di layar ~360px teks tidak pecah per
// karakter dan tombol tidak menutupi teks.
r = await call('GET', '/kendali/cerpen-api', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('.adm-row{display:flex;flex-wrap:wrap') && t.includes('.adm-row-body{flex:1 1 220px') && t.includes('.adm-row-title{') && t.includes('overflow-wrap:break-word'), 'layout-mobile: CSS baris admin membungkus + judul patah di batas kata');
r = await call('GET', '/kendali/md-backup', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('.adm-row{display:flex;flex-wrap:wrap') && t.includes('white-space:nowrap'), 'layout-mobile: halaman md-backup memakai CSS baris yang sama');
assert(r.status === 200 && t.includes('id="md-key-form"') && t.includes('Daftarkan kunci'), 'md-backup: form daftar kunci tampil di panel');
// 44. Nav admin tata ulang (v73, 12 Nov 2026): dari strip scroll horizontal
// jadi grid yang membungkus — semua menu kelihatan tanpa geser, dan nav
// tidak lagi sticky (tidak makan layar di HP).
r = await call('GET', '/kendali/md-backup', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('.adm-nav{display:flex;flex-wrap:wrap') && !t.includes('.adm-nav{position:sticky') && !t.includes('overflow-x:auto;padding:10px 8px'), 'layout-nav: nav admin grid membungkus, tanpa scroll horizontal dan tanpa sticky');
// 45. Waktu baca — logika murni reading.js (v81, 12 Nov 2026)
// 45a. WIB = UTC+7, nama hari Indonesia.
{
  const p = wibParts(Date.UTC(2026, 10, 12, 16, 0, 0)); // 23:00 WIB 12 Nov
  assert(p.date === '2026-11-12' && p.hour === 23 && p.dayName === 'Kamis', 'reading: wibParts tanggal/jam/nama hari WIB benar');
}
// 45b. Agregasi statistik: total, hari tersering, rentang jam.
{
  const st = computeReadingStats(
    [{ day_wib: '2026-11-10', seconds: 3600 }, { day_wib: '2026-11-11', seconds: 7200 }, { day_wib: '2026-11-12', seconds: 1800 }],
    [{ hour_wib: 20, seconds: 9000 }, { hour_wib: 21, seconds: 3000 }, { hour_wib: 22, seconds: 1000 }, { hour_wib: 9, seconds: 600 }]);
  assert(st.totalSeconds === 12600 && st.totalMinutes === 210 && st.daysActive === 3, 'reading: total menit + hari aktif');
  assert(st.topDay && st.topDay.date === '2026-11-11' && st.topDay.name === 'Rabu' && st.topDay.minutes === 120, 'reading: hari tersering = hari dengan detik terbanyak');
  assert(st.hourRange && st.hourRange.startHour === 20 && st.hourRange.endHour === 21 && st.hourRange.label === '20:00–21:00', 'reading: rentang jam tersering 20:00-21:00 (jam puncak + tetangga >=50%)');
  const empty = computeReadingStats([], []);
  assert(empty.totalSeconds === 0 && empty.topDay === null && empty.hourRange === null, 'reading: tanpa data -> nol + null');
  const wrap = computeReadingStats([{ day_wib: '2026-11-12', seconds: 60 }], [{ hour_wib: 23, seconds: 5000 }, { hour_wib: 0, seconds: 4000 }, { hour_wib: 1, seconds: 3000 }]);
  assert(wrap.hourRange && wrap.hourRange.startHour === 23 && wrap.hourRange.endHour === 2 && wrap.hourRange.label === '23:00–02:00', 'reading: rentang jam melintasi tengah malam');
}
// 45c. First-visit: komposisi 4+3+3, tanpa duplikat, rotasi deterministik.
{
  const mk = (i) => ({ id: 'p' + i, slug: 's' + i, title: 'T' + i, publish_at: i <= 11 ? `2026-11-${String(12 - i).padStart(2, '0')}T00:00:00.000Z` : '2026-10-31T00:00:00.000Z', views: i * 10 });
  const posts = Array.from({ length: 12 }, (_, i) => mk(i + 1)); // p1 terbaru; p12 paling banyak dilihat
  const mixA = pickFirstVisit(posts, '2026-11-12');
  assert(mixA.ordered.length === 10 && new Set(mixA.ordered.map(p => p.id)).size === 10, 'first-visit: 10 item tanpa duplikat');
  assert(mixA.newest.length === 4 && mixA.popular.length === 3 && mixA.rotation.length === 3, 'first-visit: komposisi 4 terbaru + 3 populer + 3 rotasi');
  assert(mixA.ordered.slice(0, 4).map(p => p.id).join() === 'p1,p2,p3,p4', 'first-visit: 4 slot pertama = terbaru');
  assert(mixA.ordered.slice(4, 7).map(p => p.id).join() === 'p12,p11,p10', 'first-visit: 3 slot berikut = terpopuler');
  const mixA2 = pickFirstVisit(posts, '2026-11-12');
  assert(mixA.ordered.map(p => p.id).join() === mixA2.ordered.map(p => p.id).join(), 'first-visit: tanggal sama -> campuran sama (deterministik)');
  const rotSets = new Set();
  for (let d = 1; d <= 30; d++) rotSets.add(pickFirstVisit(posts, `2026-11-${String(d).padStart(2, '0')}`).ordered.slice(7).map(p => p.id).join());
  assert(rotSets.size >= 2, 'first-visit: rotasi berubah antar tanggal');
  const small = pickFirstVisit(posts.slice(0, 5), '2026-11-12');
  assert(small.ordered.length === 5 && new Set(small.ordered.map(p => p.id)).size === 5, 'first-visit: kurang dari 10 post -> semua tampil tanpa duplikat');
}
// 45d. Stopwatch abadi: format digital/detail + countdown tahunan/tetap.
{
  assert(formatStopwatch(3661040, false) === '001:01:01.04', 'stopwatch: mode digital 1 jam 1 mnt 1 dtk');
  assert(formatStopwatch(90061000, true) === '1 Hari\n01:01:01.000', 'stopwatch: mode detail 1 hari');
  const now = Date.UTC(2026, 10, 12, 10, 0, 0);
  const nxt = nextEventMs({ month: 1, day: 1 }, now);
  assert(new Date(nxt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === '2027-01-01', 'stopwatch: countdown tahunan lompat ke tahun berikut');
  const gta = nextEventMs({ month: 11, day: 15 }, now);
  assert(new Date(gta).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === '2026-11-15', 'stopwatch: countdown tanggal tetap');
}
// 45e. Detik aktif: hanya scroll bawah; idle >15 dtk dipotong; scroll atas nol.
{
  const evs = [
    { t: 0, y: 0, type: 'scroll' },
    { t: 1000, y: 100, type: 'scroll' },
    { t: 2000, y: 200, type: 'scroll' },
    { t: 20000, y: 300, type: 'scroll' },
    { t: 21000, y: 200, type: 'scroll' },
    { t: 22000, y: 400, type: 'scroll' },
  ];
  assert(countActiveSeconds(evs, 15000) === 3, 'reading: detik aktif hanya saat scroll bawah, idle >15 dtk dipotong');
  const evs2 = [
    { t: 0, y: 0, type: 'scroll' },
    { t: 1000, y: 100, type: 'scroll' },
    { t: 12000, y: 100, type: 'input' },
    { t: 13000, y: 200, type: 'scroll' },
  ];
  assert(countActiveSeconds(evs2, 15000) === 2, 'reading: input menjaga sesi tetap hidup tanpa menambah detik sendiri');
}
// 46. Waktu baca end-to-end (v81): heartbeat -> statistik -> panel admin.
r = await callJson('POST', '/api/reading/heartbeat', { seconds: 120, post_id: 'post-uji', max_scroll: 500, csrf: userCsrf });
assert(r.status === 401, 'reading: heartbeat anonim ditolak 401');
r = await callJson('POST', '/api/reading/heartbeat', { seconds: 120, post_id: 'post-uji', max_scroll: 500, csrf: userCsrf }, { cookie: userCookie });
let hb = await r.json();
assert(r.status === 200 && hb.ok && hb.stored === 120, 'reading: heartbeat akun tersimpan 120 detik');
r = await callJson('POST', '/api/reading/heartbeat', { seconds: 60, post_id: 'post-uji', max_scroll: 800, csrf: userCsrf }, { cookie: userCookie });
hb = await r.json();
assert(r.status === 200 && hb.stored === 60, 'reading: heartbeat kedua menumpuk 60 detik');
r = await callJson('POST', '/api/reading/heartbeat', { seconds: 0, post_id: 'post-uji', max_scroll: 0, csrf: userCsrf }, { cookie: userCookie });
assert(r.status === 400, 'reading: heartbeat 0 detik ditolak 400');
r = await callJson('POST', '/api/reading/heartbeat', { seconds: 121, post_id: 'post-uji', max_scroll: 0, csrf: userCsrf }, { cookie: userCookie });
assert(r.status === 400, 'reading: heartbeat >120 detik ditolak 400');
r = await callJson('POST', '/api/reading/heartbeat', { seconds: 30, post_id: 'post-uji', max_scroll: 0, csrf: 'salah' }, { cookie: userCookie });
assert(r.status === 403, 'reading: heartbeat CSRF salah ditolak 403');
r = await call('GET', '/api/reading/stats');
assert(r.status === 401, 'reading: statistik tanpa login ditolak 401');
r = await call('GET', '/api/reading/stats', null, userCookie);
const st1 = await r.json();
assert(r.status === 200 && st1.totalSeconds === 180 && st1.totalMinutes === 3 && st1.daysActive === 1, 'reading: statistik pemilik = 180 detik / 3 menit / 1 hari');
assert(st1.topDay && st1.topDay.minutes === 3 && typeof st1.topDay.date === 'string', 'reading: hari tersering = hari ini, 3 menit');
assert(st1.hourRange && typeof st1.hourRange.label === 'string' && st1.hourRange.label.includes(':'), 'reading: rentang jam terisi');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'siti', password: 'password123', email: 'siti@example.com' }); assert(r.status === 303, 'daftar siti redirect ke verifikasi');
const sitiCookie = await verifikasiKode('siti@example.com');
const budi = [...env.DB.users.values()].find(u => u.username === 'budi');
r = await call('GET', '/api/reading/stats?user=' + budi.id, null, sitiCookie);
assert(r.status === 403, 'reading: akun lain tidak boleh lihat statistik budi');
r = await call('GET', '/api/reading/stats?user=' + budi.id, null, cookie);
const stAdmin = await r.json();
assert(r.status === 200 && stAdmin.username === 'budi' && stAdmin.totalSeconds === 180, 'reading: admin bisa lihat statistik akun mana pun');
r = await call('GET', '/akun', null, userCookie); t = await r.text();
assert(t.includes('Waktu Baca') && t.includes('3 menit'), 'reading: profil akun menampilkan total menit baca pemilik');
r = await call('GET', '/kendali/baca', null, cookie); t = await r.text();
assert(r.status === 200 && t.includes('/kendali/baca') && t.includes('budi') && t.includes('3 menit'), 'reading: panel admin waktu baca menampilkan akun + total');
r = await call('GET', '/post/post-uji', null, userCookie); t = await r.text();
assert(t.includes('data-reading-tracker') && t.includes('/api/reading/heartbeat'), 'reading: tracker tersuntik di halaman post untuk akun login');
r = await call('GET', '/post/post-uji'); t = await r.text();
assert(!t.includes('data-reading-tracker'), 'reading: tracker tidak disuntik untuk anonim');
// 47. Stopwatch abadi di /uptime (v81): fail-open tanpa data, tampil bila ada.
r = await call('GET', '/uptime'); t = await r.text();
assert(r.status === 200 && !t.includes('Stopwatch Abadi'), 'stopwatch: tanpa data D1, kartu tidak tampil (fail-open)');
env.BACKUP_DB.eternalStopwatch = { start_time: 1790229011336 };
r = await call('GET', '/uptime'); t = await r.text();
assert(t.includes('Stopwatch Abadi') && t.includes('id="eternal-timer"') && t.includes('data-cd=') && t.includes('Mode Detail'), 'stopwatch: kartu + timer + countdown tampil dari D1');
env.BACKUP_DB.eternalStopwatch = null;
// 48. First-visit di beranda (v81): campuran + cookie untuk pengunjung baru.
r = await call('GET', '/'); t = await r.text();
assert(t.includes('Selamat datang!') && (r.headers.get('set-cookie') || '').includes('cms_fv=1'), 'first-visit: pengunjung baru dapat campuran + cookie cms_fv');
r = await call('GET', '/', null, 'cms_fv=1'); t = await r.text();
assert(!t.includes('Selamat datang!'), 'first-visit: pengunjung kembali dapat beranda normal');
// 49. Verifikasi OTP email saat daftar (v83).
env.DB.rateLimits = new Map();
r = await call('GET', '/akun'); t = await r.text();
assert(t.includes('name="email"') && t.includes('/akun/daftar'), 'otp: form daftar ada kolom email');
r = await call('POST', '/akun/daftar', { username: 'tanpaemail', password: 'password123' }); assert(r.status === 400, 'otp: daftar tanpa email ditolak 400');
r = await call('POST', '/akun/daftar', { username: 'emailjelek', password: 'password123', email: 'bukan-email' }); assert(r.status === 400, 'otp: email tidak valid ditolak 400');
r = await call('POST', '/akun/daftar', { username: 'penyamar', password: 'password123', email: 'muchammadhozin@gmail.com' }); assert(r.status === 400, 'otp: email admin tidak bisa dipakai komentator');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'otpuser', password: 'password123', email: 'otpuser@example.com' });
assert(r.status === 303 && (r.headers.get('location') || '') === '/akun/verifikasi?email=otpuser%40example.com', 'otp: daftar redirect ke halaman verifikasi');
const otpRow = env.DB.otpCodes.get('otpuser@example.com');
const kodeOtpUser = kodeTerakhir();
assert(otpRow && otpRow.code_hash && otpRow.code_hash.length === 64 && otpRow.code_hash !== kodeOtpUser, 'otp: kode tersimpan sebagai hash SHA-256, bukan plaintext');
assert(resendCalls[resendCalls.length - 1].body.to[0] === 'otpuser@example.com' && resendCalls[resendCalls.length - 1].body.subject.includes('verifikasi'), 'otp: email terkirim ke alamat pendaftar dengan subjek verifikasi');
// v83.1: email OTP HTML bermerek + fallback teks.
const otpMail = resendCalls[resendCalls.length - 1].body;
assert(otpMail.html && otpMail.html.includes('Hozin King') && otpMail.html.includes(kodeOtpUser) && otpMail.html.includes('10 menit') && otpMail.html.includes('Jangan bagikan'), 'otp v83.1: email HTML bermerek memuat kode + masa berlaku + peringatan');
assert(otpMail.html.includes('font-size:42px') && otpMail.html.includes('text-align:center'), 'otp v83.1: kode tampil besar di tengah');
assert(otpMail.text && otpMail.text.includes(kodeOtpUser) && otpMail.text.includes('10 menit'), 'otp v83.1: fallback teks polos tetap ada dan memuat kode');
assert(!/<img|https?:\/\//.test(otpMail.html), 'otp v83.1: HTML tanpa gambar eksternal / tautan luar');
r = await call('POST', '/akun/login', { username: 'otpuser', password: 'password123' });
assert(r.status === 403 && (await r.text()).includes('belum diverifikasi'), 'otp: login sebelum verifikasi ditolak');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'lainnama', password: 'password123', email: 'otpuser@example.com' });
assert(r.status === 409 && (await r.text()).includes('Nama pengguna atau email sudah dipakai'), 'otp: email duplikat ditolak 409 dengan pesan gabungan');
let vcsrf = '';
{
  const t2 = await call('GET', '/akun/verifikasi?email=otpuser%40example.com');
  vcsrf = ((await t2.text()).match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
}
assert(vcsrf.length > 10, 'otp: halaman verifikasi memberi token CSRF');
env.DB.rateLimits = new Map();
for (let i = 0; i < 5; i++) {
  r = await call('POST', '/akun/verifikasi', { email: 'otpuser@example.com', code: '000000', csrf: vcsrf });
  assert(r.status === 303 && (r.headers.get('location') || '').includes('pesan=salah'), 'otp: kode salah ditolak (' + (i + 1) + '/5)');
}
r = await call('POST', '/akun/verifikasi', { email: 'otpuser@example.com', code: kodeOtpUser, csrf: vcsrf });
assert(r.status === 303 && (r.headers.get('location') || '').includes('pesan=salah'), 'otp: kode benar setelah 5x salah tetap ditolak (kode hangus)');
for (let i = 0; i < 3; i++) {
  r = await call('POST', '/akun/verifikasi/kirim-ulang', { email: 'otpuser@example.com', csrf: vcsrf });
  assert(r.status === 303 && (r.headers.get('location') || '').includes('pesan=terkirim'), 'otp: kirim ulang ke-' + (i + 1) + ' lolos');
}
r = await call('POST', '/akun/verifikasi/kirim-ulang', { email: 'otpuser@example.com', csrf: vcsrf });
assert(r.status === 303 && (r.headers.get('location') || '').includes('pesan=limit'), 'otp: kirim ulang ke-4 kena limit 3/jam');
r = await call('POST', '/akun/verifikasi', { email: 'otpuser@example.com', code: kodeTerakhir(), csrf: vcsrf });
assert(r.status === 303 && !(r.headers.get('location') || '').includes('pesan=salah'), 'otp: kode baru dari kirim ulang berhasil');
const otpCookie = cookieHeader(cookiesOf(r));
assert(otpCookie.includes('cms_user='), 'otp: verifikasi memberi sesi komentator');
const otpUser = [...env.DB.users.values()].find(u => u.username === 'otpuser');
assert(otpUser && Number(otpUser.email_verified) === 1, 'otp: akun aktif setelah verifikasi');
r = await call('POST', '/akun/login', { username: 'otpuser', password: 'password123' });
assert(r.status === 303, 'otp: login setelah verifikasi lolos');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'kadaluarsa', password: 'password123', email: 'kadaluarsa@example.com' });
assert(r.status === 303, 'otp: daftar akun kadaluarsa redirect');
env.DB.otpCodes.get('kadaluarsa@example.com').expires_at = Date.now() - 1000;
{
  const t2 = await call('GET', '/akun/verifikasi?email=kadaluarsa%40example.com');
  vcsrf = ((await t2.text()).match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
}
r = await call('POST', '/akun/verifikasi', { email: 'kadaluarsa@example.com', code: kodeTerakhir(), csrf: vcsrf });
assert(r.status === 303 && (r.headers.get('location') || '').includes('pesan=salah'), 'otp: kode kedaluwarsa ditolak');
const savedKey = env.RESEND_API_KEY; env.RESEND_API_KEY = '';
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'gagalkirim', password: 'password123', email: 'gagalkirim@example.com' });
assert(r.status === 502 && (await r.text()).includes('gagal dikirim'), 'otp: tanpa kunci email, daftar gagal jujur (502), bukan pura-pura terkirim');
assert(!env.DB.otpCodes.has('gagalkirim@example.com'), 'otp: kode gagal kirim tidak tersimpan');
env.RESEND_API_KEY = savedKey;
env.DB.rateLimits = new Map();
{
  const t2 = await call('GET', '/akun/verifikasi?email=gagalkirim%40example.com');
  vcsrf = ((await t2.text()).match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
}
r = await call('POST', '/akun/verifikasi/kirim-ulang', { email: 'gagalkirim@example.com', csrf: vcsrf });
assert(r.status === 303 && (r.headers.get('location') || '').includes('pesan=terkirim'), 'otp: kirim ulang setelah kunci dipulihkan lolos');
await verifikasiKode('gagalkirim@example.com');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'kakek', password: 'password123', email: 'kakek@example.com' });
await verifikasiKode('kakek@example.com');
const kakek = [...env.DB.users.values()].find(u => u.username === 'kakek');
kakek.email = null; kakek.email_verified = 0; // simulasikan akun pra-v83
await env.DB.prepare(`UPDATE cms_users SET email_verified = 1 WHERE email IS NULL`).run();
assert(kakek.email_verified === 1, 'otp: migrasi grandfather akun lama tanpa email');
r = await call('POST', '/akun/login', { username: 'kakek', password: 'password123' });
assert(r.status === 303, 'otp: akun lama (grandfathered) tetap bisa login');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/verifikasi', { email: 'tidakada@example.com', code: '123456', csrf: 'x' });
assert(r.status === 303 && (r.headers.get('location') || '').includes('pesan=salah'), 'otp: verifikasi email tak terdaftar tetap pesan generik');
// v84: endpoint versi + APK Hozin FB Manager (repo privat, via Worker).
// Stub fetch GitHub: rilis terbaru v1.0.99 (code 99) + daftar tag + build.gradle.
const ghCalls = [];
const fetchBeforeFbm = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.github.com')) {
    ghCalls.push(u);
    const auth = (init && init.headers && (init.headers.authorization || init.headers.Authorization)) || '';
    if (!String(auth).startsWith('Bearer ghp_test')) {
      return { ok: false, status: 401, json: async () => ({}), text: async () => '{}' };
    }
    if (u.includes('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.0.99', body: 'Catatan rilis uji', assets: [{ name: 'HozinFBManager-1.0.99.apk', size: 6294999, browser_download_url: 'https://api.github.com/repos/hozin-king/fb-account-manager/releases/assets/1' }, { name: 'Source code (zip)', size: 100, browser_download_url: 'https://example.com/src.zip' }] }), text: async () => '{}' };
    }
    if (u.includes('/releases?per_page=10')) {
      return { ok: true, status: 200, json: async () => ([{ tag_name: 'v1.0.99' }, { tag_name: 'v1.0.98' }, { tag_name: 'v1.0.97' }, { tag_name: 'v1.0.96' }]), text: async () => '[]' };
    }
    if (u.includes('/contents/app/build.gradle')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => 'android {\n    defaultConfig {\n        versionCode 99\n        versionName "1.0.99"\n    }\n}' };
    }
    if (u.includes('/releases/assets/1')) {
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('FAKEAPKBYTES')); c.close(); } }), json: async () => ({}), text: async () => 'FAKEAPKBYTES' };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
  }
  return fetchBeforeFbm(u, init);
};
r = await call('GET', '/api/fbm-version');
assert(r.status === 502 && (await r.text()).includes('versi belum tersedia'), 'fbm-version: tanpa secret GITHUB_PAT_READ -> 502 jujur');
r = await call('GET', '/api/fbm-apk');
assert(r.status === 502 && (await r.text()).includes('unduhan belum tersedia'), 'fbm-apk: tanpa secret -> 502 jujur');
env.GITHUB_PAT_READ = 'ghp_test123';
r = await call('GET', '/api/fbm-version'); t = await r.text();
assert(r.status === 200, 'fbm-version: dengan token -> 200');
let fbmV = {};
try { fbmV = JSON.parse(t); } catch (e) {}
assert(fbmV.ok === true && fbmV.versionName === '1.0.99' && fbmV.versionCode === 99 && fbmV.tag === 'v1.0.99' && fbmV.apkName === 'HozinFBManager-1.0.99.apk' && Array.isArray(fbmV.tags) && fbmV.tags.length === 4 && fbmV.tags[0] === 'v1.0.99', 'fbm-version: field lengkap (versionCode 99 dari build.gradle, tag, apkName, tags)');
assert(!t.includes('ghp_test') && !t.includes('browser_download_url') && !t.includes('apkDownloadUrl'), 'fbm-version: token + URL unduh tidak bocor ke respons');
const ghCallsAfterFirst = ghCalls.length;
r = await call('GET', '/api/fbm-version');
assert(r.status === 200 && ghCalls.length === ghCallsAfterFirst, 'fbm-version: panggilan kedua memakai cache 5 menit (tanpa fetch GitHub lagi)');
r = await call('GET', '/api/fbm-apk');
assert(r.status === 200 && r.headers.get('content-type') === 'application/vnd.android.package-archive' && (r.headers.get('content-disposition') || '').includes('HozinFBManager-1.0.99.apk'), 'fbm-apk: 200 + content-type APK + attachment nama asli');
assert((await r.text()) === 'FAKEAPKBYTES', 'fbm-apk: bytes APK diteruskan apa adanya');
env.DB.rateLimits = new Map();
for (let i = 0; i < 10; i++) { r = await call('GET', '/api/fbm-apk'); }
assert(r.status === 200, 'fbm-apk: 10 unduhan/jam masih lolos');
r = await call('GET', '/api/fbm-apk');
assert(r.status === 429, 'fbm-apk: unduhan ke-11 dalam 1 jam ditolak 429');
delete env.GITHUB_PAT_READ;
globalThis.fetch = fetchBeforeFbm;
// v86: endpoint publik Cerpen — gambar + versi dari D1 stopwatch-db.
r = await call('GET', '/api/cerpen-img/covers/cover_01.jpg.enc');
assert(r.status === 200 && r.headers.get('content-type') === 'application/octet-stream' && (r.headers.get('cache-control') || '').includes('max-age=3600'), 'cerpen-img: 200 + octet-stream + cache 1 jam');
assert((await r.text()) === 'GAMBAR-ENKRIPSI-UJI', 'cerpen-img: byte gambar diteruskan apa adanya');
r = await call('GET', '/api/cerpen-img/covers/tidak-ada.jpg.enc');
assert(r.status === 404 && (await r.text()).includes('gambar tidak ditemukan'), 'cerpen-img: path tidak ada -> 404');
r = await call('GET', '/api/cerpen-img/..%2Fcover.jpg.enc');
assert(r.status === 400 && (await r.text()).includes('path gambar tidak valid'), 'cerpen-img: traversal ../ -> 400');
r = await call('GET', '/api/cerpen-version'); t = await r.text();
assert(r.status === 200 && (r.headers.get('cache-control') || '').includes('no-store'), 'cerpen-version: 200 + no-store');
let cerpenV = {};
try { cerpenV = JSON.parse(t); } catch (e) {}
assert(cerpenV.tag === 'v1.1.29' && cerpenV.version === '1.1.29' && cerpenV.apk_url === 'https://example.com/cerpen-1.1.29.apk' && cerpenV.published_at === '2026-11-13T19:00:00+07:00', 'cerpen-version: keempat field benar');
env.BACKUP_DB.cerpenVersion = [];
r = await call('GET', '/api/cerpen-version');
assert(r.status === 404 && (await r.text()).includes('versi belum tersedia'), 'cerpen-version: tanpa baris -> 404');
// v87: Sistem Koin Cerpen — auth aplikasi, dompet, voucher, VIP, leaderboard, riwayat, ban, pantauan.
const DEV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEV_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEV_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEV_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEV_F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DEV_G = '11111111-2222-4333-8444-555555555555';
const DEV_H = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const DEV_I = '99999999-8888-4777-8666-555555555555';
const DEV_J = '22222222-3333-4444-8555-666666666666';
async function coinCall(method, path, obj, headers = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  const req = new Request(base + path, { method, headers: h, body: obj === null ? undefined : JSON.stringify(obj) });
  return worker.fetch(req, env);
}
async function coinAdmin(path, method, obj) {
  return coinCall(method, path, obj, { 'x-csrf': coinCsrf, cookie });
}
// CSRF admin untuk endpoint koin: dibaca dari panel /kendali/koin.
r = await call('GET', '/kendali/koin', null, cookie);
t = await r.text();
assert(r.status === 200 && t.includes('Koin Cerpen') && t.includes('Papan Peringkat') && t.includes('Daftar Pantauan'), 'koin panel: /kendali/koin tampil + kartu VIP/leaderboard/pantauan');
const coinCsrf = (t.match(/COIN_CSRF = "([^"]+)"/) || [])[1] || '';
assert(coinCsrf.length > 10, 'koin panel: token CSRF terbaca dari panel');
r = await coinCall('GET', '/api/cerpen-coins/pricing', null);
let pj = {};
try { pj = JSON.parse(await r.text()); } catch (e) {}
assert(r.status === 200 && pj.ok === true && pj.default_price === 10 && pj.free_episodes_default === 1, 'koin pricing: default 10 koin, 1 episode gratis');
r = await coinCall('GET', '/api/cerpen-coins/me?device_id=' + DEV_A, null);
let me = JSON.parse(await r.text());
assert(r.status === 200 && me.balance === 0 && Array.isArray(me.unlocks) && me.unlocks.length === 0, 'koin me guest: saldo 0, tanpa unlock');
// Auth aplikasi: daftar -> verifikasi OTP -> login.
env.DB.rateLimits = new Map();
r = await coinCall('POST', '/api/cerpen-auth/register', { username: 'koinuji', password: 'password123', email: 'koinuji@example.com', device_id: DEV_A, android_id: 'android-uji-001' });
let rj = JSON.parse(await r.text());
assert(r.status === 201 && rj.needs_verification === true, 'koin register: 201 + butuh verifikasi OTP');
r = await coinCall('POST', '/api/cerpen-auth/verify', { email: 'koinuji@example.com', code: kodeTerakhir(), device_id: DEV_A, android_id: 'android-uji-001' });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.ok === true && typeof rj.session === 'string' && rj.session.length > 10, 'koin verify: sesi didapat');
const koinUserCookie = 'cms_user=' + rj.session;
const koinUser = [...env.DB.users.values()].find(u => u.username === 'koinuji');
assert(koinUser && rj.balance === 0, 'koin verify: akun dibuat, saldo 0');
env.DB.rateLimits = new Map();
r = await coinCall('POST', '/api/cerpen-auth/login', { username: 'koinuji', password: 'salahsalah', device_id: DEV_A });
assert(r.status === 403, 'koin login: password salah ditolak 403');
r = await coinCall('POST', '/api/cerpen-auth/login', { username: 'koinuji', password: 'password123', device_id: DEV_A });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.ok === true && rj.username === 'koinuji', 'koin login: benar -> sesi + username');
// Voucher koin: buat batch, tukar, batas per batch, kode tak dikenal.
env.DB.rateLimits = new Map();
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'coins', reward_value: 50, count: 5, total_max: 5, per_device_max: 1, active: 1, note: 'uji' });
rj = JSON.parse(await r.text());
assert(r.status === 201 && rj.ok === true && Array.isArray(rj.codes) && rj.codes.length === 5, 'koin voucher: batch 5 kode dibuat');
const coinCodes = rj.codes;
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: coinCodes[0], device_id: DEV_A, android_id: 'android-uji-001' });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.coins === 50 && rj.balance === 50, 'koin redeem: guest dapat 50 koin');
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: coinCodes[0], device_id: DEV_A, android_id: 'android-uji-001' });
assert(r.status === 409, 'koin redeem: kode sama + perangkat sama ditolak (batas per batch)');
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: coinCodes[1], device_id: DEV_A, android_id: 'android-uji-001' });
assert(r.status === 409, 'koin redeem: kode lain batch sama + perangkat sama ditolak (batas per batch)');
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: coinCodes[1], device_id: DEV_B, android_id: 'android-uji-002' });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.balance === 50, 'koin redeem: perangkat lain bisa tukar kode lain batch sama');
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: 'CERPEN-XXXX-XXXX-XXXX', device_id: DEV_B });
assert(r.status === 404, 'koin redeem: kode tidak dikenal -> 404');
// Kuota total batch = 1 ("1 orang saja").
env.DB.rateLimits = new Map();
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'coins', reward_value: 10, count: 2, total_max: 1, per_device_max: 5, active: 1 });
rj = JSON.parse(await r.text());
const oneCodes = rj.codes;
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: oneCodes[0], device_id: DEV_C });
assert(r.status === 200, 'koin redeem: batch total_max=1, penukaran pertama lolos');
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: oneCodes[1], device_id: DEV_D });
assert(r.status === 409, 'koin redeem: batch total_max=1, penukaran kedua (perangkat lain) ditolak kuota habis');
// Migrasi guest -> akun saat login ulang dengan device yang sama.
env.DB.rateLimits = new Map();
r = await coinCall('POST', '/api/cerpen-auth/login', { username: 'koinuji', password: 'password123', device_id: DEV_A, android_id: 'android-uji-001' });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.balance === 50 && rj.migrated === 50, 'koin migrasi: saldo guest 50 pindah ke akun saat login');
r = await coinCall('GET', '/api/cerpen-coins/me', null, { cookie: koinUserCookie });
me = JSON.parse(await r.text());
assert(me.balance === 50, 'koin me: saldo akun 50 setelah migrasi');
// Beli episode: bayar, beli ulang, gratis, saldo kurang.
env.DB.rateLimits = new Map();
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 2, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.ok === true && rj.balance === 40 && rj.price === 10, 'koin purchase: episode 2 (10 koin) -> saldo 40');
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 2, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.already === true, 'koin purchase: beli ulang episode yang sama -> already');
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 1, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.free === true && rj.balance === 40, 'koin purchase: episode 1 gratis, saldo tetap 40');
// Gratis per-series (13 Nov 2026): hanya S1E1 gratis; S2E1/S3E1 terkunci.
env.DB.rateLimits = new Map();
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 2, no: 1, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.ok === true && rj.price === 10 && rj.balance === 30, 'koin purchase per-series: S2E1 terkunci 10 koin -> saldo 30');
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 3, no: 1, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.ok === true && rj.price === 10 && rj.balance === 20, 'koin purchase per-series: S3E1 terkunci 10 koin -> saldo 20');
// Komik selalu season 1 -> episode 1 komik tetap gratis.
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'komik', target_id: 'komik-01', season: 1, no: 1, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.free === true && rj.balance === 20, 'koin purchase per-series: komik E1 (season 1) gratis, saldo tetap 20');
// Kembalikan saldo supaya tes berikutnya (VIP dst.) tetap melihat 40.
r = await coinAdmin('/api/admin/cerpen-koin/users/' + koinUser.id + '/adjust', 'POST', { delta: 20, reason: 'uji per-series: kembalikan saldo' });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.balance === 40, 'koin purchase per-series: saldo dikembalikan ke 40');
// Override free_episodes=2: S1E2 gratis, S2E1 tetap terkunci.
env.DB.rateLimits = new Map();
r = await coinAdmin('/api/admin/cerpen-koin/pricing/cerpen/cerpen-01', 'POST', { price: 10, free_episodes: 2 });
assert(r.status === 200, 'koin pricing per-series: override free_episodes=2 disimpan');
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 2, device_id: DEV_J }, null);
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.free === true, 'koin purchase per-series: override 2 -> S1E2 gratis (guest baru)');
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 2, no: 1, device_id: DEV_J }, null);
assert(r.status === 402, 'koin purchase per-series: override 2 -> S2E1 tetap terkunci (saldo guest 0)');
r = await coinAdmin('/api/admin/cerpen-koin/pricing/cerpen/cerpen-01', 'POST', { delete: true });
assert(r.status === 200, 'koin pricing per-series: override dihapus, kembali ke default');
r = await coinAdmin('/api/admin/cerpen-koin/pricing', 'POST', { default_price: 100 });
assert(r.status === 200, 'koin pricing: ubah default jadi 100');
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 3, device_id: DEV_A }, { cookie: koinUserCookie });
assert(r.status === 402, 'koin purchase: saldo 40 < harga 100 -> 402');
r = await coinAdmin('/api/admin/cerpen-koin/pricing', 'POST', { default_price: 10 });
assert(r.status === 200, 'koin pricing: kembalikan default 10');
// VIP: grant -> beli gratis -> revoke -> harga berlaku lagi.
r = await coinAdmin('/api/admin/cerpen-koin/vip', 'POST', { user_id: koinUser.id, days: 30, reason: 'uji' });
rj = JSON.parse(await r.text());
assert(r.status === 201 && rj.ok === true && rj.vip_until > Date.now(), 'koin VIP: grant 30 hari');
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 3, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.vip === true && rj.balance === 40, 'koin VIP: purchase episode terkunci gratis, saldo tetap');
r = await coinAdmin('/api/admin/cerpen-koin/vip/' + koinUser.id + '/revoke', 'POST', {});
assert(r.status === 200, 'koin VIP: revoke ok');
r = await coinAdmin('/api/admin/cerpen-koin/pricing', 'POST', { default_price: 100 });
r = await coinCall('POST', '/api/cerpen-coins/purchase', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 4, device_id: DEV_A }, { cookie: koinUserCookie });
assert(r.status === 402, 'koin VIP: setelah revoke, harga berlaku lagi -> 402');
r = await coinAdmin('/api/admin/cerpen-koin/pricing', 'POST', { default_price: 10 });
// Voucher fleksibel: episode / series / season.
env.DB.rateLimits = new Map();
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'episode', reward_target_kind: 'cerpen', reward_target_id: 'cerpen-01', reward_season: 1, reward_no: 2, count: 2, total_max: 10, per_device_max: 1, active: 1 });
rj = JSON.parse(await r.text());
assert(r.status === 201 && rj.codes.length === 2, 'koin voucher episode: batch dibuat');
const epCodes = rj.codes;
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: epCodes[0], device_id: DEV_E });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.reward_type === 'episode' && rj.unlocks_granted === 1, 'koin redeem episode: unlock ditulis server-side');
r = await coinCall('GET', '/api/cerpen-coins/me?device_id=' + DEV_E, null);
me = JSON.parse(await r.text());
assert(me.unlocks.some(u => u.kind === 'cerpen' && u.target_id === 'cerpen-01' && u.season === 1 && u.no === 2), 'koin me: unlock episode dari voucher tampil');
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'series', reward_target_kind: 'cerpen', reward_target_id: 'cerpen-01', count: 1, total_max: 10, per_device_max: 1, active: 1 });
rj = JSON.parse(await r.text());
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: rj.codes[0], device_id: DEV_G });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.unlocks_granted === 2 && rj.unlocks_total === 2, 'koin redeem series: 2 episode cerpen-01 terbuka sekaligus');
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'season', reward_target_kind: 'cerpen', reward_target_id: 'cerpen-01', reward_season: 1, count: 1, total_max: 10, per_device_max: 1, active: 1 });
rj = JSON.parse(await r.text());
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: rj.codes[0], device_id: DEV_H });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.unlocks_granted === 2, 'koin redeem season: season 1 (2 episode) terbuka');
// Voucher VIP: guest ditolak, akun lolos.
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'vip', reward_value: 7, count: 2, total_max: 10, per_device_max: 1, active: 1 });
rj = JSON.parse(await r.text());
const vipCodes = rj.codes;
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: vipCodes[0], device_id: DEV_I });
assert(r.status === 409, 'koin redeem VIP: guest ditolak (butuh akun)');
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: vipCodes[0], device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.reward_type === 'vip' && rj.vip_days === 7 && rj.vip_until > Date.now(), 'koin redeem VIP: akun dapat VIP 7 hari');
// Voucher draf: buat tanpa target -> isi belakangan -> aktifkan -> aktif tidak bisa diubah.
env.DB.rateLimits = new Map();
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'episode', count: 2, total_max: 10, per_device_max: 1, active: 0 });
rj = JSON.parse(await r.text());
assert(r.status === 201, 'koin voucher draf: batch tanpa target bisa dibuat sebagai draf');
const draftId = rj.batch_id;
r = await coinAdmin('/api/admin/cerpen-koin/vouchers/' + draftId, 'POST', { reward_type: 'episode', reward_target_kind: 'cerpen', reward_target_id: 'cerpen-01', reward_season: 1, reward_no: 1 });
assert(r.status === 200, 'koin voucher draf: target bisa diisi belakangan');
r = await coinAdmin('/api/admin/cerpen-koin/vouchers/' + draftId + '/activate', 'POST', {});
assert(r.status === 200, 'koin voucher draf: aktivasi ok setelah target diisi');
r = await coinAdmin('/api/admin/cerpen-koin/vouchers/' + draftId, 'POST', { reward_type: 'coins', reward_value: 5 });
assert(r.status === 409, 'koin voucher: batch aktif tidak bisa diubah');
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'episode', reward_target_kind: 'cerpen', reward_target_id: 'tidak-ada', reward_season: 1, reward_no: 1, count: 1, total_max: 1, per_device_max: 1, active: 1 });
assert(r.status === 400, 'koin voucher: batch aktif target tidak ada ditolak 400');
// valid_from + expires_at unix detik (bukan ms).
const nowS = Math.floor(Date.now() / 1000);
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'coins', reward_value: 5, count: 1, total_max: 5, per_device_max: 1, valid_from: nowS + 3600, active: 1 });
rj = JSON.parse(await r.text());
env.DB.rateLimits = new Map();
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: rj.codes[0], device_id: DEV_F });
assert(r.status === 409, 'koin redeem: kode belum berlaku (valid_from) ditolak');
r = await coinAdmin('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: 'coins', reward_value: 5, count: 1, total_max: 5, per_device_max: 1, expires_at: nowS + 3600, active: 1 });
rj = JSON.parse(await r.text());
r = await coinCall('POST', '/api/cerpen-coins/redeem', { code: rj.codes[0], device_id: DEV_F });
assert(r.status === 200, 'koin redeem: expires_at unix detik — kode belum kedaluwarsa bisa ditebus');
// Targets untuk dropdown voucher.
r = await coinAdmin('/api/admin/cerpen-koin/targets?kind=cerpen&target_id=cerpen-01', 'GET', null);
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.cerpen.some(x => x.id === 'cerpen-01') && JSON.stringify(rj.seasons) === '[1]' && rj.episodes.length === 2, 'koin targets: daftar series + season/episode cerpen-01');
// Waktu baca + leaderboard + privasi.
env.DB.rateLimits = new Map();
r = await coinCall('POST', '/api/cerpen-coins/reading', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 1, seconds: 60, device_id: DEV_A }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.stored === 60, 'koin reading: heartbeat 60 detik tersimpan');
r = await coinCall('POST', '/api/cerpen-coins/reading', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 2, seconds: 200 }, { cookie: koinUserCookie });
assert(r.status === 400, 'koin reading: >120 detik per flush ditolak');
r = await coinCall('POST', '/api/cerpen-coins/reading', { kind: 'cerpen', target_id: 'cerpen-01', season: 1, no: 1, seconds: 60, device_id: DEV_F });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.stored === 0 && rj.tracked === false, 'koin reading: guest tidak ditulis ke tabel baca bersama (stored 0, tracked false)');
r = await coinCall('GET', '/api/cerpen-coins/leaderboard?period=all', null);
rj = JSON.parse(await r.text());
assert(!rj.leaderboard.some(x => x.seconds === 60 && x.username !== 'koinuji'), 'koin leaderboard: tidak ada baris hantu dari guest');
r = await coinCall('GET', '/api/cerpen-coins/leaderboard?period=weekly', null);
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.leaderboard.some(x => x.username === 'koinuji' && x.seconds === 60), 'koin leaderboard: koinuji tampil mingguan (60 detik)');
r = await coinCall('POST', '/api/cerpen-auth/reading-privacy', { private: true }, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.reading_private === 1, 'koin reading-privacy: sembunyikan diri ok');
r = await coinCall('GET', '/api/cerpen-coins/leaderboard?period=weekly', null);
rj = JSON.parse(await r.text());
assert(!rj.leaderboard.some(x => x.username === 'koinuji'), 'koin leaderboard: akun private tidak tampil');
r = await coinCall('POST', '/api/cerpen-auth/reading-privacy', { private: false }, { cookie: koinUserCookie });
r = await coinCall('GET', '/api/cerpen-coins/leaderboard?period=all', null);
rj = JSON.parse(await r.text());
assert(rj.leaderboard.some(x => x.username === 'koinuji'), 'koin leaderboard: setelah dibuka lagi, tampil di sepanjang waktu');
// Riwayat: unlock + terakhir dibaca.
r = await coinCall('GET', '/api/cerpen-coins/history', null, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.unlocks.some(u => u.kind === 'cerpen' && u.target_id === 'cerpen-01' && u.no === 2) && rj.reading.some(x => x.target_id === 'cerpen-01' && x.no === 1 && x.seconds === 60), 'koin history: unlock + terakhir dibaca tampil');
// Admin adjust / ban / lock.
r = await coinAdmin('/api/admin/cerpen-koin/users/' + koinUser.id + '/adjust', 'POST', { delta: 100, reason: 'uji beri' });
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.balance === 140, 'koin adjust: +100 -> saldo 140');
r = await coinAdmin('/api/admin/cerpen-koin/users/' + koinUser.id + '/adjust', 'POST', { delta: -200, reason: 'uji kurang' });
assert(r.status === 402, 'koin adjust: kurangi melebihi saldo ditolak 402');
env.DB.rateLimits = new Map();
r = await coinAdmin('/api/admin/cerpen-koin/bans', 'POST', { user_id: koinUser.id, reason: 'uji ban' });
rj = JSON.parse(await r.text());
assert(r.status === 201 && rj.username === 'koinuji', 'koin ban: ban akun dibuat');
const banId = rj.id;
r = await coinCall('GET', '/api/cerpen-coins/me', null, { cookie: koinUserCookie });
rj = JSON.parse(await r.text());
assert(r.status === 403 && rj.error === 'banned' && rj.reason === 'uji ban', 'koin ban: /me akun dibanned -> 403 + alasan');
r = await coinCall('POST', '/api/cerpen-auth/login', { username: 'koinuji', password: 'password123', device_id: DEV_A });
assert(r.status === 403, 'koin ban: login akun dibanned ditolak (sesi lama tidak bisa dipakai)');
r = await coinAdmin('/api/admin/cerpen-koin/bans/' + banId + '/unban', 'POST', { note: 'uji unban' });
assert(r.status === 200, 'koin ban: unban ok');
r = await coinCall('GET', '/api/cerpen-coins/me', null, { cookie: koinUserCookie });
assert(r.status === 200, 'koin ban: setelah unban, /me lolos lagi');
r = await coinAdmin('/api/admin/cerpen-koin/users/' + koinUser.id + '/lock', 'POST', {});
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.locked === 1, 'koin lock: akun dikunci');
r = await coinCall('POST', '/api/cerpen-auth/login', { username: 'koinuji', password: 'password123', device_id: DEV_A });
assert(r.status === 403, 'koin lock: login akun terkunci ditolak');
r = await coinAdmin('/api/admin/cerpen-koin/users/' + koinUser.id + '/unlock', 'POST', {});
assert(r.status === 200, 'koin lock: akun dibuka lagi');
// Overview + detail akun + daftar pantauan.
r = await coinAdmin('/api/admin/cerpen-koin/overview', 'GET', null);
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.users >= 1 && rj.vip_active >= 1 && rj.coins_in_circulation >= 140, 'koin overview: hitungan akun/VIP/koin beredar');
r = await coinAdmin('/api/admin/cerpen-koin/users/' + koinUser.id, 'GET', null);
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.user.username === 'koinuji' && rj.vip.active === true && rj.unlocks.length >= 3 && rj.reading.length >= 1, 'koin user detail: VIP + unlock + riwayat baca tampil');
r = await coinAdmin('/api/admin/cerpen-koin/devices?q=&limit=20', 'GET', null);
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.devices.some(d => d.device_id === DEV_A), 'koin devices: perangkat A muncul di daftar pantauan');
r = await coinAdmin('/api/admin/cerpen-koin/devices/' + DEV_A + '/watch', 'POST', { watched: 1, note: 'uji pantau' });
assert(r.status === 200, 'koin devices: tandai pantau ok');
r = await coinAdmin('/api/admin/cerpen-koin/devices/' + DEV_A, 'GET', null);
rj = JSON.parse(await r.text());
assert(r.status === 200 && rj.device.watched === 1 && rj.links.some(l => l.user_id === koinUser.id), 'koin device detail: pantau + akun terikat tampil');
// Auto-flag: >=5 gagal redeem dalam 24 jam -> "perlu perhatian" (tidak memblokir).
env.DB.rateLimits = new Map();
for (let i = 0; i < 5; i++) { await coinCall('POST', '/api/cerpen-coins/redeem', { code: 'CERPEN-XXXX-XXXX-XXXX', device_id: DEV_F }); }
r = await coinAdmin('/api/admin/cerpen-koin/devices?q=&limit=20', 'GET', null);
rj = JSON.parse(await r.text());
const devF = rj.devices.find(d => d.device_id === DEV_F);
assert(devF && devF.status === 'perlu perhatian', 'koin pantauan: >=5 gagal redeem -> perlu perhatian (tidak memblokir)');
console.log('Selesai, exitCode=' + (process.exitCode || 0));
