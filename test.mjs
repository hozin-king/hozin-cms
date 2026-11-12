// Uji WorkerCMS tanpa Cloudflare: mock D1 sederhana untuk pola SQL yang dipakai worker.js.
// Jalankan: node test.mjs  (harus keluar semua OK (kini 18+ cek, termasuk CSRF & rate-limit))
import worker from './worker.js';
import { themes } from './themes.js';
import { renderPage, envSiteTitle, pruneAnalytics, pruneRateTables, VIEW_EVENTS_RETENTION_DAYS } from './store.js';
import { parseTags, tagSlug, sanitizeHtml } from './util.js';
import { checkRateLimit } from './security.js';
import { tagLinks } from './content.js';

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
      { key_id: 'key-be663fc2', key_hash: 'a'.repeat(64), name: 'muse-kedua', created_at: nowT - 2 * 3600 * 1000, revoked: 0, daily_limit: 10 },
      { key_id: 'key-11111111', key_hash: 'b'.repeat(64), name: 'kunci-uji', created_at: nowT - 1 * 3600 * 1000, revoked: 1, daily_limit: 5 },
    ];
    this.cerpenSubmissions = [
      { id: 'sub-aaaaaaaaaaaa', key_id: 'key-be663fc2', kind: 'cerpen', target_id: 'cerpen-99', title: 'Cerpen Uji Pending', dedup_hash: 'h1', payload_json: '{"kind":"cerpen","id":"cerpen-99"}', status: 'pending', created_at: nowT - 1800 * 1000, reviewed_at: null, review_note: '' },
      { id: 'sub-bbbbbbbbbbbb', key_id: 'key-be663fc2', kind: 'season', target_id: 'cerpen-01', title: 'Season Uji Approved', dedup_hash: 'h2', payload_json: '{"kind":"season","id":"cerpen-01"}', status: 'approved', created_at: nowT - 1200 * 1000, reviewed_at: nowT - 1100 * 1000, review_note: 'ok' },
      { id: 'sub-cccccccccccc', key_id: 'key-11111111', kind: 'komik', target_id: 'komik-99', title: 'Komik Uji Rejected', dedup_hash: 'h3', payload_json: '{"kind":"komik","id":"komik-99"}', status: 'rejected', created_at: nowT - 600 * 1000, reviewed_at: nowT - 500 * 1000, review_note: 'tidak lolos' },
    ];
    this.cerpenAdminAudit = [];
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { this.batchCalls = (this.batchCalls || 0) + 1; for (const s of stmts) await s.run(); }
  exec(sql, a, mode) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return [];
    if (s.startsWith('CREATE INDEX')) return [];
    if (s.startsWith('PRAGMA table_info(cms_posts)')) return [{ name: 'id' }, { name: 'slug' }, { name: 'title' }, { name: 'body' }, { name: 'category' }, { name: 'status' }, { name: 'created_at' }, { name: 'updated_at' }, { name: 'body_mode' }, { name: 'visibility' }, { name: 'publish_at' }, { name: 'post_password_hash' }, { name: 'post_password_salt' }, { name: 'views' }, { name: 'tags' }];
    if (s.startsWith('PRAGMA table_info(cms_comments)')) return [{ name: 'id' }, { name: 'post_id' }, { name: 'name' }, { name: 'text' }, { name: 'status' }, { name: 'created_at' }, { name: 'parent_id' }];
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
    if (s.startsWith('INSERT INTO cms_users')) { this.users.set(a[0], { id: a[0], username: a[1], password_hash: a[2], salt: a[3], created_at: a[4] }); return []; }
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
    if (s.startsWith('SELECT * FROM cms_comments ORDER')) {
      const all = [...this.comments].sort((x, y) => y.created_at.localeCompare(x.created_at));
      if (s.includes('LIMIT ? OFFSET ?')) return all.slice(a[1], a[1] + a[0]);
      return all;
    }
    if (s.startsWith('INSERT INTO cms_view_events')) { this.viewEvents.push({ id: ++this.viewEventSeq, post_id: a[0], viewed_at: a[1] }); return []; }
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
    if (s.startsWith('UPDATE cms_comments SET status')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.status = 'approved'; return []; }
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
    if (s.startsWith('SELECT key_id, key_hash, name, created_at, revoked, daily_limit FROM cerpen_api_keys ORDER BY created_at DESC')) return [...this.cerpenApiKeys].sort((x, y) => y.created_at - x.created_at);
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
    throw new Error('Mock SQL tidak dikenal: ' + s);
  }
}
const env = { DB: new MockDB(), BACKUP_DB: new MockDB(), ADMIN_TOKEN: 'test-admin-token', CERPEN_PATH_KEY: '11'.repeat(32) };
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
r = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'salah' }); assert(r.status === 403, 'login admin salah ditolak (pesan generik)');
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
r = await call('POST', '/akun/daftar', { username: 'budi', password: 'password123' }); assert(r.status === 303, 'daftar akun komentator redirect');
let userCookie = cookieHeader(cookiesOf(r));
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
r = await call('GET', '/'); t = await r.text();
assert(t.includes('Paginasi 12') && !t.includes('Paginasi 01') && t.includes('Post lama'), 'pagination halaman 1: 10 terbaru + link Post lama');
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
assert(t.includes('AdSense: ID penayang'), 'pengaturan: kolom AdSense tampil');
assert(t.includes('name="donate_url"'), 'pengaturan: kolom link donasi tampil');
r = await call('POST', '/kendali/settings', { csrf, site_title: 'Hozin King', theme: 'gelap', adsense_client: 'ca-pub-1234567890123456', adsense_slot: '1234567890' }, cookie); assert(r.status === 303, 'pengaturan AdSense tersimpan');
r = await call('GET', '/'); t = await r.text();
assert(t.includes('adsbygoogle') && t.includes('ca-pub-1234567890123456'), 'AdSense: unit tampil di beranda bila client diisi');
assert(r.headers.get('content-security-policy') && r.headers.get('content-security-policy').includes('pagead2.googlesyndication.com'), 'AdSense: CSP dilonggarkan hanya untuk domain Google Ads');
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
r = await call('POST', '/akun/daftar', { username: 'pw8', password: '12345678' }); assert(r.status === 303, 'password: 8 karakter lolos');
r = await call('POST', '/akun/daftar', { username: 'pw128', password: 'x'.repeat(128) }); assert(r.status === 303, 'password: 128 karakter lolos');
r = await call('POST', '/akun/daftar', { username: 'pw129', password: 'x'.repeat(129) }); assert(r.status === 400, 'password: 129 karakter ditolak 400');
assert(![...env.DB.users.values()].some(u => u.username === 'pw129'), 'password: 129 karakter tidak membuat akun');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/login', { username: 'pw8', password: 'x'.repeat(200) }); assert(r.status === 403, 'password: login 200 karakter ditolak 403 generik');
r = await call('POST', '/akun/login', { username: 'pw8', password: '12345678' }); assert(r.status === 303, 'password: login benar tetap lolos setelah percobaan panjang');
env.DB.rateLimits = new Map();
r = await call('POST', '/akun/daftar', { username: 'pwspasi', password: '  rahasia123  ' }); assert(r.status === 303, 'password: spasi di awal/akhir diterima sebagai bagian password');
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
r = await callStream('POST', '/akun/daftar', 'username=streamok&password=password123');
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
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
const csrf38 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(t.includes('name="cerpen_config"') && t.includes('Remote Config — Cerpen Hozin'), 'cerpen-config: textarea + kartu tampil di Pengaturan');
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
console.log('Selesai, exitCode=' + (process.exitCode || 0));
