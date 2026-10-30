// Store WorkerCMS — skema D1, pengaturan, plugin aktif, backup, dan render halaman.
import { themes } from './themes.js';
import { pluginDefs } from './plugins.js';
import { esc } from './util.js';

let schemaReady = null;

export async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      // DDL dijalankan satu per satu, BUKAN batch: D1 batch menolak/menggagalkan
      // CREATE TABLE di beberapa kasus, dan itu membuat Worker melempar 1101
      // di setiap request. DML (INSERT/DELETE) tetap boleh batch.
      const ddl = [
        `CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER, pinned INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS cms_refresh_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, device TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, replaced_by TEXT NOT NULL DEFAULT '', remember INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cms_users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_comment_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY (comment_id, user_key))`,
        `CREATE TABLE IF NOT EXISTS cms_view_events (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, viewed_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL)`,
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
        body_mode: `ALTER TABLE cms_posts ADD COLUMN body_mode TEXT NOT NULL DEFAULT 'text'`,
        visibility: `ALTER TABLE cms_posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
        publish_at: `ALTER TABLE cms_posts ADD COLUMN publish_at TEXT NOT NULL DEFAULT ''`,
        post_password_hash: `ALTER TABLE cms_posts ADD COLUMN post_password_hash TEXT NOT NULL DEFAULT ''`,
        post_password_salt: `ALTER TABLE cms_posts ADD COLUMN post_password_salt TEXT NOT NULL DEFAULT ''`,
        views: `ALTER TABLE cms_posts ADD COLUMN views INTEGER NOT NULL DEFAULT 0`,
      };
      for (const [col, sql] of Object.entries(missing)) {
        if (!have.has(col)) await env.DB.prepare(sql).run();
      }
      // Migrasi komentar: balasan butuh parent_id (NULL = komentar utama).
      const cInfo = await env.DB.prepare(`PRAGMA table_info(cms_comments)`).all();
      const cHave = new Set((cInfo.results || []).map(r => r.name));
      if (!cHave.has('parent_id')) await env.DB.prepare(`ALTER TABLE cms_comments ADD COLUMN parent_id INTEGER`).run();
      if (!cHave.has('pinned')) await env.DB.prepare(`ALTER TABLE cms_comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('site_title', 'WorkerCMS')`).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('theme', 'terang')`).run();
      for (const p of pluginDefs) {
        await env.DB.prepare(`INSERT OR IGNORE INTO cms_plugins (id, enabled) VALUES (?, 1)`).bind(p.id).run();
      }
      const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_posts`).first();
      if (existing && Number(existing.n) === 0) {
        const now = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, 'text', 'public', ?, '', '', 0)`).bind('p-welcome', 'selamat-datang', 'Selamat Datang di WorkerCMS', 'Ini post pertama. Dari panel admin, kamu bisa menambah post baru, menyetujui komentar, mengganti tema, dan mengaktifkan plugin.', 'Umum', now, now, now).run();
      }
    })().catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}
export async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare(`SELECT value FROM cms_settings WHERE key = ?`).bind(key).first();
  return row ? row.value : fallback;
}
export async function getEnabledPlugins(env) {
  const rows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
  const map = new Map((rows.results || []).map(r => [r.id, Number(r.enabled) === 1]));
  return pluginDefs.filter(p => map.get(p.id) !== false);
}

