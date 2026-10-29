// themes.js
function baseCss(bg, fg, card, muted, accent, border, accent2) {
  return `body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:${bg};color:${fg};line-height:1.6}header{padding:18px 20px;border-bottom:1px solid ${border}}header a{color:${fg};text-decoration:none}header .brand{font-size:20px;font-weight:800;letter-spacing:-.02em;display:inline-flex;align-items:center}header .mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,${accent},${accent2});display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;margin-right:10px}header nav{margin-top:8px;font-size:14px}header nav a{margin-right:14px;color:${accent}}main{max-width:720px;margin:0 auto;padding:20px}.card{background:${card};border:1px solid ${border};border-radius:18px;padding:18px;margin:0 0 16px}.card h2{margin:0 0 6px;font-weight:800;letter-spacing:-.02em}.card h2 a{color:${fg};text-decoration:none}.meta{color:${muted};font-size:12px;letter-spacing:.04em;text-transform:uppercase}a{color:${accent}}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid ${border};border-radius:10px;background:${card};color:${fg}}button{padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,${accent},${accent2});color:#fff;font-weight:700;cursor:pointer}footer{max-width:720px;margin:0 auto;padding:20px;color:${muted};font-size:13px}`;
}
function shell(css, siteTitle, pageTitle, content) {
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024\u2013'+y):'2024'}var START=new Date('2024-01-01T00:00:00+07:00').getTime();var el=document.getElementById('uptime'),mode=0;function p2(n){return (n<10?'0':'')+n}function parts(){var f=new Date(START),t=new Date();var y=t.getFullYear()-f.getFullYear(),mo=t.getMonth()-f.getMonth(),d=t.getDate()-f.getDate(),h=t.getHours()-f.getHours(),mi=t.getMinutes()-f.getMinutes(),s=t.getSeconds()-f.getSeconds();if(s<0){s+=60;mi--}if(mi<0){mi+=60;h--}if(h<0){h+=24;d--}if(d<0){mo--;d+=new Date(t.getFullYear(),t.getMonth(),0).getDate()}if(mo<0){y--;mo+=12}var w=Math.floor(d/7);d=d%7;return{y:y,mo:mo,w:w,d:d,h:h,mi:mi,s:s}}function render(){if(!el)return;if(mode===0){var p=parts(),o=[];if(p.y>0)o.push(p.y+' thn');if(p.mo>0)o.push(p.mo+' bln');if(p.w>0)o.push(p.w+' mgg');if(p.d>0)o.push(p.d+' hari');o.push(p2(p.h)+':'+p2(p.mi)+':'+p2(p.s));el.textContent='Online '+o.join(' ')}else{var hrs=Math.floor((Date.now()-START)/3600000);el.textContent='Online '+hrs.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+' jam'}}if(el){el.addEventListener('click',function(){mode=(mode+1)%2;render()});render();setInterval(render,1000)}}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} \u2014 ${siteTitle}</title><style>${css}</style></head><body><header><a class="brand" href="/"><span class="mark">H</span>${siteTitle}</a><nav><a href="/">Beranda</a><a href="/admin">Admin</a></nav></header><main>${content}</main><footer><p>\xA9 <span id="copyr">2024\u20132026</span> HozinKing \xB7 <span id="uptime" title="Klik untuk ganti mode tampilan" style="cursor:pointer;border-bottom:1px dotted #5b6b8c">\u2026</span></p></footer>${footerScript}</body></html>`;
}
var themes = {
  terang: {
    name: "Terang",
    render: ({ siteTitle, pageTitle, content }) => shell(baseCss("#f6f7fb", "#0a0f1c", "#ffffff", "#5c6a86", "#3b82f6", "#d8deeb", "#8b5cf6"), siteTitle, pageTitle, content)
  },
  gelap: {
    name: "Gelap",
    render: ({ siteTitle, pageTitle, content }) => shell(baseCss("#05070d", "#f0f4fc", "#0d1424", "#8b98b4", "#3b82f6", "rgba(120,160,220,.12)", "#8b5cf6"), siteTitle, pageTitle, content)
  }
};

