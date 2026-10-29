// CMS Hozin — Worker Cloudflare (satu Worker, D1, tanpa build step selain esbuild untuk deploy).
// Fitur v1: post (buat/edit/hapus dari admin), komentar (moderasi: pending -> admin setujui),
// tema (Terang/Gelap, ganti dari admin), plugin (aktif/nonaktif dari admin, lihat plugins.js).
// KEAMANAN SUPER-SUPER-ADMIN (perintah pemilik 29 Okt 2026):
// - HANYA SATU admin: pemilik dengan ADMIN_TOKEN. TIDAK ADA akun editor, penulis, atau
//   pendaftar publik. TIDAK ADA endpoint publik untuk membuat post — post hanya lewat
//   POST /admin/* dengan sesi admin + token CSRF. Pengunjung hanya bisa kirim komentar,
//   dan komentar itu pun pending sampai admin setujui.
// - Login di-rate-limit: 5x gagal dari satu IP dalam 15 menit -> diblokir sementara (429).
// - Semua aksi admin POST wajib membawa token CSRF yang terikat sesi (HMAC).
// - Backup: database stopwatch khusus jadi tempat backup CMS (bukan database
//   live kedua). Panel admin super-super-admin punya tombol "Buat Backup
//   Sekarang" + riwayat backup (berhasil/gagal, jumlah baris, pesan error).
//   Backup menyalin post, komentar, pengaturan, dan plugin dari DB utama
//   ke tabel cms_backup_* di stopwatch. Satu-satunya sumber kebenaran tetap
//   DB utama; salinan di stopwatch tidak pernah ditulis dari admin.
// Admin: login pakai ADMIN_TOKEN (secret di Worker, BUKAN di kode ini, buat acak >=32 karakter,
//   jangan dibagikan, ganti segera bila bocor) -> cookie sesi HMAC 7 hari (HttpOnly, Secure, SameSite=Lax).
// Deploy: esbuild worker.js --bundle --format=esm, upload dengan binding D1 bernama DB + secret ADMIN_TOKEN.
// Catatan deploy root: Worker ini MENGGANTIKAN isi root bila di-route ke hozinking.my.id.
// Situs Tools yang sekarang ada di root harus dipindah ke subdomain dulu bila root mau jadi CMS ini.
import { themes } from './themes.js';
import { pluginDefs } from './plugins.js';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
let schemaReady = null;

