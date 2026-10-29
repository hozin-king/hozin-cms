// Uji CMS Hozin tanpa Cloudflare: mock D1 sederhana untuk pola SQL yang dipakai worker.js.
// Jalankan: node test.mjs  (harus keluar semua OK (kini 18+ cek, termasuk CSRF & rate-limit))
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
    this.posts = []; this.comments = []; this.settings = new Map(); this.plugins = new Map(); this.commentSeq = 0; this.attempts = []; this.backupRuns = []; this.refreshTokens = [];
  }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(stmts) { for (const s of stmts) await s.run(); }
  exec(sql, a, mode) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return [];
    if (s.startsWith('PRAGMA table_info(cms_posts)')) return [{ name: 'id' }, { name: 'slug' }, { name: 'title' }, { name: 'body' }, { name: 'category' }, { name: 'status' }, { name: 'created_at' }, { name: 'updated_at' }];
    if (s.startsWith('ALTER TABLE cms_posts')) return [];
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
    if (s.startsWith('INSERT INTO cms_posts')) { this.posts.push({ id: a[0], slug: a[1], title: a[2], body: a[3], category: a[4], status: 'published', created_at: a[5], updated_at: a[6] }); return []; }
    if (s.startsWith('INSERT INTO cms_comments')) { this.comments.push({ id: ++this.commentSeq, post_id: a[0], name: a[1], text: a[2], status: 'pending', created_at: a[3] }); return []; }
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
    if (s.startsWith('INSERT INTO cms_backup_settings') || s.startsWith('INSERT INTO cms_backup_plugins')) return [];
    if (s === 'SELECT COUNT(*) AS n FROM cms_posts') return [{ n: this.posts.length }];
    if (s.startsWith('SELECT value FROM cms_settings')) return this.settings.has(a[0]) ? [{ value: this.settings.get(a[0]) }] : [];
    if (s.startsWith('SELECT * FROM cms_settings ORDER')) return [...this.settings.entries()].map(([key, value]) => ({ key, value })).sort((x, y) => x.key.localeCompare(y.key));
    if (s.startsWith('SELECT * FROM cms_plugins ORDER')) return [...this.plugins.entries()].map(([id, enabled]) => ({ id, enabled })).sort((x, y) => x.id.localeCompare(y.id));
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
assert(t.includes('Selamat Datang di CMS Hozin'), 'beranda: post sambutan tampil');
assert(t.includes('menit baca'), 'beranda: plugin waktu baca aktif');
assert(t.includes('id="copyr"') && t.includes('id="uptime"') && t.includes('2024-01-01'), 'beranda: footer copyright + uptime dipertahankan');

// 2. Login admin (salah -> 403, benar -> token akses + refresh)
function cookiesOf(res) { const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [(res.headers.get('set-cookie') || '')]; return list.map(c => c.split(';')[0]).filter(Boolean); }
function cookieHeader(list) { return list.join('; '); }
r = await call('POST', '/admin/login', { password: 'salah' }); assert(r.status === 403, 'login salah ditolak');
r = await call('POST', '/admin/login', { password: 'test-admin-token', remember: '1' });
let cookie = cookieHeader(cookiesOf(r));
assert(cookie.includes('cms_access=') && cookie.includes('cms_refresh='), 'login benar memberi token akses + refresh');
assert(env.DB.refreshTokens.length === 1 && env.DB.refreshTokens[0].remember === 1, 'login ingat saya menyimpan refresh 30 hari');
// Ambil token CSRF dari dashboard admin, semua aksi admin wajib pakai token ini
r = await call('GET', '/admin', null, cookie); t = await r.text();
const csrf = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
assert(csrf.length > 10, 'dashboard memberi token CSRF');
assert(t.includes('Super-Super-Admin'), 'dashboard menandai peran super-super-admin');
// Aksi admin tanpa CSRF harus ditolak
r = await call('POST', '/admin/posts', { title: 'Post Jahat', category: 'X', body: 'x' }, cookie); assert(r.status === 403, 'aksi admin tanpa CSRF ditolak');
// Rate-limit login: 5x salah -> percobaan ke-6 diblokir 429
for (let i = 0; i < 5; i++) await call('POST', '/admin/login', { password: 'salah' });
r = await call('POST', '/admin/login', { password: 'salah' }); assert(r.status === 429, 'login ke-6 setelah 5 gagal diblokir 429');