// plugins.js
var pluginDefs = [
  {
    id: "reading-time",
    name: "Waktu Baca",
    description: "Menampilkan perkiraan menit baca di bawah judul post.",
    postMeta: (post) => {
      const words = String(post.body || "").trim().split(/\s+/).filter(Boolean).length;
      const minutes = Math.max(1, Math.round(words / 200));
      return ` \xB7 \xB1${minutes} menit baca`;
    }
  },
  {
    id: "share",
    name: "Bagikan",
    description: "Tombol bagikan WhatsApp dan X di bawah post.",
    postFooter: (post, ctx) => {
      const url = encodeURIComponent((ctx.baseUrl || "") + "/p/" + post.slug);
      const text = encodeURIComponent(post.title);
      return `<p>Bagikan: <a href="https://wa.me/?text=${text}%20${url}">WhatsApp</a> \xB7 <a href="https://twitter.com/intent/tweet?text=${text}&url=${url}">X</a></p>`;
    }
  },
  {
    id: "related",
    name: "Post Terkait",
    description: "Menampilkan post lain dengan kategori sama di bawah post.",
    postFooter: (post, ctx) => {
      const rel = (ctx.related || []).filter((p) => p.id !== post.id).slice(0, 3);
      if (!rel.length) return "";
      return `<div class="card"><h3>Post Terkait</h3>` + rel.map((p) => `<p><a href="/p/${p.slug}">${p.title}</a></p>`).join("") + `</div>`;
    }
  }
];

