// Uji WorkerCMS tanpa Cloudflare: mock D1 sederhana untuk pola SQL yang dipakai worker.js.
// Jalankan: node test.mjs  (harus keluar semua OK (kini 18+ cek, termasuk CSRF & rate-limit))
import worker from './worker.js';
import { themes } from './themes.js';
import { renderPage, envSiteTitle, pruneRateTables } from './store.js';
import { parseTags, tagSlug } from './util.js';
import { tagLinks } from './content.js';

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async run() { return this.db.exec(this.sql, this.args, 'run'); }
  async all() { return { results: this.db.exec(this.sql, this.args, 'all') }; }
  async first() { const r = this.db.exec(this.sql, this.args, 'all'); return r[0] || null; }
}
class MockDB {
  constructor() {
    this.posts = []; this.comments = []; this.settings = new Map(); this.plugins = new Map(); this.commentSeq = 0; this.attempts = []; this.backupRuns = []; this.refreshTokens = []; this.viewEvents = [];
    this.users = new Map(); this.votes = []; this.rateLimits = new Map(); this.loadtestRuns = [];
    this.dracinKeys = []; this.dracinCatalog = []; this.dracinEpisodes = []; this.dracinSeeds = []; this.dracinUsage = [];
    this.backupDracinKeys = 0; this.backupDracinCatalog = 0; this.backupDracinEpisodes = 0; this.backupDracinSeeds = 0; this.backupDracinUsage = 0;
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { for (const s of stmts) await s.run(); }
  exec(sql, a, mode) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return [];
    if (s.startsWith('PRAGMA table_info(cms_posts)')) return [{ name: 'id' }, { name: 'slug' }, { name: 'title' }, { name: 'body' }, { name: 'category' }, { name: 'status' }, { name: 'created_at' }, { name: 'updated_at' }, { name: 'body_mode' }, { name: 'visibility' }, { name: 'publish_at' }, { name: 'post_password_hash' }, { name: 'post_password_salt' }, { name: 'views' }, { name: 'tags' }];
    if (s.startsWith('PRAGMA table_info(cms_comments)')) return [{ name: 'id' }, { name: 'post_id' }, { name: 'name' }, { name: 'text' }, { name: 'status' }, { name: 'created_at' }, { name: 'parent_id' }];
    if (s.startsWith('PRAGMA table_info(cms_refresh_tokens)')) return [{ name: 'id' }, { name: 'token_hash' }, { name: 'device' }, { name: 'ip' }, { name: 'created_at' }, { name: 'last_used_at' }, { name: 'expires_at' }, { name: 'revoked' }, { name: 'replaced_by' }, { name: 'remember' }];
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
    if (s.startsWith('SELECT * FROM cms_users ORDER BY created_at DESC')) return [...this.users.values()].sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('SELECT * FROM cms_users ORDER BY created_at ASC')) return [...this.users.values()].sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('SELECT id, username, created_at FROM cms_users')) return [...this.users.values()].map(u => ({ id: u.id, username: u.username, created_at: u.created_at })).sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('DELETE FROM cms_users')) { this.users.delete(a[0]); return []; }
    if (s.startsWith('SELECT count FROM cms_rate_limits')) return this.rateLimits.has(a[0]) ? [{ count: this.rateLimits.get(a[0]) }] : [];
    if (s.startsWith('INSERT INTO cms_rate_limits')) { this.rateLimits.set(a[0], (this.rateLimits.get(a[0]) || 0) + 1); (this.rateLimitsAt = this.rateLimitsAt || new Map()).set(a[0], Date.now()); return []; }
    if (s.startsWith('DELETE FROM cms_rate_limits WHERE window_start')) { const cut = new Date(a[0]).getTime(); for (const [k, at] of (this.rateLimitsAt || new Map()).entries()) { if (at < cut) { this.rateLimits.delete(k); this.rateLimitsAt.delete(k); } } return []; }
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
    if (s.startsWith('INSERT INTO cms_login_attempts')) { this.attempts.push({ ip: a[0], created_at: a[1] }); return []; }
    if (s.startsWith('SELECT COUNT(*) AS n FROM cms_login_attempts')) return [{ n: this.attempts.filter(x => x.ip === a[0] && x.created_at > a[1]).length }];
    if (s.startsWith('DELETE FROM cms_login_attempts WHERE created_at')) { this.attempts = this.attempts.filter(x => x.created_at >= a[0]); return []; }
    if (s.startsWith('DELETE FROM cms_login_attempts')) { this.attempts = this.attempts.filter(x => x.ip !== a[0]); return []; }
    if (s.startsWith('INSERT INTO cms_refresh_tokens')) { this.refreshTokens.push({ id: a[0], token_hash: a[1], device: a[2], ip: a[3], created_at: a[4], last_used_at: a[5], expires_at: a[6], revoked: 0, replaced_by: '', remember: a[7], ip_changed: a[8] || 0, prev_ip: a[9] || '' }); return []; }
    if (s.startsWith('SELECT * FROM cms_refresh_tokens WHERE token_hash')) return this.refreshTokens.filter(x => x.token_hash === a[0]);
    if (s.startsWith('SELECT id, device, ip, ip_changed, prev_ip, created_at, last_used_at, expires_at FROM cms_refresh_tokens')) return this.refreshTokens.filter(x => x.revoked === 0 && x.expires_at > a[0]).sort((x, y) => y.last_used_at.localeCompare(x.last_used_at));
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
    if (s.startsWith('INSERT INTO cms_backup_posts')) { this.backupPosts = (this.backupPosts || 0) + 1; (this.backupPostRows = this.backupPostRows || []).push({ id: a[0], post_password_hash: a[11], post_password_salt: a[12] }); return []; }
    if (s.startsWith('INSERT INTO cms_backup_comments')) { this.backupComments = (this.backupComments || 0) + 1; return []; }
    if (s.startsWith('INSERT INTO cms_backup_settings') || s.startsWith('INSERT INTO cms_backup_plugins') || s.startsWith('INSERT INTO cms_backup_users') || s.startsWith('INSERT INTO cms_backup_votes')) {
      if (s.startsWith('INSERT INTO cms_backup_settings')) (this.backupSettings = this.backupSettings || []).push({ key: a[0], value: a[1] });
      if (s.startsWith('INSERT INTO cms_backup_users')) (this.backupUsers = this.backupUsers || []).push({ id: a[0], username: a[1], password_hash: a[2], salt: a[3], created_at: a[4] });
      return [];
    }
    if (s === 'SELECT COUNT(*) AS n FROM cms_posts') return [{ n: this.posts.length }];
    if (s.startsWith('SELECT value FROM cms_settings')) return this.settings.has(a[0]) ? [{ value: this.settings.get(a[0]) }] : [];
    if (s.startsWith('SELECT * FROM cms_settings ORDER')) return [...this.settings.entries()].map(([key, value]) => ({ key, value })).sort((x, y) => x.key.localeCompare(y.key));
    if (s.startsWith('SELECT key, value FROM cms_settings WHERE key NOT IN')) return [...this.settings.entries()].filter(([k]) => !['imgbb_api_keys', 'imgbb_api_key', 'csrf_secret'].includes(k)).map(([key, value]) => ({ key, value })).sort((x, y) => x.key.localeCompare(y.key));
    if (s.startsWith('SELECT * FROM cms_plugins ORDER')) return [...this.plugins.entries()].map(([id, enabled]) => ({ id, enabled })).sort((x, y) => x.id.localeCompare(y.id));
    if (s.startsWith('SELECT * FROM cms_plugins') || s.startsWith('SELECT id, enabled FROM cms_plugins')) return [...this.plugins.entries()].map(([id, enabled]) => ({ id, enabled }));
    if (s.startsWith('SELECT * FROM cms_posts WHERE status')) {
      if (s.includes("visibility = 'public'")) {
        const all = [...this.posts].filter(p => p.status === 'published' && p.visibility === 'public' && String(p.publish_at || p.created_at) <= a[0]).sort((x, y) => String(y.publish_at || y.created_at).localeCompare(String(x.publish_at || x.created_at)));
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
    if (s.startsWith('SELECT * FROM cms_posts ORDER')) return [...this.posts].sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('SELECT id FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ id: p.id }));
    if (s.startsWith('SELECT * FROM cms_comments WHERE post_id')) return this.comments.filter(c => c.post_id === a[0] && c.status === 'approved').sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('SELECT * FROM cms_comments ORDER')) return [...this.comments].sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('INSERT INTO cms_view_events')) { this.viewEvents.push({ post_id: a[0], viewed_at: a[1] }); return []; }
    if (s.startsWith('INSERT INTO cms_loadtest_runs')) { this.loadtestRuns.push({ id: a[0], created_at: a[1], vu: a[2], duration_s: a[3], p95_ms: a[4], failed_rate: a[5], passed: a[6], details: a[7] }); return []; }
    if (s.startsWith('SELECT * FROM cms_loadtest_runs ORDER BY created_at DESC')) return [...this.loadtestRuns].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 10);
    if (s.startsWith('SELECT * FROM cms_loadtest_runs ORDER BY created_at ASC')) return [...this.loadtestRuns].sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('INSERT INTO cms_backup_loadtest_runs')) { this.backupLoadtests = (this.backupLoadtests || 0) + 1; return []; }
    if (s.startsWith('SELECT post_id, viewed_at FROM cms_view_events')) return [...this.viewEvents].sort((x, y) => y.viewed_at.localeCompare(x.viewed_at));
    if (s.startsWith('SELECT * FROM cms_comments WHERE id')) return this.comments.filter(c => c.id === a[0]);
    if (s.startsWith('UPDATE cms_comments SET text')) { const c = this.comments.find(x => x.id === a[1]); if (c) { c.text = a[0]; if (s.includes("status = 'pending'")) c.status = 'pending'; } return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned = 0 WHERE post_id')) { this.comments.filter(c => c.post_id === a[0] && c.id !== a[1]).forEach(c => { c.pinned = 0; }); return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned = 1')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.pinned = 1; return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned = 0')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.pinned = 0; return []; }
    if (s.startsWith('UPDATE cms_comments SET pinned')) { const c = this.comments.find(x => x.id === a[1]); if (c) c.pinned = a[0]; return []; }
    if (s.startsWith('UPDATE cms_comments SET status')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.status = 'approved'; return []; }
    if (s.startsWith('UPDATE cms_plugins SET enabled')) { this.plugins.set(a[1], a[0]); return []; }
    // Mock Dracin: kunci, katalog, episode, seed, usage (tanpa IP / user-agent di mana pun)
    if (s.startsWith('PRAGMA table_info(dracin_api_usage)')) return [{ name: 'ts' }, { name: 'key_id' }, { name: 'endpoint' }, { name: 'method' }, { name: 'status' }, { name: 'country' }, { name: 'region' }, { name: 'city' }];
    if (s.startsWith('SELECT * FROM dracin_api_keys WHERE key_hash')) return this.dracinKeys.filter(k => k.key_hash === a[0]);
    if (s.startsWith('SELECT * FROM dracin_api_keys ORDER BY created_at')) return [...this.dracinKeys].sort((x, y) => s.includes('DESC') ? y.created_at - x.created_at : x.created_at - y.created_at);
    if (s.startsWith('INSERT INTO dracin_api_keys')) { this.dracinKeys.push({ id: a[0], name: a[1], key_hash: a[2], scope: a[3], active: a[4], created_at: a[5] }); return []; }
    if (s.startsWith('UPDATE dracin_api_keys SET active = 0')) { const k = this.dracinKeys.find(x => x.id === a[0]); if (k) k.active = 0; return []; }
    if (s.startsWith('SELECT COUNT(*) AS n FROM dracin_api_usage')) return [{ n: this.dracinUsage.length }];
    if (s.startsWith('SELECT * FROM dracin_api_usage ORDER BY ts DESC')) return [...this.dracinUsage].sort((x, y) => y.ts - x.ts).slice(0, 5000);
    if (s.startsWith('SELECT * FROM dracin_api_usage ORDER BY ts ASC')) return [...this.dracinUsage].sort((x, y) => x.ts - y.ts);
    if (s.startsWith('INSERT INTO dracin_api_usage')) { this.dracinUsage.push({ ts: a[0], key_id: a[1], endpoint: a[2], method: a[3], status: a[4], country: a[5], region: a[6], city: a[7] }); return []; }
    if (s.startsWith('SELECT * FROM dracin_catalog WHERE platform = ? AND title_id = ?')) return this.dracinCatalog.filter(x => x.platform === a[0] && x.title_id === a[1]);
    if (s.startsWith('SELECT * FROM dracin_catalog')) {
      if (s.includes('ORDER BY platform ASC')) return [...this.dracinCatalog].sort((x, y) => (x.platform + x.title_id).localeCompare(y.platform + y.title_id));
      let i = 0, pf = null, lf = null;
      if (s.includes('platform = ?')) pf = a[i++];
      if (s.includes('language = ?')) lf = a[i++];
      const limit = a[i++], offset = a[i++];
      let rows = [...this.dracinCatalog];
      if (pf) rows = rows.filter(x => x.platform === pf);
      if (lf) rows = rows.filter(x => x.language === lf);
      rows.sort((x, y) => y.updated_at - x.updated_at);
      return rows.slice(offset, offset + limit);
    }
    if (s.startsWith('INSERT INTO dracin_catalog')) {
      const row = { platform: a[0], title_id: a[1], title: a[2], cover_url: a[3], synopsis: a[4], language: a[5], episode_count: a[6], free_count: a[7], locked_count: a[8], updated_at: a[9] };
      const ix = this.dracinCatalog.findIndex(x => x.platform === row.platform && x.title_id === row.title_id);
      if (ix >= 0) this.dracinCatalog[ix] = row; else this.dracinCatalog.push(row);
      return [];
    }
    if (s.startsWith('DELETE FROM dracin_catalog')) { this.dracinCatalog = this.dracinCatalog.filter(x => !(x.platform === a[0] && x.title_id === a[1])); return []; }
    if (s.startsWith('SELECT * FROM dracin_episodes')) return [...this.dracinEpisodes].sort((x, y) => (x.platform + x.title_id).localeCompare(y.platform + y.title_id) || x.idx - y.idx);
    if (s.startsWith('INSERT OR REPLACE INTO dracin_episodes')) {
      const row = { platform: a[0], title_id: a[1], idx: a[2], item_id: a[3], duration_s: a[4], locked: a[5] };
      const ix = this.dracinEpisodes.findIndex(x => x.platform === row.platform && x.title_id === row.title_id && x.idx === row.idx);
      if (ix >= 0) this.dracinEpisodes[ix] = row; else this.dracinEpisodes.push(row);
      return [];
    }
    if (s.startsWith('DELETE FROM dracin_episodes')) { this.dracinEpisodes = this.dracinEpisodes.filter(x => !(x.platform === a[0] && x.title_id === a[1])); return []; }
    if (s.startsWith('SELECT * FROM dracin_seeds WHERE platform = ? AND query = ?')) return this.dracinSeeds.filter(x => x.platform === a[0] && x.query === a[1]);
    if (s.startsWith('SELECT * FROM dracin_seeds WHERE enabled = 1')) return this.dracinSeeds.filter(x => Number(x.enabled) === 1).sort((x, y) => (x.platform + x.query).localeCompare(y.platform + y.query));
    if (s.startsWith('SELECT * FROM dracin_seeds')) return [...this.dracinSeeds].sort((x, y) => (x.platform + x.query).localeCompare(y.platform + y.query));
    if (s.startsWith('INSERT OR REPLACE INTO dracin_seeds')) {
      const row = { platform: a[0], query: a[1], enabled: a[2] };
      const ix = this.dracinSeeds.findIndex(x => x.platform === row.platform && x.query === row.query);
      if (ix >= 0) this.dracinSeeds[ix] = row; else this.dracinSeeds.push(row);
      return [];
    }
    if (s.startsWith('UPDATE dracin_seeds SET enabled')) { const sd = this.dracinSeeds.find(x => x.platform === a[1] && x.query === a[2]); if (sd) sd.enabled = a[0]; return []; }
    if (s.startsWith('DELETE FROM dracin_seeds')) { this.dracinSeeds = this.dracinSeeds.filter(x => !(x.platform === a[0] && x.query === a[1])); return []; }
    if (s.startsWith('INSERT INTO cms_backup_dracin_api_keys')) { this.backupDracinKeys++; return []; }
    if (s.startsWith('INSERT INTO cms_backup_dracin_catalog')) { this.backupDracinCatalog++; return []; }
    if (s.startsWith('INSERT INTO cms_backup_dracin_episodes')) { this.backupDracinEpisodes++; return []; }
    if (s.startsWith('INSERT INTO cms_backup_dracin_seeds')) { this.backupDracinSeeds++; return []; }
    if (s.startsWith('INSERT INTO cms_backup_dracin_api_usage')) { this.backupDracinUsage++; return []; }
    if (s.startsWith('DELETE FROM cms_posts')) { this.posts = this.posts.filter(p => p.id !== a[0]); return []; }
    if (s.startsWith('DELETE FROM cms_comments')) { this.comments = this.comments.filter(c => c.id !== a[0]); return []; }
    throw new Error('Mock SQL tidak dikenal: ' + s);
  }
}
const env = { DB: new MockDB(), BACKUP_DB: new MockDB(), ADMIN_TOKEN: 'test-admin-token' };
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
assert(t.includes('id="copyr"') && t.includes('Online sejak 1 Januari 2024') && !t.includes('id="uptime"'), 'beranda: footer copyright + uptime sederhana (teks statis, tanpa detik berjalan)');

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
let csrf = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
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
let userCsrf = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
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
// H2 (5 Nov 2026): backup TIDAK menyalin rahasia — kunci ImgBB, csrf_secret,
// hash/salt password komentator & post dikosongkan di BACKUP_DB
// (csrf_secret TIDAK disentuh di sini: sudah ada dari login §2, dan asersi
// berbasis key — menimpanya akan mematikan token csrf yang dipakai tes lain)
env.DB.settings.set('imgbb_api_keys', JSON.stringify([{ k: 'RAHASIA-IMGBB', ok: '', fail: '', fail_reason: '' }]));
env.DB.settings.set('imgbb_api_key', 'RAHASIA-LAMA');
env.BACKUP_DB.backupSettings = []; env.BACKUP_DB.backupUsers = []; env.BACKUP_DB.backupPostRows = [];
r = await call('POST', '/kendali/backup', { csrf }, cookie); assert(r.status === 303, 'H2: backup dengan rahasia tetap redirect');
assert(!env.BACKUP_DB.backupSettings.some(s => s.key === 'imgbb_api_keys' || s.key === 'imgbb_api_key' || s.key === 'csrf_secret'), 'H2: kunci ImgBB + csrf_secret tidak tersalin ke backup');
assert(env.BACKUP_DB.backupSettings.some(s => s.key === 'site_title'), 'H2: pengaturan biasa tetap tersalin ke backup');
assert(env.BACKUP_DB.backupUsers.some(u => u.username === 'budi') && env.BACKUP_DB.backupUsers.every(u => u.password_hash === '' && u.salt === ''), 'H2: username tersalin, hash/salt password komentator dikosongkan di backup');
assert((env.BACKUP_DB.backupPostRows || []).length >= 2 && env.BACKUP_DB.backupPostRows.every(p => p.post_password_hash === '' && p.post_password_salt === ''), 'H2: hash/salt password post dikosongkan di backup');
// Bersihkan rahasia tes supaya tes berikutnya (ImgBB) mulai dari keadaan tanpa kunci
env.DB.settings.delete('imgbb_api_keys'); env.DB.settings.delete('imgbb_api_key');
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
// Pakai ulang refresh lama -> tanda pencurian -> semua sesi dicabut
r = await call('GET', '/kendali', null, refreshOnly); t = await r.text();
assert(r.status === 303 && (r.headers.get('location') || '').startsWith('/akun'), 'refresh lama yang dipakai ulang dialihkan ke /akun');
assert(env.DB.refreshTokens.every(x => x.revoked === 1), 'pakai ulang refresh mencabut semua sesi');
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
// H4 (5 Nov 2026): refresh token diikat IP + perangkat
// (helper lokal: request dengan IP + user-agent yang bisa diatur)
async function callNet(method, path, ip, ua, cookieH = '', body = null) {
  const headers = { 'cf-connecting-ip': ip, 'user-agent': ua };
  if (cookieH) headers.cookie = cookieH;
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const req = new Request(base + path, { method, headers, body: body ? new URLSearchParams(body).toString() : undefined });
  return worker.fetch(req, env);
}
env.DB.attempts = [];
let r4 = await callNet('POST', '/akun/login', '10.0.0.1', 'POCO-Test/1.0', '', { username: 'muchammadhozin@gmail.com', password: 'test-admin-token' });
let cookie4 = cookieHeader(cookiesOf(r4));
assert(cookie4.includes('cms_refresh='), 'H4: login dari IP A memberi refresh');
const refreshA = cookie4.split('; ').find(c => c.startsWith('cms_refresh='));
const rowA = env.DB.refreshTokens[env.DB.refreshTokens.length - 1];
assert(rowA.ip === '10.0.0.1' && rowA.device === 'POCO-Test/1.0', 'H4: refresh menyimpan IP + perangkat saat login');
r4 = await callNet('GET', '/kendali', '10.0.0.1', 'POCO-Test/1.0', refreshA);
assert(r4.status === 200, 'H4: refresh IP + perangkat sama tetap masuk');
const rowA2 = env.DB.refreshTokens[env.DB.refreshTokens.length - 1];
assert(rowA2.ip_changed === 0, 'H4: refresh normal tanpa tanda IP berubah');
const refreshA2 = cookieHeader(cookiesOf(r4)).split('; ').find(c => c.startsWith('cms_refresh='));
r4 = await callNet('GET', '/kendali', '10.0.0.2', 'POCO-Test/1.0', refreshA2);
assert(r4.status === 200, 'H4: refresh IP beda perangkat sama tetap masuk (pindah jaringan)');
const rowA3 = env.DB.refreshTokens[env.DB.refreshTokens.length - 1];
assert(rowA3.ip_changed === 1 && rowA3.prev_ip === '10.0.0.1' && rowA3.ip === '10.0.0.2', 'H4: refresh IP beda ditandai ip_changed + prev_ip');
const refreshA3 = cookieHeader(cookiesOf(r4)).split('; ').find(c => c.startsWith('cms_refresh='));
r4 = await callNet('GET', '/kendali/sessions', '10.0.0.2', 'POCO-Test/1.0', cookieHeader(cookiesOf(r4)));
t = await r4.text();
assert(t.includes('IP berubah dari 10.0.0.1'), 'H4: halaman sesi menampilkan peringatan IP berubah');
r4 = await callNet('GET', '/kendali', '9.9.9.9', 'Pencuri/1.0', refreshA3);
assert(r4.status === 303 && (r4.headers.get('location') || '').startsWith('/akun'), 'H4: refresh IP + perangkat beda dialihkan ke /akun');
assert(env.DB.refreshTokens.every(x => x.revoked === 1), 'H4: IP + perangkat beda mencabut semua sesi');
// H5 (5 Nov 2026): login memutar kunci CSRF — token csrf lama mati, ambil yang baru
// (tes-tes berikutnya memakai csrf/userCsrf yang diperbarui di sini)
const csrfLama = csrf;
assert(env.DB.settings.get('csrf_secret') && env.DB.settings.get('csrf_secret') !== 'test-admin-token', 'H5: kunci CSRF tersimpan di settings, bukan ADMIN_TOKEN');
env.DB.attempts = [];
r4 = await call('POST', '/akun/login', { username: 'muchammadhozin@gmail.com', password: 'test-admin-token' });
cookie = cookieHeader(cookiesOf(r4));
r4 = await call('GET', '/kendali', null, cookie); t = await r4.text();
csrf = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(csrf.length > 10 && csrf !== csrfLama, 'H5: login baru memutar token CSRF');
r4 = await call('POST', '/kendali/posts', { csrf: csrfLama, title: 'Post CSRF Lama', category: 'X', body: 'x' }, cookie); assert(r4.status === 403, 'H5: token CSRF lama setelah login ulang ditolak');
r4 = await call('GET', '/post/post-uji', null, userCookie); t = await r4.text();
userCsrf = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(userCsrf.length > 10, 'H5: CSRF komentator baru setelah login admin ulang');
// H6 (5 Nov 2026): tabel rate-limit + percobaan login di-prune berkala
env.DB.rateLimits.set('stale-key:0', 5);
(env.DB.rateLimitsAt = env.DB.rateLimitsAt || new Map()).set('stale-key:0', Date.now() - 25 * 3600 * 1000);
env.DB.rateLimits.set('fresh-key:0', 1);
(env.DB.rateLimitsAt = env.DB.rateLimitsAt || new Map()).set('fresh-key:0', Date.now());
env.DB.attempts.push({ ip: '9.9.9.9', created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
env.DB.attempts.push({ ip: '10.10.10.10', created_at: new Date().toISOString() });
await pruneRateTables(env);
assert(!env.DB.rateLimits.has('stale-key:0'), 'H6: baris rate-limit kedaluwarsa (>24 jam) di-prune');
assert(env.DB.rateLimits.has('fresh-key:0'), 'H6: baris rate-limit baru tetap ada setelah prune');
assert(!env.DB.attempts.some(x => x.ip === '9.9.9.9'), 'H6: percobaan login lama (>1 jam) di-prune');
assert(env.DB.attempts.some(x => x.ip === '10.10.10.10'), 'H6: percobaan login baru tetap ada setelah prune');
env.DB.rateLimits.delete('fresh-key:0');
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

// 10. Tema v2 ala WordPress: 6 tema, responsif lintas platform
assert(Object.keys(themes).join(',') === 'terang,gelap,majalah,minimal,renando,glass', 'tema: 6 tema tersedia (terang, gelap, majalah, minimal, renando, glass)');
assert(themes.gelap.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' }).includes('#05070d'), 'tema gelap: identitas default dipertahankan');
assert(themes.majalah.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' }).includes('Georgia'), 'tema majalah: font serif berbeda dari terang/gelap');
assert(themes.minimal.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' }).includes('border-radius:8px'), 'tema minimal: radius kartu berbeda');
const renandoHtml = themes.renando.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' });
assert(renandoHtml.includes('#0a0a0a') && renandoHtml.includes('renandoUp'), 'tema renando: latar pekat + animasi naik');
const glassHtml = themes.glass.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' });
assert(glassHtml.includes('glass-dock') && glassHtml.includes('backdrop-filter') && glassHtml.includes('glass-gooey'), 'tema glass: dock kaca + blur + filter gooey');
assert((glassHtml.match(/class="glass-dock-item"/g) || []).length === 2 && glassHtml.includes('href="/"') && glassHtml.includes('href="/akun"'), 'tema glass: hanya 2 ikon nyata (Beranda + Akun), tanpa tombol palsu');
const terangHtml = themes.terang.render({ siteTitle: 'WorkerCMS', pageTitle: 'X', content: '' });
assert(terangHtml.includes('width=device-width') && terangHtml.includes('@media (max-width:600px)') && terangHtml.includes('min-height:44px'), 'tema responsif: viewport + breakpoint HP + target sentuh 44px');

// 11. Editor post: HTML disanitasi, teks di-escape, header keamanan, honeypot, rate-limit komentar
r = await call('POST', '/kendali/posts', { csrf, title: 'Post HTML', category: 'Tekno', body: '<script>alert(1)</script><p>Halo <b>Dunia</b></p><a href="javascript:alert(1)">x</a><img src="https://x.test/a.png" onerror="alert(1)"><video controls src="https://x.test/v.mp4"></video>', body_mode: 'html' }, cookie);
r = await call('GET', '/post/post-html'); t = await r.text();
assert(t.includes('<p>Halo <b>Dunia</b></p>') && t.includes('<video') && !t.includes('<script>alert(1)') && !t.includes('javascript:') && !t.includes('onerror'), 'mode HTML: tag aman lolos, script/javascript/onerror dibuang');
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
r = await call('GET', '/kendali/settings', null, cookie); t = await r.text();
assert(t.includes('AdSense: ID penayang'), 'pengaturan: kolom AdSense tampil');
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
r = await call('POST', '/kendali/super/pcbuilder', { csrf, pcbuilder_active: '1', pcbuilder_message: 'Event akhir pekan' }, cookie); assert(r.status === 303 && (r.headers.get('location') || '') === '/kendali/super', 'super panel: simpan event PC Builder redirect ke super');
r = await call('GET', '/api/pcbuilder-events'); t = await r.text();
assert(t.includes('discount') && t.includes('10'), 'pcbuilder events: aktif mengandung discount 10');
r = await call('POST', '/kendali/settings', { csrf, site_title: 'WorkerCMS', theme: 'terang', return_to: '/kendali/super' }, cookie); assert((r.headers.get('location') || '') === '/kendali/super', 'pengaturan: return_to ke super panel jalan');
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
assert(env.DB.comments.some(c => c.parent_id === arCid2 && c.name === 'Balasan Otomatis' && c.text === 'Terima kasih atas komentarnya!' && c.status === 'pending'), 'auto-reply: balasan bot tersimpan sebagai anak komentar, status pending (H3: ditinjau admin dulu)');
r = await call('GET', '/post/post-uji'); t = await r.text();
assert(!t.includes('Terima kasih atas komentarnya!'), 'auto-reply: balasan bot pending belum tampil di halaman post (H3)');
const botCount = env.DB.comments.filter(c => c.parent_id === arCid2 && c.name === 'Balasan Otomatis').length;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(arCid2) }, cookie);
assert(env.DB.comments.filter(c => c.parent_id === arCid2 && c.name === 'Balasan Otomatis').length === botCount, 'auto-reply: setujui ulang tidak menggandakan balasan');
// H3: balasan bot yang kena filter blokir (ada link) tidak disimpan sama sekali
// (tes simpan-massal plugin sebelumnya mematikan semua plugin kecuali reading-time,
// jadi nyalakan lagi ketiga plugin blokir lewat jalur resmi)
r = await call('POST', '/kendali/plugins/save', { csrf, 'plugin_reading-time': '1', 'plugin_blokir-link': '1', 'plugin_blokir-kotor': '1', 'plugin_blokir-judol': '1' }, cookie); assert(r.status === 303, 'H3: aktifkan kembali plugin blokir redirect');
globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Cek https://contoh.com ya!' } }] }) });
env.DB.rateLimits = new Map();
r = await call('POST', '/post/post-uji/comment', { csrf: userCsrf, text: 'Komentar auto-reply link' }, userCookie);
const arCid4 = env.DB.comments[env.DB.comments.length - 1].id;
r = await call('POST', '/kendali/comments/approve', { csrf, id: String(arCid4) }, cookie); assert(r.status === 303, 'H3: setujui komentar pemicu filter tetap redirect');
assert(!env.DB.comments.some(c => c.parent_id === arCid4 && c.name === 'Balasan Otomatis'), 'H3: balasan bot ber-link tidak disimpan (filter blokir-link)');
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
// 30. Halaman uptime (perintah pemilik 2 Nov 2026): footer "Online sejak ..." jadi tautan ke /uptime
r = await call('GET', '/'); t = await r.text(); assert(t.includes('<a href="/uptime">Online sejak 1 Januari 2024</a>'), 'uptime: footer menautkan "Online sejak" ke /uptime');
r = await call('GET', '/uptime'); t = await r.text(); assert(r.status === 200 && t.includes('Status Situs') && t.includes('Online') && t.includes('Online sejak 1 Januari 2024') && t.includes('hari'), 'uptime: /uptime 200, menampilkan status + hitungan hari sejak 1 Jan 2024');
assert(!t.includes('99,9%') && !t.includes('99.9%'), 'uptime: tidak mengklaim persen uptime tanpa data monitoring');
// 31. API Dracin (PART A, lokal saja): kunci hash-only, scope, sync idempotent,
// filter katalog, CRUD admin, usage tanpa IP/user-agent, kartu Super Panel
async function dracinKeyFor(name, scope) {
  r = await call('POST', '/kendali/super/dracin-keys', { csrf, action: 'create', name, scope }, cookie);
  t = await r.text();
  assert(r.status === 200 && t.includes('hanya tampil sekali'), 'dracin: buat kunci ' + scope + ' tampil sekali di halaman');
  const raw = (t.match(/<code>([A-Za-z0-9_-]{32,})<\/code>/) || [])[1] || '';
  assert(raw.length >= 32, 'dracin: kunci mentah minimal 32 byte (b64url)');
  return raw;
}
const syncKey = await dracinKeyFor('sync-test', 'sync');
const readKey = await dracinKeyFor('read-test', 'read');
const adminKey = await dracinKeyFor('admin-test', 'admin');
const storedSync = env.DB.dracinKeys.find(k => k.name === 'sync-test');
assert(storedSync && storedSync.key_hash !== syncKey && /^[0-9a-f]{64}$/.test(storedSync.key_hash), 'dracin: yang tersimpan hanya hash SHA-256 hex, bukan kunci mentah');
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(t.includes('API Dracin') && t.includes('sync-test') && !t.includes(syncKey), 'dracin: Super Panel menampilkan nama kunci, bukan kunci mentah');
const syncBody = { titles: [{ platform: 'dracin', title_id: 't1', title: 'Judul Satu', cover_url: 'https://cdn.test/c1.jpg', synopsis: 'Sinopsis.', language: 'id', episode_count: 2, free_count: 1, locked_count: 1, episodes: [{ idx: 0, item_id: 'e0', duration_s: 60, locked: 0 }, { idx: 1, item_id: 'e1', duration_s: 90, locked: 1 }] }] };
r = await callJson('POST', '/api/dracin/sync', syncBody);
assert(r.status === 401, 'dracin: sync tanpa kunci ditolak 401');
r = await callJson('POST', '/api/dracin/sync', syncBody, { authorization: 'Bearer ' + readKey });
assert(r.status === 403, 'dracin: sync dengan scope read ditolak 403');
r = await callJson('POST', '/api/dracin/sync', { titles: [{ platform: 'dracin', title_id: 'x', title: 123 }] }, { authorization: 'Bearer ' + syncKey });
assert(r.status === 400, 'dracin: sync tipe judul salah ditolak 400');
r = await callJson('POST', '/api/dracin/sync', syncBody, { authorization: 'Bearer ' + syncKey });
let syncRes = await r.json();
assert(r.status === 200 && syncRes.titles === 1 && syncRes.episodes === 2, 'dracin: sync sukses, counts {titles:1, episodes:2}');
r = await callJson('POST', '/api/dracin/sync', syncBody, { authorization: 'Bearer ' + syncKey });
syncRes = await r.json();
assert(r.status === 200 && syncRes.titles === 1 && syncRes.episodes === 2 && env.DB.dracinCatalog.length === 1 && env.DB.dracinEpisodes.length === 2, 'dracin: sync kedua idempotent, tanpa duplikat');
const enBody = { titles: [{ platform: 'dracin', title_id: 't2', title: 'Title Two', language: 'en', episode_count: 0, free_count: 0, locked_count: 0, episodes: [] }] };
r = await callJson('POST', '/api/dracin/sync', enBody, { authorization: 'Bearer ' + syncKey });
assert(r.status === 200, 'dracin: sync judul kedua sukses');
r = await callJson('GET', '/api/dracin/catalog?dub=1', null);
let cat = await r.json();
assert(r.status === 200 && cat.titles.length === 1 && cat.titles[0].title_id === 't1', 'dracin: filter dub=1 hanya judul bahasa id');
r = await callJson('GET', '/api/dracin/catalog?platform=dracin&limit=1', null);
cat = await r.json();
assert(cat.titles.length === 1, 'dracin: pagination limit=1 mengembalikan 1 judul');
r = await callJson('POST', '/api/dracin/titles', { platform: 'dracin', title_id: 't3', title: 'Judul Tiga' }, { authorization: 'Bearer ' + syncKey });
assert(r.status === 403, 'dracin: CRUD judul dengan scope sync ditolak 403');
r = await callJson('POST', '/api/dracin/titles', { platform: 'dracin', title_id: 't3', title: 'Judul Tiga' }, { authorization: 'Bearer ' + adminKey });
assert(r.status === 201, 'dracin: CRUD judul dengan scope admin sukses 201');
r = await callJson('PUT', '/api/dracin/titles', { platform: 'dracin', title_id: 't3', title: 'Judul Tiga Diedit' }, { authorization: 'Bearer ' + adminKey });
assert(r.status === 200 && env.DB.dracinCatalog.find(x => x.title_id === 't3').title === 'Judul Tiga Diedit', 'dracin: PUT judul admin mengubah judul');
r = await callJson('DELETE', '/api/dracin/titles', { platform: 'dracin', title_id: 't3' }, { authorization: 'Bearer ' + readKey });
assert(r.status === 403, 'dracin: hapus judul dengan scope read ditolak 403');
r = await callJson('DELETE', '/api/dracin/titles', { platform: 'dracin', title_id: 't3' }, { authorization: 'Bearer ' + adminKey });
assert(r.status === 200 && !env.DB.dracinCatalog.some(x => x.title_id === 't3'), 'dracin: hapus judul admin sukses');
r = await callJson('POST', '/api/dracin/seeds', { platform: 'dracin', query: 'romance', enabled: 1 }, { authorization: 'Bearer ' + syncKey });
assert(r.status === 403, 'dracin: CRUD seed dengan scope sync ditolak 403');
r = await callJson('POST', '/api/dracin/seeds', { platform: 'dracin', query: 'romance', enabled: 1 }, { authorization: 'Bearer ' + adminKey });
assert(r.status === 201, 'dracin: tambah seed admin sukses');
r = await callJson('POST', '/api/dracin/seeds', { platform: 'dracin', query: 'hidden', enabled: 0 }, { authorization: 'Bearer ' + adminKey });
assert(r.status === 201, 'dracin: tambah seed nonaktif sukses');
r = await callJson('GET', '/api/dracin/seeds', null);
let seeds = await r.json();
assert(seeds.seeds.length === 1 && seeds.seeds[0].query === 'romance', 'dracin: GET seeds publik hanya yang enabled=1');
r = await callJson('PUT', '/api/dracin/seeds', { platform: 'dracin', query: 'hidden', enabled: 1 }, { authorization: 'Bearer ' + adminKey });
assert(r.status === 200, 'dracin: PUT seed admin sukses');
r = await callJson('GET', '/api/dracin/seeds', null);
seeds = await r.json();
assert(seeds.seeds.length === 2, 'dracin: seed yang diaktifkan muncul di GET publik');
r = await callJson('DELETE', '/api/dracin/seeds', { platform: 'dracin', query: 'hidden' }, { authorization: 'Bearer ' + adminKey });
assert(r.status === 200, 'dracin: hapus seed admin sukses');
const usageBefore = env.DB.dracinUsage.length;
r = await callJson('GET', '/api/dracin/catalog', null);
assert(r.status === 200, 'dracin: GET katalog publik sukses');
assert(env.DB.dracinUsage.length === usageBefore + 1, 'dracin: satu baris usage tercatat setelah GET katalog');
const urow = env.DB.dracinUsage[env.DB.dracinUsage.length - 1];
assert(JSON.stringify(Object.keys(urow).sort()) === JSON.stringify(['city', 'country', 'endpoint', 'key_id', 'method', 'region', 'status', 'ts']), 'dracin: baris usage hanya berisi ts/key_id/endpoint/method/status/country/region/city (tanpa ip/user-agent)');
assert(urow.endpoint === '/api/dracin/catalog' && urow.method === 'GET' && urow.status === 200, 'dracin: baris usage mencatat endpoint/metode/status benar');
// Pemeriksaan skema dari sumber (bukan dari mock): usage di schema.sql dan
// INSERT di worker.js tidak menyebut ip maupun user-agent sama sekali.
{
  const { readFileSync } = await import('node:fs');
  const schemaTxt = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  const usageLine = (schemaTxt.split('\n').find(l => l.includes('dracin_api_usage (ts')) || '');
  assert(usageLine.includes('country TEXT') && !/\bip\b/.test(usageLine.replace('key_id', '')) && !/user.agent/i.test(usageLine), 'dracin: schema.sql dracin_api_usage tanpa kolom ip/user-agent');
  const workerTxt = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  assert(workerTxt.includes('INSERT INTO dracin_api_usage (ts, key_id, endpoint, method, status, country, region, city)'), 'dracin: worker.js INSERT usage hanya 8 kolom, tanpa ip/user-agent');
}
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(t.includes('API Dracin') && t.includes('hits total') && t.includes('Per Kunci') && t.includes('Per Endpoint') && t.includes('Per Hari') && t.includes('Per Negara') && t.includes('Buat Kunci Baru'), 'dracin: kartu Super Panel tampil (total, per kunci/endpoint/hari/negara, form kunci)');
assert(t.includes('background:#3b82f6'), 'dracin: grafik batang per-hari Super Panel tampil');
assert(t.includes('terakhir dipakai'), 'dracin: kartu menampilkan terakhir dipakai per kunci (WIB)');
r = await call('POST', '/kendali/backup', { csrf }, cookie); assert(r.status === 303, 'dracin: tombol backup redirect');
assert(env.BACKUP_DB.backupDracinKeys >= 3 && env.BACKUP_DB.backupDracinCatalog >= 2 && env.BACKUP_DB.backupDracinEpisodes >= 2 && env.BACKUP_DB.backupDracinSeeds >= 1, 'dracin: backup menyalin kunci/katalog/episode/seed ke tabel cms_backup_dracin_*');
const revokeKey = await dracinKeyFor('revoke-me', 'sync');
const revokeId = env.DB.dracinKeys.find(k => k.name === 'revoke-me').id;
r = await call('POST', '/kendali/super/dracin-keys', { csrf, action: 'revoke', id: revokeId }, cookie); assert(r.status === 303, 'dracin: cabut kunci redirect');
r = await callJson('POST', '/api/dracin/sync', syncBody, { authorization: 'Bearer ' + revokeKey });
assert(r.status === 401, 'dracin: kunci yang dicabut ditolak 401');
r = await call('GET', '/kendali/super', null, cookie); t = await r.text();
assert(t.includes('revoke-me') && t.includes('dicabut'), 'dracin: kunci yang dicabut tampil sebagai dicabut di Super Panel');
// 30. H1 audit (31 Okt 2026): penulisan view dibatasi per IP, halaman tetap tampil
env.DB.rateLimits = new Map();
const h1Post = env.DB.posts.find(x => x.slug === 'post-uji');
const h1Before = Number(h1Post.views) || 0;
const h1EventsBefore = env.DB.viewEvents.length;
async function h1View() {
  const req = new Request(base + '/post/post-uji', { method: 'GET', headers: { 'cf-connecting-ip': '203.0.113.99' } });
  return worker.fetch(req, env);
}
for (let i = 0; i < 30; i++) { r = await h1View(); assert(r.status === 200, 'h1: 30 view pertama dari satu IP tetap tampil 200'); }
assert(Number(env.DB.posts.find(x => x.slug === 'post-uji').views) === h1Before + 30, 'h1: 30 view pertama menambah counter');
assert(env.DB.viewEvents.length === h1EventsBefore + 30, 'h1: 30 view pertama menambah riwayat view_events');
for (let i = 0; i < 5; i++) { r = await h1View(); t = await r.text(); assert(r.status === 200 && t.includes('Post Uji'), 'h1: view ke-31+ dari IP yang sama tetap tampil normal (tidak diblokir)'); }
assert(Number(env.DB.posts.find(x => x.slug === 'post-uji').views) === h1Before + 30, 'h1: view di atas limit 30/jam tidak menambah counter lagi');
assert(env.DB.viewEvents.length === h1EventsBefore + 30, 'h1: view di atas limit tidak menambah riwayat view_events');
console.log('Selesai, exitCode=' + (process.exitCode || 0));