function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function para(text) {
  return esc(text).split(/\n\s*\n/).map(p => `<p>${p.replaceAll('\n', '<br>')}</p>`).join('');
}
function slugify(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'post';
}
function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    ...headers,
  } });
}
function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const cookie = parseCookies(request).cms_session || '';
  const [exp, sig] = cookie.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmacHex(env.ADMIN_TOKEN, exp);
}
function sessionExp(request) {
  const cookie = parseCookies(request).cms_session || '';
  const [exp] = cookie.split('.');
  return exp || '';
}
async function csrfToken(env, exp) {
  return env.ADMIN_TOKEN ? await hmacHex(env.ADMIN_TOKEN, 'csrf:' + exp) : '';
}
function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}
async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      // DDL dijalankan satu per satu, BUKAN batch: D1 batch menolak/menggagalkan
      // CREATE TABLE di beberapa kasus, dan itu membuat Worker melempar 1101
      // di setiap request. DML (INSERT/DELETE) tetap boleh batch.
      const ddl = [
        `CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`,
      ];
      for (const sql of ddl) await env.DB.prepare(sql).run();
      // Migrasi pertahanan: CREATE IF NOT EXISTS tidak memperbaiki tabel yang
      // sudah ada tapi kolomnya tidak lengkap (insiden nyata 29 Okt 2026:
      // cms_posts di cms-db hanya punya id/slug/title, sehingga query
      // WHERE status melempar SQLITE_ERROR dan Worker 1101 di semua request).
      // Bila kolom hilang, tambahkan lewat ALTER TABLE, jangan DROP (data aman).
      const info = await env.DB.prepare(`PRAGMA table_info(cms_posts)`).all();
      const have = new Set((info.results || []).map(r => r.name));
      const missing = {
        body: `ALTER TABLE cms_posts ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
        category: `ALTER TABLE cms_posts ADD COLUMN category TEXT NOT NULL DEFAULT 'Umum'`,
        status: `ALTER TABLE cms_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'`,
        created_at: `ALTER TABLE cms_posts ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`,
        updated_at: `ALTER TABLE cms_posts ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`,
      };
      for (const [col, sql] of Object.entries(missing)) {
        if (!have.has(col)) await env.DB.prepare(sql).run();
      }
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('site_title', 'Hozin King')`).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('theme', 'terang')`).run();
      for (const p of pluginDefs) {
        await env.DB.prepare(`INSERT OR IGNORE INTO cms_plugins (id, enabled) VALUES (?, 1)`).bind(p.id).run();
      }
      const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_posts`).first();
      if (existing && Number(existing.n) === 0) {
        const now = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`).bind('p-welcome', 'selamat-datang', 'Selamat Datang di CMS Hozin', 'Ini post pertama. Dari panel admin, kamu bisa menambah post baru, menyetujui komentar, mengganti tema, dan mengaktifkan plugin.', 'Umum', now, now).run();
      }
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare(`SELECT value FROM cms_settings WHERE key = ?`).bind(key).first();
  return row ? row.value : fallback;
}
async function getEnabledPlugins(env) {
  const rows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
  const map = new Map((rows.results || []).map(r => [r.id, Number(r.enabled) === 1]));
  return pluginDefs.filter(p => map.get(p.id) !== false);
}
// Backup CMS ke stopwatch (binding BACKUP_DB). Mengembalikan {posts, comments}.
// Salinan = snapshot penuh terbaru: tabel backup dihapus dulu, lalu diisi ulang
// dari DB utama. Bukan tulis ganda live: fungsi ini hanya jalan saat admin
// menekan tombol backup, dan salinan tidak pernah ditulis dari jalur lain.
async function doBackup(env) {
  if (!env.BACKUP_DB) throw new Error('Binding BACKUP_DB belum dipasang di Worker');
  const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at ASC`).all();
  const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at ASC`).all();
  const settings = await env.DB.prepare(`SELECT * FROM cms_settings ORDER BY key ASC`).all();
  const plugins = await env.DB.prepare(`SELECT * FROM cms_plugins ORDER BY id ASC`).all();
  const now = new Date().toISOString();
  const bak = env.BACKUP_DB;
  // DDL satu per satu, alasan sama seperti ensureSchema (batch DDL rawan 1101).
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS cms_backup_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_comments (id INTEGER PRIMARY KEY, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL)`,
  ]) await bak.prepare(sql).run();
  const stmts = [
    bak.prepare(`DELETE FROM cms_backup_posts`),
    bak.prepare(`DELETE FROM cms_backup_comments`),
    bak.prepare(`DELETE FROM cms_backup_settings`),
    bak.prepare(`DELETE FROM cms_backup_plugins`),
  ];
  for (const p of (posts.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_posts (id, slug, title, body, category, status, created_at, updated_at, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.id, p.slug, p.title, p.body, p.category, p.status, p.created_at, p.updated_at, now));
  }
  for (const c of (comments.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_comments (id, post_id, name, text, status, created_at, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.post_id, c.name, c.text, c.status, c.created_at, now));
  }
  for (const s of (settings.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_settings (key, value, backup_at) VALUES (?, ?, ?)`).bind(s.key, s.value, now));
  }
  for (const p of (plugins.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_plugins (id, enabled, backup_at) VALUES (?, ?, ?)`).bind(p.id, p.enabled, now));
  }
  await bak.batch(stmts);
  return { posts: (posts.results || []).length, comments: (comments.results || []).length };
}
async function renderPage(env, pageTitle, content) {
  const siteTitle = await getSetting(env, 'site_title', 'Hozin King');
  const themeId = await getSetting(env, 'theme', 'terang');
  const theme = themes[themeId] || themes.terang;
  return theme.render({ siteTitle: esc(siteTitle), pageTitle: esc(pageTitle), content });
}
function postCard(post, plugins) {
  const meta = plugins.map(p => p.postMeta ? p.postMeta(post) : '').join('');
  return `<article class="card"><h2><a href="/p/${esc(post.slug)}">${esc(post.title)}</a></h2><p class="meta">${esc(post.category)} · ${esc(post.created_at.slice(0, 10))}${meta}</p><p>${esc(String(post.body).slice(0, 200))}${String(post.body).length > 200 ? '…' : ''}</p></article>`;
}

export default {
  // Fallback anti-1101 (insiden 29 Okt 2026 20:28 WIB): bila D1 tidak bisa
  // diakses — mis. kuota baca harian gratis habis — JANGAN lempar exception
  // (Cloudflare mengubahnya jadi Error 1101 di semua halaman). Beranda tampil
  // statis, jalur lain dapat halaman 503 yang jelas. Begitu D1 bisa diakses
  // lagi (kuota reset tengah malam UTC = 07:00 WIB), semua kembali normal
  // tanpa redeploy, karena schemaReady di-reset saat gagal. Data tidak hilang:
  // ini hanya gagal baca, bukan gagal tulis.
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (e) {
      const theme = themes.terang;
      const u = new URL(request.url);
      if (request.method === 'GET' && u.pathname === '/') {
        const content = `<article class="card"><h2>Selamat Datang di CMS Hozin</h2><p class="meta">Umum</p><p>Ini post pertama. Dari panel admin, kamu bisa menambah post baru, menyetujui komentar, mengganti tema, dan mengaktifkan plugin.</p></article><div class="card"><p>Database sedang tidak bisa diakses sementara (batas harian D1 tercapai). Post, komentar, dan panel admin kembali normal setelah kuota reset pukul 07:00 WIB.</p></div>`;
        return html(theme.render({ siteTitle: 'Hozin King', pageTitle: 'Beranda', content }));
      }
      return html(theme.render({ siteTitle: 'Hozin King', pageTitle: 'Sementara tidak tersedia', content: '<div class="card"><p>Layanan database sementara tidak tersedia (batas harian D1 tercapai). Coba lagi setelah kuota reset pukul 07:00 WIB. Data tidak hilang.</p></div>' }), 503);
    }
  },
};

async function handleFetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    await ensureSchema(env);
    const admin = await isAdmin(request, env);

    // ---- Publik: beranda ----
    if (request.method === 'GET' && path === '/') {
      const rows = await env.DB.prepare(`SELECT * FROM cms_posts WHERE status = 'published' ORDER BY created_at DESC`).all();
      const plugins = await getEnabledPlugins(env);
      const posts = rows.results || [];
      const content = posts.length
        ? posts.map(p => postCard(p, plugins)).join('')
        : '<div class="card"><p>Belum ada post.</p></div>';
      return html(await renderPage(env, 'Beranda', content));
    }

    // ---- Publik: detail post + komentar ----
    const postMatch = path.match(/^\/p\/([A-Za-z0-9-]+)(?:\/comment)?$/);
    if (postMatch) {
      const slug = postMatch[1];
      if (request.method === 'GET') {
        const post = await env.DB.prepare(`SELECT * FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (!post || post.status !== 'published') return html(await renderPage(env, 'Tidak ditemukan', '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
        const plugins = await getEnabledPlugins(env);
        const comments = await env.DB.prepare(`SELECT * FROM cms_comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC`).bind(post.id).all();
        const rel = await env.DB.prepare(`SELECT * FROM cms_posts WHERE category = ? AND status = 'published' ORDER BY created_at DESC`).bind(post.category).all();
        const meta = plugins.map(p => p.postMeta ? p.postMeta(post) : '').join('');
        const footers = plugins.map(p => p.postFooter ? p.postFooter(post, { related: rel.results || [], baseUrl: url.origin }) : '').join('');
        const notice = url.searchParams.get('komentar') === 'menunggu' ? '<div class="card"><p>Komentar dikirim, menunggu persetujuan admin.</p></div>' : '';
        const commentHtml = (comments.results || []).map(c => `<div class="card"><p><b>${esc(c.name)}</b></p><p>${esc(c.text)}</p></div>`).join('') || '<p>Belum ada komentar.</p>';
        const content = `<article class="card"><h2>${esc(post.title)}</h2><p class="meta">${esc(post.category)} · ${esc(post.created_at.slice(0, 10))}${meta}</p>${para(post.body)}</article>${footers}<h3>Komentar</h3>${commentHtml}${notice}<form method="post" action="/p/${esc(slug)}/comment"><label>Nama</label><input name="name" maxlength="80" required><label>Komentar</label><textarea name="text" maxlength="2000" required></textarea><button type="submit">Kirim Komentar</button></form>`;
        return html(await renderPage(env, post.title, content));
      }
      if (request.method === 'POST' && path.endsWith('/comment')) {
        const post = await env.DB.prepare(`SELECT * FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (!post) return redirect('/');
        const form = await request.formData();
        const name = String(form.get('name') || '').trim().slice(0, 80);
        const text = String(form.get('text') || '').trim().slice(0, 2000);
        if (name && text) {
          await env.DB.prepare(`INSERT INTO cms_comments (post_id, name, text, status, created_at) VALUES (?, ?, ?, 'pending', ?)`).bind(post.id, name, text, new Date().toISOString()).run();
        }
        return redirect(`/p/${slug}?komentar=menunggu`);
      }
    }

    // ---- Admin: login (rate-limit 5 gagal / IP / 15 menit) ----
    if (path === '/admin/login' && request.method === 'POST') {
      const form = await request.formData();
      const ip = clientIp(request);
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const fails = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_login_attempts WHERE ip = ? AND created_at > ?`).bind(ip, since).first();
      if (fails && Number(fails.n) >= 5) {
        return html(await renderPage(env, 'Admin', '<div class="card"><p>Terlalu banyak percobaan login. Coba lagi 15 menit.</p></div>'), 429);
      }
      if (env.ADMIN_TOKEN && String(form.get('password') || '') === env.ADMIN_TOKEN) {
        await env.DB.prepare(`DELETE FROM cms_login_attempts WHERE ip = ?`).bind(ip).run();
        const exp = String(Date.now() + SESSION_TTL_MS);
        const sig = await hmacHex(env.ADMIN_TOKEN, exp);
        return redirect('/admin', { 'set-cookie': `cms_session=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` });
      }
      await env.DB.prepare(`INSERT INTO cms_login_attempts (ip, created_at) VALUES (?, ?)`).bind(ip, new Date().toISOString()).run();
      return html(await renderPage(env, 'Admin', '<div class="card"><p>Password salah.</p><p><a href="/admin">Kembali</a></p></div>'), 403);
    }
    if (path === '/admin/logout' && request.method === 'POST') {
      if (!admin) return redirect('/admin');
      const form = await request.formData();
      if (String(form.get('csrf') || '') !== await csrfToken(env, sessionExp(request))) {
        return html(await renderPage(env, 'Admin', '<div class="card"><p>Token CSRF tidak valid.</p></div>'), 403);
      }
      return redirect('/admin', { 'set-cookie': 'cms_session=; Path=/; HttpOnly; Secure; Max-Age=0' });
    }

    // ---- Admin: dashboard (butuh login) ----
    if (path === '/admin') {
      if (request.method === 'GET') {
        if (!admin) {
          return html(await renderPage(env, 'Admin', '<div class="card"><h2>Login Admin</h2><form method="post" action="/admin/login"><label>Password admin</label><input type="password" name="password" required><button type="submit">Masuk</button></form></div>'));
        }
        const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at DESC`).all();
        const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at DESC`).all();
        const themeId = await getSetting(env, 'theme', 'terang');
        const siteTitle = await getSetting(env, 'site_title', 'Hozin King');
        const pluginRows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
        const pMap = new Map((pluginRows.results || []).map(r => [r.id, Number(r.enabled)]));
        const csrf = await csrfToken(env, sessionExp(request));
        const csrfField = `<input type="hidden" name="csrf" value="${csrf}">`;
        const postRows = (posts.results || []).map(p => `<div class="card"><b>${esc(p.title)}</b> (${esc(p.status)})<form method="post" action="/admin/posts/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(p.id)}"><button type="submit">Hapus</button></form></div>`).join('');
        const commentRows = (comments.results || []).map(c => `<div class="card"><b>${esc(c.name)}</b> [${esc(c.status)}]<p>${esc(c.text)}</p><form method="post" action="/admin/comments/approve" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Setujui</button></form> <form method="post" action="/admin/comments/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Hapus</button></form></div>`).join('');
        const themeOptions = Object.entries(themes).map(([id, t]) => `<option value="${id}" ${id === themeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
        const pluginForms = pluginDefs.map(p => `<div class="card"><b>${esc(p.name)}</b> — ${esc(p.description)}<form method="post" action="/admin/plugins/toggle">${csrfField}<input type="hidden" name="id" value="${p.id}"><input type="hidden" name="enabled" value="${pMap.get(p.id) === 0 ? '1' : '0'}"><button type="submit">${pMap.get(p.id) === 0 ? 'Aktifkan' : 'Nonaktifkan'}</button></form></div>`).join('');
        const backupRuns = await env.DB.prepare(`SELECT * FROM cms_backup_runs ORDER BY created_at DESC LIMIT 10`).all();
        const backupRows = (backupRuns.results || []).map(r => `<div class="card"><b>${esc(r.status)}</b> · ${esc(r.created_at)} · ${r.posts} post, ${r.comments} komentar${r.error ? `<p>Error: ${esc(r.error)}</p>` : ''}</div>`).join('') || '<p>Belum ada backup.</p>';
        const backupCard = `<div class="card"><h3>Backup ke Stopwatch</h3><p>Database stopwatch khusus dipakai sebagai tempat backup CMS. Salinan tidak pernah ditulis dari jalur lain — hanya tombol ini yang menulis ke sana.</p><form method="post" action="/admin/backup">${csrfField}<button type="submit">Buat Backup Sekarang</button></form><h4>Riwayat Backup</h4>${backupRows}</div>`;
        const content = `<h2>Dashboard Admin</h2><p>Peran: <b>Super-Super-Admin (satu-satunya)</b> — tidak ada akun admin lain, tidak ada pendaftar publik.</p><form method="post" action="/admin/logout">${csrfField}<button type="submit">Keluar</button></form>${backupCard}<div class="card"><h3>Pengaturan</h3><form method="post" action="/admin/settings">${csrfField}<label>Judul situs</label><input name="site_title" value="${esc(siteTitle)}"><label>Tema</label><select name="theme">${themeOptions}</select><button type="submit">Simpan Pengaturan</button></form></div><div class="card"><h3>Post Baru</h3><form method="post" action="/admin/posts">${csrfField}<label>Judul</label><input name="title" required><label>Kategori</label><input name="category" value="Umum"><label>Isi</label><textarea name="body" required></textarea><button type="submit">Terbitkan</button></form></div><h3>Post</h3>${postRows}<h3>Komentar</h3>${commentRows}<h3>Plugin</h3>${pluginForms}`;
        return html(await renderPage(env, 'Admin', content));
      }
    }

    // ---- Admin: aksi (butuh login + CSRF) ----
    if (admin && request.method === 'POST') {
      const form = await request.formData();
      if (String(form.get('csrf') || '') !== await csrfToken(env, sessionExp(request))) {
        return html(await renderPage(env, 'Admin', '<div class="card"><p>Token CSRF tidak valid. Muat ulang dashboard lalu coba lagi.</p></div>'), 403);
      }
      if (path === '/admin/backup') {
        const now = new Date().toISOString();
        try {
          const counts = await doBackup(env);
          await env.DB.prepare(`INSERT INTO cms_backup_runs (created_at, status, posts, comments, error) VALUES (?, 'BERHASIL', ?, ?, '')`).bind(now, counts.posts, counts.comments).run();
        } catch (e) {
          await env.DB.prepare(`INSERT INTO cms_backup_runs (created_at, status, posts, comments, error) VALUES (?, 'GAGAL', 0, 0, ?)`).bind(now, String(e && e.message ? e.message : e).slice(0, 300)).run();
        }
        return redirect('/admin');
      }
      if (path === '/admin/settings') {
        const siteTitle = String(form.get('site_title') || '').trim().slice(0, 100) || 'Hozin King';
        const theme = String(form.get('theme') || 'terang');
        if (themes[theme]) {
          await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('site_title', ?)`).bind(siteTitle).run();
          await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('theme', ?)`).bind(theme).run();
        }
        return redirect('/admin');
      }
      if (path === '/admin/posts') {
        const title = String(form.get('title') || '').trim();
        const body = String(form.get('body') || '').trim();
        const category = String(form.get('category') || 'Umum').trim().slice(0, 80) || 'Umum';
        if (title && body) {
          const now = new Date().toISOString();
          const id = 'p-' + Date.now().toString(36);
          let slug = slugify(title);
          const clash = await env.DB.prepare(`SELECT id FROM cms_posts WHERE slug = ?`).bind(slug).first();
          if (clash) slug = slug + '-' + Date.now().toString(36).slice(-4);
          await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`).bind(id, slug, title, body, category, now, now).run();
        }
        return redirect('/admin');
      }
      if (path === '/admin/posts/delete') {
        await env.DB.prepare(`DELETE FROM cms_posts WHERE id = ?`).bind(String(form.get('id') || '')).run();
        return redirect('/admin');
      }
      if (path === '/admin/comments/approve') {
        await env.DB.prepare(`UPDATE cms_comments SET status = 'approved' WHERE id = ?`).bind(Number(form.get('id'))).run();
        return redirect('/admin');
      }
      if (path === '/admin/comments/delete') {
        await env.DB.prepare(`DELETE FROM cms_comments WHERE id = ?`).bind(Number(form.get('id'))).run();
        return redirect('/admin');
      }
      if (path === '/admin/plugins/toggle') {
        const id = String(form.get('id') || '');
        if (pluginDefs.some(p => p.id === id)) {
          await env.DB.prepare(`UPDATE cms_plugins SET enabled = ? WHERE id = ?`).bind(Number(form.get('enabled')) ? 1 : 0, id).run();
        }
        return redirect('/admin');
      }
    }
    if (path.startsWith('/admin')) {
      return html(await renderPage(env, 'Admin', '<div class="card"><p>Butuh login admin.</p><p><a href="/admin">Ke login</a></p></div>'), 403);
    }
    return html(await renderPage(env, 'Tidak ditemukan', '<div class="card"><p>Halaman tidak ditemukan.</p></div>'), 404);
}
