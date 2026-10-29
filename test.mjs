// Uji CMS Hozin tanpa Cloudflare: mock D1 sederhana untuk pola SQL yang dipakai worker.js.
// Jalankan: node test.mjs  (harus keluar semua OK)
import worker from './worker.js';

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  async run() { return this.db.exec(this.sql, this.args, 'run'); }
  async all() { return { results: this.db.exec(this.sql, this.args, 'all') }; }
  async first() { const r = this.db.exec(this.sql, this.args, 'all'); return r[0] || null; }
}
class MockDB {
  constructor() {
    this.posts = []; this.comments = []; this.settings = new Map(); this.plugins = new Map(); this.commentSeq = 0;
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { for (const s of stmts) await s.run(); }
  exec(sql, a, mode) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return [];
    if (s.startsWith('INSERT OR IGNORE INTO cms_settings')) { if (!this.settings.has(a[0])) this.settings.set(a[0], a[1]); return []; }
    if (s.startsWith('INSERT OR REPLACE INTO cms_settings')) { this.settings.set(a[0], a[1]); return []; }
    if (s.startsWith('INSERT OR IGNORE INTO cms_plugins')) { if (!this.plugins.has(a[0])) this.plugins.set(a[0], 1); return []; }
    if (s.startsWith('INSERT INTO cms_posts')) { this.posts.push({ id: a[0], slug: a[1], title: a[2], body: a[3], category: a[4], status: 'published', created_at: a[5], updated_at: a[6] }); return []; }
    if (s.startsWith('INSERT INTO cms_comments')) { this.comments.push({ id: ++this.commentSeq, post_id: a[0], name: a[1], text: a[2], status: 'pending', created_at: a[3] }); return []; }
    if (s === 'SELECT COUNT(*) AS n FROM cms_posts') return [{ n: this.posts.length }];
    if (s.startsWith('SELECT value FROM cms_settings')) return this.settings.has(a[0]) ? [{ value: this.settings.get(a[0]) }] : [];
    if (s.startsWith('SELECT * FROM cms_plugins') || s.startsWith('SELECT id, enabled FROM cms_plugins')) return [...this.plugins.entries()].map(([id, enabled]) => ({ id, enabled }));
    if (s.startsWith('SELECT * FROM cms_posts WHERE status')) return [...this.posts].filter(p => p.status === 'published').sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('SELECT * FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]);
    if (s.startsWith('SELECT * FROM cms_posts WHERE category')) return [...this.posts].filter(p => p.category === a[0] && p.status === 'published').sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('SELECT * FROM cms_posts ORDER')) return [...this.posts].sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('SELECT id FROM cms_posts WHERE slug')) return this.posts.filter(p => p.slug === a[0]).map(p => ({ id: p.id }));
    if (s.startsWith('SELECT * FROM cms_comments WHERE post_id')) return this.comments.filter(c => c.post_id === a[0] && c.status === 'approved').sort((x, y) => x.created_at.localeCompare(y.created_at));
    if (s.startsWith('SELECT * FROM cms_comments ORDER')) return [...this.comments].sort((x, y) => y.created_at.localeCompare(x.created_at));
    if (s.startsWith('UPDATE cms_comments SET status')) { const c = this.comments.find(x => x.id === a[0]); if (c) c.status = 'approved'; return []; }
    if (s.startsWith('UPDATE cms_plugins SET enabled')) { this.plugins.set(a[1], a[0]); return []; }
    if (s.startsWith('DELETE FROM cms_posts')) { this.posts = this.posts.filter(p => p.id !== a[0]); return []; }
    if (s.startsWith('DELETE FROM cms_comments')) { this.comments = this.comments.filter(c => c.id !== a[0]); return []; }
    throw new Error('Mock SQL tidak dikenal: ' + s);
  }
}
const env = { DB: new MockDB(), ADMIN_TOKEN: 'test-admin-token' };
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
assert(t.includes('Selamat Datang di CMS Hozin'), 'beranda: post sambutan tampil');
assert(t.includes('menit baca'), 'beranda: plugin waktu baca aktif');

// 2. Login admin (salah -> 403, benar -> cookie sesi)
r = await call('POST', '/admin/login', { password: 'salah' }); assert(r.status === 403, 'login salah ditolak');
r = await call('POST', '/admin/login', { password: 'test-admin-token' });
const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
assert(cookie.startsWith('cms_session='), 'login benar memberi cookie sesi');

// 3. Admin buat post baru
r = await call('POST', '/admin/posts', { title: 'Post Uji', category: 'Tekno', body: 'Isi post uji kedua.' }, cookie);
assert(r.status === 303, 'admin buat post redirect');
r = await call('GET', '/'); t = await r.text(); assert(t.includes('Post Uji'), 'post baru tampil di beranda');

// 4. Komentar: kirim -> pending (tidak tampil), admin setujui -> tampil
r = await call('POST', '/p/post-uji/comment', { name: 'Budi', text: 'Komentar uji' }); assert(r.status === 303, 'kirim komentar redirect');
r = await call('GET', '/p/post-uji'); t = await r.text(); assert(!t.includes('Komentar uji'), 'komentar pending belum tampil');
const commentId = env.DB.comments[0].id;
r = await call('POST', '/admin/comments/approve', { id: String(commentId) }, cookie); assert(r.status === 303, 'admin setujui komentar');
r = await call('GET', '/p/post-uji'); t = await r.text(); assert(t.includes('Komentar uji'), 'komentar disetujui tampil');

// 5. Ganti tema ke gelap + nonaktifkan plugin share, cek halaman berubah
r = await call('POST', '/admin/settings', { site_title: 'Hozin King', theme: 'gelap' }, cookie);
r = await call('GET', '/'); t = await r.text(); assert(t.includes('#0f172a'), 'tema gelap terpakai');
r = await call('POST', '/admin/plugins/toggle', { id: 'share', enabled: '0' }, cookie);
r = await call('GET', '/p/post-uji'); t = await r.text(); assert(!t.includes('Bagikan:'), 'plugin share nonaktif hilang dari post');

// 6. XSS: komentar berisi tag script harus di-escape, bukan dieksekusi
await call('POST', '/p/post-uji/comment', { name: 'X', text: '<script>alert(1)</script>' });
const cid2 = env.DB.comments[env.DB.comments.length - 1].id;
await call('POST', '/admin/comments/approve', { id: String(cid2) }, cookie);
r = await call('GET', '/p/post-uji'); t = await r.text();
assert(!t.includes('<script>alert(1)</script>') && t.includes('&lt;script&gt;'), 'komentar jahat di-escape');
console.log('Selesai, exitCode=' + (process.exitCode || 0));