// 3. Admin buat post baru
r = await call('POST', '/admin/posts', { csrf, title: 'Post Uji', category: 'Tekno', body: 'Isi post uji kedua.' }, cookie);
assert(r.status === 303, 'admin buat post redirect');
r = await call('GET', '/'); t = await r.text(); assert(t.includes('Post Uji'), 'post baru tampil di beranda');

// 4. Komentar: kirim -> pending (tidak tampil), admin setujui -> tampil
r = await call('POST', '/p/post-uji/comment', { name: 'Budi', text: 'Komentar uji' }); assert(r.status === 303, 'kirim komentar redirect');
r = await call('GET', '/p/post-uji'); t = await r.text(); assert(!t.includes('Komentar uji'), 'komentar pending belum tampil');
const commentId = env.DB.comments[0].id;
r = await call('POST', '/admin/comments/approve', { csrf, id: String(commentId) }, cookie); assert(r.status === 303, 'admin setujui komentar');
r = await call('GET', '/p/post-uji'); t = await r.text(); assert(t.includes('Komentar uji'), 'komentar disetujui tampil');

// 5. Ganti tema ke gelap + nonaktifkan plugin share, cek halaman berubah
r = await call('POST', '/admin/settings', { csrf, site_title: 'Hozin King', theme: 'gelap' }, cookie);
r = await call('GET', '/'); t = await r.text(); assert(t.includes('#05070d'), 'tema gelap terpakai (identitas situs lama, bukan slate generik)');
r = await call('POST', '/admin/plugins/toggle', { csrf, id: 'share', enabled: '0' }, cookie);
r = await call('GET', '/p/post-uji'); t = await r.text(); assert(!t.includes('Bagikan:'), 'plugin share nonaktif hilang dari post');

// 6. XSS: komentar berisi tag script harus di-escape, bukan dieksekusi
await call('POST', '/p/post-uji/comment', { name: 'X', text: '<script>alert(1)</script>' });
const cid2 = env.DB.comments[env.DB.comments.length - 1].id;
await call('POST', '/admin/comments/approve', { csrf, id: String(cid2) }, cookie);
r = await call('GET', '/p/post-uji'); t = await r.text();
assert(!t.includes('<script>alert(1)</script>') && t.includes('&lt;script&gt;'), 'komentar jahat di-escape');

// 7. Backup ke stopwatch: tombol admin -> salinan di BACKUP_DB + riwayat BERHASIL tampil
r = await call('POST', '/admin/backup', { csrf }, cookie); assert(r.status === 303, 'tombol backup redirect');
r = await call('GET', '/admin', null, cookie); t = await r.text();
assert(t.includes('Backup ke Stopwatch') && t.includes('BERHASIL'), 'riwayat backup BERHASIL tampil di dashboard');
assert(env.BACKUP_DB.backupPosts >= 2, 'backup menyalin post ke stopwatch');
// Backup tanpa BACKUP_DB -> dicatat GAGAL, bukan crash
const savedBak = env.BACKUP_DB; delete env.BACKUP_DB;
r = await call('POST', '/admin/backup', { csrf }, cookie); assert(r.status === 303, 'backup gagal tetap redirect');
r = await call('GET', '/admin', null, cookie); t = await r.text();
assert(t.includes('GAGAL'), 'riwayat backup GAGAL tampil di dashboard');
env.BACKUP_DB = savedBak;