// Backup CMS ke stopwatch (binding BACKUP_DB). Mengembalikan {posts, comments}.
// Salinan = snapshot penuh terbaru: tabel backup dihapus dulu, lalu diisi ulang
// dari DB utama. Bukan tulis ganda live: fungsi ini hanya jalan saat admin
// menekan tombol backup, dan salinan tidak pernah ditulis dari jalur lain.
export async function doBackup(env) {
  if (!env.BACKUP_DB) throw new Error('Binding BACKUP_DB belum dipasang di Worker');
  const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at ASC`).all();
  const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at ASC`).all();
  const settings = await env.DB.prepare(`SELECT * FROM cms_settings ORDER BY key ASC`).all();
  const plugins = await env.DB.prepare(`SELECT * FROM cms_plugins ORDER BY id ASC`).all();
  const users = await env.DB.prepare(`SELECT * FROM cms_users ORDER BY created_at ASC`).all();
  const votes = await env.DB.prepare(`SELECT * FROM cms_comment_votes ORDER BY comment_id ASC`).all();
  const now = new Date().toISOString();
  const bak = env.BACKUP_DB;
  // DDL satu per satu, alasan sama seperti ensureSchema (batch DDL rawan 1101).
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS cms_backup_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_comments (id INTEGER PRIMARY KEY, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, backup_at TEXT NOT NULL, PRIMARY KEY (comment_id, user_key))`,
  ]) await bak.prepare(sql).run();
  const stmts = [
    bak.prepare(`DELETE FROM cms_backup_posts`),
    bak.prepare(`DELETE FROM cms_backup_comments`),
    bak.prepare(`DELETE FROM cms_backup_settings`),
    bak.prepare(`DELETE FROM cms_backup_plugins`),
    bak.prepare(`DELETE FROM cms_backup_users`),
    bak.prepare(`DELETE FROM cms_backup_votes`),
  ];
  for (const p of (posts.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.id, p.slug, p.title, p.body, p.category, p.status, p.created_at, p.updated_at, p.body_mode || 'text', p.visibility || 'public', p.publish_at || p.created_at || '', p.post_password_hash || '', p.post_password_salt || '', Number(p.views) || 0, now));
  }
  for (const c of (comments.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_comments (id, post_id, name, text, status, created_at, parent_id, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.post_id, c.name, c.text, c.status, c.created_at, c.parent_id ?? null, now));
  }
  for (const u of (users.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_users (id, username, password_hash, salt, created_at, backup_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(u.id, u.username, u.password_hash, u.salt, u.created_at, now));
  }
  for (const v of (votes.results || [])) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_votes (comment_id, user_key, vote, backup_at) VALUES (?, ?, ?, ?)`).bind(v.comment_id, v.user_key, v.vote, now));
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

// Judul dari variabel Worker (SITE_TITLE) menang atas D1, D1 menang
// atas default WorkerCMS. Ini yang membuat repo tetap netral (tidak ada
// nama pribadi di kode) sementara instance yang di-deploy di domain
// pemilik tampil dengan judulnya sendiri — tanpa mengubah site_title
// di D1 dan tanpa redeploy ulang bila variabel diubah dari dashboard.
export function envSiteTitle(env) {
  const v = env && typeof env.SITE_TITLE === 'string' ? env.SITE_TITLE.trim().slice(0, 100) : '';
  return v;
}

export async function renderPage(env, pageTitle, content, opts = {}) {
  // Percepat semuanya: bila pemanggil sudah mengambil judul/tema (dashboard),
  // jangan query D1 lagi. Bila belum, query pengaturan ini jalan barengan.
  let siteTitle = opts.siteTitle;
  let themeId = opts.themeId;
  let siteAvatar = opts.siteAvatar;
  if (!siteTitle || !themeId || siteAvatar === undefined) {
    const envTitle = envSiteTitle(env);
    const [siteTitleDb, themeDb, avatarDb] = await Promise.all([
      envTitle || siteTitle ? Promise.resolve('') : getSetting(env, 'site_title', 'WorkerCMS'),
      themeId ? Promise.resolve('') : getSetting(env, 'theme', 'terang'),
      siteAvatar !== undefined ? Promise.resolve('') : getSetting(env, 'site_avatar', ''),
    ]);
    if (!siteTitle) siteTitle = envTitle || siteTitleDb;
    if (!themeId) themeId = themeDb;
    if (siteAvatar === undefined) siteAvatar = avatarDb;
  }
  // Foto profil hanya boleh link https tanpa kutip/spasi, supaya tidak ada
  // skema aneh atau atribut yang lolos di header.
  if (typeof siteAvatar !== 'string' || !siteAvatar.startsWith('https://') || /["'<\s]/.test(siteAvatar)) siteAvatar = '';
  const theme = themes[themeId] || themes.terang;
  return theme.render({ siteTitle: esc(siteTitle), pageTitle: esc(pageTitle), content, siteAvatar });
}