// worker.js
var SESSION_TTL_MS = 7 * 24 * 3600 * 1e3;
var schemaReady = null;
function esc(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function para(text) {
  return esc(text).split(/\n\s*\n/).map((p) => `<p>${p.replaceAll("\n", "<br>")}</p>`).join("");
}
function slugify(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "post";
}
function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    ...headers
  } });
}
function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const cookie = parseCookies(request).cms_session || "";
  const [exp, sig] = cookie.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmacHex(env.ADMIN_TOKEN, exp);
}
function sessionExp(request) {
  const cookie = parseCookies(request).cms_session || "";
  const [exp] = cookie.split(".");
  return exp || "";
}
async function csrfToken(env, exp) {
  return env.ADMIN_TOKEN ? await hmacHex(env.ADMIN_TOKEN, "csrf:" + exp) : "";
}
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`
      ];
      for (const sql of ddl) await env.DB.prepare(sql).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('site_title', 'Hozin King')`).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('theme', 'terang')`).run();
      for (const p of pluginDefs) {
        await env.DB.prepare(`INSERT OR IGNORE INTO cms_plugins (id, enabled) VALUES (?, 1)`).bind(p.id).run();
      }
      const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_posts`).first();
      if (existing && Number(existing.n) === 0) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`).bind("p-welcome", "selamat-datang", "Selamat Datang di CMS Hozin", "Ini post pertama. Dari panel admin, kamu bisa menambah post baru, menyetujui komentar, mengganti tema, dan mengaktifkan plugin.", "Umum", now, now).run();
      }
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}
async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare(`SELECT value FROM cms_settings WHERE key = ?`).bind(key).first();
  return row ? row.value : fallback;
}
async function getEnabledPlugins(env) {
  const rows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
  const map = new Map((rows.results || []).map((r) => [r.id, Number(r.enabled) === 1]));
  return pluginDefs.filter((p) => map.get(p.id) !== false);
}
async function doBackup(env) {
  if (!env.BACKUP_DB) throw new Error("Binding BACKUP_DB belum dipasang di Worker");
  const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at ASC`).all();
  const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at ASC`).all();
  const settings = await env.DB.prepare(`SELECT * FROM cms_settings ORDER BY key ASC`).all();
  const plugins = await env.DB.prepare(`SELECT * FROM cms_plugins ORDER BY id ASC`).all();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const bak = env.BACKUP_DB;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS cms_backup_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_comments (id INTEGER PRIMARY KEY, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL)`
  ]) await bak.prepare(sql).run();
  const stmts = [
    bak.prepare(`DELETE FROM cms_backup_posts`),
    bak.prepare(`DELETE FROM cms_backup_comments`),
    bak.prepare(`DELETE FROM cms_backup_settings`),
    bak.prepare(`DELETE FROM cms_backup_plugins`)
  ];
  for (const p of posts.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_posts (id, slug, title, body, category, status, created_at, updated_at, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.id, p.slug, p.title, p.body, p.category, p.status, p.created_at, p.updated_at, now));
  }
  for (const c of comments.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_comments (id, post_id, name, text, status, created_at, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.post_id, c.name, c.text, c.status, c.created_at, now));
  }
  for (const s of settings.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_settings (key, value, backup_at) VALUES (?, ?, ?)`).bind(s.key, s.value, now));
  }
  for (const p of plugins.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_plugins (id, enabled, backup_at) VALUES (?, ?, ?)`).bind(p.id, p.enabled, now));
  }
  await bak.batch(stmts);
  return { posts: (posts.results || []).length, comments: (comments.results || []).length };
}
async function renderPage(env, pageTitle, content) {
  const siteTitle = await getSetting(env, "site_title", "Hozin King");
  const themeId = await getSetting(env, "theme", "terang");
  const theme = themes[themeId] || themes.terang;
  return theme.render({ siteTitle: esc(siteTitle), pageTitle: esc(pageTitle), content });
}
function postCard(post, plugins) {
  const meta = plugins.map((p) => p.postMeta ? p.postMeta(post) : "").join("");
  return `<article class="card"><h2><a href="/p/${esc(post.slug)}">${esc(post.title)}</a></h2><p class="meta">${esc(post.category)} \xB7 ${esc(post.created_at.slice(0, 10))}${meta}</p><p>${esc(String(post.body).slice(0, 200))}${String(post.body).length > 200 ? "\u2026" : ""}</p></article>`;
}
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    await ensureSchema(env);
    const admin = await isAdmin(request, env);
    if (request.method === "GET" && path === "/") {
      const rows = await env.DB.prepare(`SELECT * FROM cms_posts WHERE status = 'published' ORDER BY created_at DESC`).all();
      const plugins = await getEnabledPlugins(env);
      const posts = rows.results || [];
      const content = posts.length ? posts.map((p) => postCard(p, plugins)).join("") : '<div class="card"><p>Belum ada post.</p></div>';
      return html(await renderPage(env, "Beranda", content));
    }
    const postMatch = path.match(/^\/p\/([A-Za-z0-9-]+)(?:\/comment)?$/);
    if (postMatch) {
      const slug = postMatch[1];
      if (request.method === "GET") {
        const post = await env.DB.prepare(`SELECT * FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (!post || post.status !== "published") return html(await renderPage(env, "Tidak ditemukan", '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
        const plugins = await getEnabledPlugins(env);
        const comments = await env.DB.prepare(`SELECT * FROM cms_comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC`).bind(post.id).all();
        const rel = await env.DB.prepare(`SELECT * FROM cms_posts WHERE category = ? AND status = 'published' ORDER BY created_at DESC`).bind(post.category).all();
        const meta = plugins.map((p) => p.postMeta ? p.postMeta(post) : "").join("");
        const footers = plugins.map((p) => p.postFooter ? p.postFooter(post, { related: rel.results || [], baseUrl: url.origin }) : "").join("");
        const notice = url.searchParams.get("komentar") === "menunggu" ? '<div class="card"><p>Komentar dikirim, menunggu persetujuan admin.</p></div>' : "";
        const commentHtml = (comments.results || []).map((c) => `<div class="card"><p><b>${esc(c.name)}</b></p><p>${esc(c.text)}</p></div>`).join("") || "<p>Belum ada komentar.</p>";
        const content = `<article class="card"><h2>${esc(post.title)}</h2><p class="meta">${esc(post.category)} \xB7 ${esc(post.created_at.slice(0, 10))}${meta}</p>${para(post.body)}</article>${footers}<h3>Komentar</h3>${commentHtml}${notice}<form method="post" action="/p/${esc(slug)}/comment"><label>Nama</label><input name="name" maxlength="80" required><label>Komentar</label><textarea name="text" maxlength="2000" required></textarea><button type="submit">Kirim Komentar</button></form>`;
        return html(await renderPage(env, post.title, content));
      }
      if (request.method === "POST" && path.endsWith("/comment")) {
        const post = await env.DB.prepare(`SELECT * FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (!post) return redirect("/");
        const form = await request.formData();
        const name = String(form.get("name") || "").trim().slice(0, 80);
        const text = String(form.get("text") || "").trim().slice(0, 2e3);
        if (name && text) {
          await env.DB.prepare(`INSERT INTO cms_comments (post_id, name, text, status, created_at) VALUES (?, ?, ?, 'pending', ?)`).bind(post.id, name, text, (/* @__PURE__ */ new Date()).toISOString()).run();
        }
        return redirect(`/p/${slug}?komentar=menunggu`);
      }
    }
    if (path === "/admin/login" && request.method === "POST") {
      const form = await request.formData();
      const ip = clientIp(request);
      const since = new Date(Date.now() - 15 * 60 * 1e3).toISOString();
      const fails = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_login_attempts WHERE ip = ? AND created_at > ?`).bind(ip, since).first();
      if (fails && Number(fails.n) >= 5) {
        return html(await renderPage(env, "Admin", '<div class="card"><p>Terlalu banyak percobaan login. Coba lagi 15 menit.</p></div>'), 429);
      }
      if (env.ADMIN_TOKEN && String(form.get("password") || "") === env.ADMIN_TOKEN) {
        await env.DB.prepare(`DELETE FROM cms_login_attempts WHERE ip = ?`).bind(ip).run();
        const exp = String(Date.now() + SESSION_TTL_MS);
        const sig = await hmacHex(env.ADMIN_TOKEN, exp);
        return redirect("/admin", { "set-cookie": `cms_session=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1e3)}` });
      }
      await env.DB.prepare(`INSERT INTO cms_login_attempts (ip, created_at) VALUES (?, ?)`).bind(ip, (/* @__PURE__ */ new Date()).toISOString()).run();
      return html(await renderPage(env, "Admin", '<div class="card"><p>Password salah.</p><p><a href="/admin">Kembali</a></p></div>'), 403);
    }
    if (path === "/admin/logout" && request.method === "POST") {
      if (!admin) return redirect("/admin");
      const form = await request.formData();
      if (String(form.get("csrf") || "") !== await csrfToken(env, sessionExp(request))) {
        return html(await renderPage(env, "Admin", '<div class="card"><p>Token CSRF tidak valid.</p></div>'), 403);
      }
      return redirect("/admin", { "set-cookie": "cms_session=; Path=/; HttpOnly; Secure; Max-Age=0" });
    }
    if (path === "/admin") {
      if (request.method === "GET") {
        if (!admin) {
          return html(await renderPage(env, "Admin", '<div class="card"><h2>Login Admin</h2><form method="post" action="/admin/login"><label>Password admin</label><input type="password" name="password" required><button type="submit">Masuk</button></form></div>'));
        }
        const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at DESC`).all();
        const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at DESC`).all();
        const themeId = await getSetting(env, "theme", "terang");
        const siteTitle = await getSetting(env, "site_title", "Hozin King");
        const pluginRows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
        const pMap = new Map((pluginRows.results || []).map((r) => [r.id, Number(r.enabled)]));
        const csrf = await csrfToken(env, sessionExp(request));
        const csrfField = `<input type="hidden" name="csrf" value="${csrf}">`;
        const postRows = (posts.results || []).map((p) => `<div class="card"><b>${esc(p.title)}</b> (${esc(p.status)})<form method="post" action="/admin/posts/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(p.id)}"><button type="submit">Hapus</button></form></div>`).join("");
        const commentRows = (comments.results || []).map((c) => `<div class="card"><b>${esc(c.name)}</b> [${esc(c.status)}]<p>${esc(c.text)}</p><form method="post" action="/admin/comments/approve" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Setujui</button></form> <form method="post" action="/admin/comments/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Hapus</button></form></div>`).join("");
        const themeOptions = Object.entries(themes).map(([id, t]) => `<option value="${id}" ${id === themeId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
        const pluginForms = pluginDefs.map((p) => `<div class="card"><b>${esc(p.name)}</b> \u2014 ${esc(p.description)}<form method="post" action="/admin/plugins/toggle">${csrfField}<input type="hidden" name="id" value="${p.id}"><input type="hidden" name="enabled" value="${pMap.get(p.id) === 0 ? "1" : "0"}"><button type="submit">${pMap.get(p.id) === 0 ? "Aktifkan" : "Nonaktifkan"}</button></form></div>`).join("");
        const backupRuns = await env.DB.prepare(`SELECT * FROM cms_backup_runs ORDER BY created_at DESC LIMIT 10`).all();
        const backupRows = (backupRuns.results || []).map((r) => `<div class="card"><b>${esc(r.status)}</b> \xB7 ${esc(r.created_at)} \xB7 ${r.posts} post, ${r.comments} komentar${r.error ? `<p>Error: ${esc(r.error)}</p>` : ""}</div>`).join("") || "<p>Belum ada backup.</p>";
        const backupCard = `<div class="card"><h3>Backup ke Stopwatch</h3><p>Database stopwatch khusus dipakai sebagai tempat backup CMS. Salinan tidak pernah ditulis dari jalur lain \u2014 hanya tombol ini yang menulis ke sana.</p><form method="post" action="/admin/backup">${csrfField}<button type="submit">Buat Backup Sekarang</button></form><h4>Riwayat Backup</h4>${backupRows}</div>`;
        const content = `<h2>Dashboard Admin</h2><p>Peran: <b>Super-Super-Admin (satu-satunya)</b> \u2014 tidak ada akun admin lain, tidak ada pendaftar publik.</p><form method="post" action="/admin/logout">${csrfField}<button type="submit">Keluar</button></form>${backupCard}<div class="card"><h3>Pengaturan</h3><form method="post" action="/admin/settings">${csrfField}<label>Judul situs</label><input name="site_title" value="${esc(siteTitle)}"><label>Tema</label><select name="theme">${themeOptions}</select><button type="submit">Simpan Pengaturan</button></form></div><div class="card"><h3>Post Baru</h3><form method="post" action="/admin/posts">${csrfField}<label>Judul</label><input name="title" required><label>Kategori</label><input name="category" value="Umum"><label>Isi</label><textarea name="body" required></textarea><button type="submit">Terbitkan</button></form></div><h3>Post</h3>${postRows}<h3>Komentar</h3>${commentRows}<h3>Plugin</h3>${pluginForms}`;
        return html(await renderPage(env, "Admin", content));
      }
    }
    if (admin && request.method === "POST") {
      const form = await request.formData();
      if (String(form.get("csrf") || "") !== await csrfToken(env, sessionExp(request))) {
        return html(await renderPage(env, "Admin", '<div class="card"><p>Token CSRF tidak valid. Muat ulang dashboard lalu coba lagi.</p></div>'), 403);
      }
      if (path === "/admin/backup") {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        try {
          const counts = await doBackup(env);
          await env.DB.prepare(`INSERT INTO cms_backup_runs (created_at, status, posts, comments, error) VALUES (?, 'BERHASIL', ?, ?, '')`).bind(now, counts.posts, counts.comments).run();
        } catch (e) {
          await env.DB.prepare(`INSERT INTO cms_backup_runs (created_at, status, posts, comments, error) VALUES (?, 'GAGAL', 0, 0, ?)`).bind(now, String(e && e.message ? e.message : e).slice(0, 300)).run();
        }
        return redirect("/admin");
      }
      if (path === "/admin/settings") {
        const siteTitle = String(form.get("site_title") || "").trim().slice(0, 100) || "Hozin King";
        const theme = String(form.get("theme") || "terang");
        if (themes[theme]) {
          await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('site_title', ?)`).bind(siteTitle).run();
          await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('theme', ?)`).bind(theme).run();
        }
        return redirect("/admin");
      }
      if (path === "/admin/posts") {
        const title = String(form.get("title") || "").trim();
        const body = String(form.get("body") || "").trim();
        const category = String(form.get("category") || "Umum").trim().slice(0, 80) || "Umum";
        if (title && body) {
          const now = (/* @__PURE__ */ new Date()).toISOString();
          const id = "p-" + Date.now().toString(36);
          let slug = slugify(title);
          const clash = await env.DB.prepare(`SELECT id FROM cms_posts WHERE slug = ?`).bind(slug).first();
          if (clash) slug = slug + "-" + Date.now().toString(36).slice(-4);
          await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?)`).bind(id, slug, title, body, category, now, now).run();
        }
        return redirect("/admin");
      }
      if (path === "/admin/posts/delete") {
        await env.DB.prepare(`DELETE FROM cms_posts WHERE id = ?`).bind(String(form.get("id") || "")).run();
        return redirect("/admin");
      }
      if (path === "/admin/comments/approve") {
        await env.DB.prepare(`UPDATE cms_comments SET status = 'approved' WHERE id = ?`).bind(Number(form.get("id"))).run();
        return redirect("/admin");
      }
      if (path === "/admin/comments/delete") {
        await env.DB.prepare(`DELETE FROM cms_comments WHERE id = ?`).bind(Number(form.get("id"))).run();
        return redirect("/admin");
      }
      if (path === "/admin/plugins/toggle") {
        const id = String(form.get("id") || "");
        if (pluginDefs.some((p) => p.id === id)) {
          await env.DB.prepare(`UPDATE cms_plugins SET enabled = ? WHERE id = ?`).bind(Number(form.get("enabled")) ? 1 : 0, id).run();
        }
        return redirect("/admin");
      }
    }
    if (path.startsWith("/admin")) {
      return html(await renderPage(env, "Admin", '<div class="card"><p>Butuh login admin.</p><p><a href="/admin">Ke login</a></p></div>'), 403);
    }
    return html(await renderPage(env, "Tidak ditemukan", '<div class="card"><p>Halaman tidak ditemukan.</p></div>'), 404);
  }
};
export {
  worker_default as default
};