// 8. Sistem token: refresh memutar, pakai ulang mencabut semua, logout-all
// Catatan desain (sama seperti di video): token akses stateless tetap sah
// sampai kedaluwarsa (maks 1 jam) meski refresh dicabut; yang dicabut
// seketika adalah kemampuan memperpanjang sesi. Jadi cek pasca-logout
// memakai cookie refresh saja, bukan akses yang masih hidup.
const refreshOnly = cookie.split('; ').find(c => c.startsWith('cms_refresh='));
r = await call('GET', '/admin', null, refreshOnly); t = await r.text();
assert(t.includes('Dashboard Admin'), 'refresh saja bisa masuk dashboard (akses diperpanjang otomatis)');
assert(cookiesOf(r).some(c => c.startsWith('cms_access=')), 'refresh memutar memberi token akses baru');
assert(env.DB.refreshTokens.some(x => x.revoked === 1 && x.replaced_by), 'refresh lama dicabut + ditandai pengganti');
// Pakai ulang refresh lama -> tanda pencurian -> semua sesi dicabut
r = await call('GET', '/admin', null, refreshOnly); t = await r.text();
assert(!t.includes('Dashboard Admin') && t.includes('Login Admin'), 'refresh lama yang dipakai ulang ditolak');
assert(env.DB.refreshTokens.every(x => x.revoked === 1), 'pakai ulang refresh mencabut semua sesi');
// Login ulang + daftar sesi + logout-all
// (Simulasi lewat 15 menit: rate-limit dari tes sebelumnya harus sudah lewat.)
env.DB.attempts = [];
r = await call('POST', '/admin/login', { password: 'test-admin-token' });
cookie = cookieHeader(cookiesOf(r));
const refreshOnly2 = cookie.split('; ').find(c => c.startsWith('cms_refresh='));
r = await call('GET', '/admin', null, cookie); t = await r.text();
assert(t.includes('Sesi & Perangkat'), 'dashboard menampilkan daftar sesi & perangkat');
const csrf2 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
r = await call('POST', '/admin/logout-all', { csrf: csrf2 }, cookie); assert(r.status === 303, 'logout semua perangkat redirect');
assert(env.DB.refreshTokens.every(x => x.revoked === 1), 'logout semua mencabut semua refresh');
r = await call('GET', '/admin', null, refreshOnly2); t = await r.text();
assert(!t.includes('Dashboard Admin'), 'setelah logout semua, refresh lama tidak bisa memperpanjang sesi');
// Logout satu perangkat
r = await call('POST', '/admin/login', { password: 'test-admin-token' });
cookie = cookieHeader(cookiesOf(r));
const refreshOnly3 = cookie.split('; ').find(c => c.startsWith('cms_refresh='));
r = await call('GET', '/admin', null, cookie); t = await r.text();
const csrf3 = (t.match(/name="csrf" value="([^"]+)"/) || [])[1] || '';
r = await call('POST', '/admin/logout', { csrf: csrf3 }, cookie); assert(r.status === 303, 'logout satu perangkat redirect');
r = await call('GET', '/admin', null, refreshOnly3); t = await r.text();
assert(!t.includes('Dashboard Admin'), 'setelah logout, refresh perangkat itu tidak bisa memperpanjang sesi');
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
assert(r.status === 503 && t.includes('Under Maintenance') && t.includes('currently under maintenance') && !t.includes('Selamat Datang di CMS Hozin') && !t.includes('D1') && !t.includes('kuota'), 'failsafe beranda: halaman pemeliharaan Inggris, tanpa detail teknis');
r = await callDown('GET', '/admin'); t = await r.text();
assert(r.status === 503 && t.includes('Under Maintenance') && !t.includes('D1') && !t.includes('kuota') && !t.includes('pukul 07:00'), 'failsafe admin: halaman pemeliharaan Inggris, tanpa detail teknis');
r = await callDown('GET', '/p/post-uji'); t = await r.text();
assert(r.status === 503 && t.includes('Under Maintenance') && !t.includes('D1'), 'failsafe halaman lain: halaman pemeliharaan Inggris, tanpa detail teknis');
console.log('Selesai, exitCode=' + (process.exitCode || 0));
