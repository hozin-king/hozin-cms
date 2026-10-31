// Uji WorkerCMS tanpa Cloudflare: mock D1 sederhana untuk pola SQL yang dipakai worker.js.
// Jalankan: node test.mjs  (harus keluar semua OK (kini 18+ cek, termasuk CSRF & rate-limit))
import worker from './worker.js';
import { themes } from './themes.js';
import { renderPage, envSiteTitle } from './store.js';

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
    this.users = new Map(); this.votes = []; this.rateLimits = new Map();
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { for (const s of stmts) await s.run(); }
  exec(sql, a, mode) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return [];
    if (s.startsWith('PRAGMA table_info(cms_posts)')) return [{ name: 'id' }, { name: 'slug' }, { name: 'title' }, { name: 'body' }, { name: 'category' }, { name: 'status' }, { name: 'created_at' }, { name: 'updated_at' }, { name: 'body_mode' }, { name: 'visibility' }, { name: 'publish_at' }, { name: 'post_password_hash' }, { name: 'post_password_salt' }, { name: 'views' }];
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
      this.posts.push({ id: a[0], slug: a[1], title: a[2], body: a[3], category: a[4], status: 'published', created_at: a[5], updated_at: a[6], body_mode: isSeed ? 'text' : (a[7] || 'text'), visibility: isSeed ? 'public' : (a[8] || 'public'), publish_at: isSeed ? a[7] : (a[9] || a[5]), post_password_hash: isSeed ? '' : (a[10] || ''), post_password_salt: isSeed ? '' : (a[11] || ''), views: 0 });
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
    if (s.startsWith('DELETE FROM cms_users')) { this.users.delete(a[0]); return []; }
    if (s.startsWith('SELECT count FROM cms_rate_limits')) return this.rateLimits.has(a[0]) ? [{ count: this.rateLimits.get(a[0]) }] : [];
    if (s.startsWith('INSERT INTO cms_rate_limits')) { this.rateLimits.set(a[0], (this.rateLimits.get(a[0]) || 0) + 1); return []; }
    if (s.startsWith('SELECT id, slug, visibility, publish_at, post_password_hash, post_password_salt FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ id: p.id, slug: p.slug, visibility: p.visibility, publish_at: p.publish_at, post_password_hash: p.post_password_hash, post_password_salt: p.post_password_salt }));
    if (s.startsWith('UPDATE cms_posts SET views')) { const p = this.posts.find(x => x.id === a[0]); if (p) p.views = (p.views || 0) + 1; return []; }
    if (s.startsWith('SELECT id, post_id FROM cms_comments WHERE id')) return this.comments.filter(c => c.id === a[0]).map(c => ({ id: c.id, post_id: c.post_id }));
    if (s.startsWith('SELECT id FROM cms_comments WHERE post_id')) return this.comments.filter(c => c.post_id === a[0]).map(c => ({ id: c.id }));
    if (s.startsWith('SELECT vote FROM cms_comment_votes')) return this.votes.filter(v => v.comment_id === a[0] && v.user_key === a[1]).map(v => ({ vote: v.vote }));
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
    if (s.startsWith('DELETE FROM cms_login_attempts')) { this.attempts = this.attempts.filter(x => x.ip !== a[0]); return []; }
    if (s.startsWith('INSERT INTO cms_refresh_tokens')) { this.refreshTokens.push({ id: a[0], token_hash: a[1], device: a[2], ip: a[3], created_at: a[4], last_used_at: a[5], expires_at: a[6], revoked: 0, replaced_by: '', remember: a[7] }); return []; }
    if (s.startsWith('SELECT * FROM cms_refresh_tokens WHERE token_hash')) return this.refreshTokens.filter(x => x.token_hash === a[0]);
    if (s.startsWith('SELECT id, device, ip, created_at, last_used_at, expires_at FROM cms_refresh_tokens')) return this.refreshTokens.filter(x => x.revoked === 0 && x.expires_at > a[0]).sort((x, y) => y.last_used_at.localeCompare(x.last_used_at));
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
    if (s.startsWith('INSERT INTO cms_backup_settings') || s.startsWith('INSERT INTO cms_backup_plugins') || s.startsWith('INSERT INTO cms_backup_users') || s.startsWith('INSERT INTO cms_backup_votes')) return [];
    if (s === 'SELECT COUNT(*) AS n FROM cms_posts') return [{ n: this.posts.length }];
    if (s.startsWith('SELECT value FROM cms_settings')) return this.settings.has(a[0]) ? [{ value: this.settings.get(a[0]) }] : [];
    if (s.startsWith('SELECT * FROM cms_settings ORDER')) return [...this.settings.entries()].map(([key, value]) => ({ key, value })).sort((x, y) => x.key.localeCompare(y.key));
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
    if (s.startsWith('UPDATE cms_posts SET title')) { const pp = this.posts.find(x => x.id === a[9]); if (pp) { pp.title=a[0]; pp.body=a[1]; pp.category=a[2]; pp.updated_at=a[3]; pp.body_mode=a[4]; pp.visibility=a[5]; pp.publish_at=a[6]; pp.post_password_hash=a[7]; pp.post_password_salt=a[8]; } return []; }
    if (s.startsWith('SELECT * FROM cms_posts WHERE category')) {
      if (s.includes("visibility = 'public'")) return [...this.posts].filter(p => p.category === a[0] && p.status === 'published' && p.visibility === 'public' && String(p.publish_at || p.created_at) <= a[1]).sort((x, y) => String(y.publish_at || y.created_at).localeCompare(String(x.publish_at || x.created_at)));
      return [...this.posts].filter(p => p.category === a[0] && p.status === 'published').sort((x, y) => y.created_at.localeCompare(x.created_at));
    }
    if (s.startsWith('SELECT * FROM cms_posts ORDER')) return [...this.posts].sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('SELECT id FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ id: p.id }));
    if (s.startsWith('SELECT * FROM cms_comments WHERE post_id')) return this.comments.filter(c => c.post_id === a[0] && c.status === 'approved').sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('SELECT * FROM cms_comments ORDER')) return [...this.comments].sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('INSERT INTO cms_view_events')) { this.viewEvents.push({ post_id: a[0], viewed_at: a[1] }); return []; }
    if (s.startsWith('SELECT post_id, viewed_at FROM cms_view_events')) return [...this.viewEvents].sort((x, y) => y.viewed_at.localeCompare(x.viewed_at));
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
assert(t.includes('id="copyr"') && t.includes('id="uptime"') && t.includes('2024-01-01'), 'beranda: footer copyright + uptime dipertahankan');

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
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(t.includes('👍 1'), 'like terhitung');
r = await call('POST', '/post/post-uji/comment/vote', { csrf: userCsrf, comment_id: String(commentId), vote: '1' }, userCookie);
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(!t.includes('👍 1'), 'like kedua kalinya membatalkan');
r = await call('POST', '/post/post-uji/comment/vote', { csrf: userCsrf, comment_id: String(commentId), vote: '-1' }, userCookie);
r = await call('GET', '/post/post-uji'); t = await r.text(); assert(t.includes('👎 1'), 'dislike terhitung');
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
r = await call('GET', '/post/post-uji', null, cookie); t = await r.text();
assert(t.includes('***') && !t.includes('Halo anjing'), 'filter kata kotor: tampil *** bukan kata asli');
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
console.log('Selesai, exitCode=' + (process.exitCode || 0));
