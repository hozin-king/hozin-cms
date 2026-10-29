// themes.js
function baseCss(def) {
  const { bg, fg, card, muted, accent, border, accent2, font, radius, maxWidth } = def;
  return `body{margin:0;font-family:${font};background:${bg};color:${fg};line-height:1.6;display:flex;flex-direction:column;min-height:100vh;font-size:16px}*,*::before,*::after{box-sizing:border-box}header{padding:18px 20px;border-bottom:1px solid ${border}}header a{color:${fg};text-decoration:none}header .brand{font-size:clamp(18px,4vw,20px);font-weight:800;letter-spacing:-.02em;display:inline-flex;align-items:center}header .mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,${accent},${accent2});display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;margin-right:10px}header nav{margin-top:8px;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 14px}header nav a{margin-right:0;color:${accent}}main{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:clamp(14px,4vw,20px)}.card{background:${card};border:1px solid ${border};border-radius:${radius}px;padding:18px;margin:0 0 16px;overflow-wrap:anywhere}.card h2{margin:0 0 6px;font-weight:800;letter-spacing:-.02em;font-size:clamp(20px,5vw,26px)}.card h2 a{color:${fg};text-decoration:none}.meta{color:${muted};font-size:12px;letter-spacing:.04em;text-transform:uppercase}a{color:${accent}}img,video{max-width:100%;height:auto}audio{width:100%}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid ${border};border-radius:10px;background:${card};color:${fg};font-size:16px}button{padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,${accent},${accent2});color:#fff;font-weight:700;cursor:pointer}footer{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:20px;color:${muted};font-size:13px;margin-top:auto}@media (max-width:600px){header{padding:14px 16px}main{padding:14px}.card{padding:14px}button{min-height:44px;padding:12px 18px}}@media (min-width:900px){main,footer{max-width:${maxWidth + 40}px}}`;
}
function shell(css, siteTitle, pageTitle, content) {
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024\u2013'+y):'2024'}var START=new Date('2024-01-01T00:00:00+07:00').getTime();var el=document.getElementById('uptime'),mode=0;function p2(n){return (n<10?'0':'')+n}function parts(){var f=new Date(START),t=new Date();var y=t.getFullYear()-f.getFullYear(),mo=t.getMonth()-f.getMonth(),d=t.getDate()-f.getDate(),h=t.getHours()-f.getHours(),mi=t.getMinutes()-f.getMinutes(),s=t.getSeconds()-f.getSeconds();if(s<0){s+=60;mi--}if(mi<0){mi+=60;h--}if(h<0){h+=24;d--}if(d<0){mo--;d+=new Date(t.getFullYear(),t.getMonth(),0).getDate()}if(mo<0){y--;mo+=12}var w=Math.floor(d/7);d=d%7;return{y:y,mo:mo,w:w,d:d,h:h,mi:mi,s:s}}function render(){if(!el)return;if(mode===0){var p=parts(),o=[];if(p.y>0)o.push(p.y+' thn');if(p.mo>0)o.push(p.mo+' bln');if(p.w>0)o.push(p.w+' mgg');if(p.d>0)o.push(p.d+' hari');o.push(p2(p.h)+':'+p2(p.mi)+':'+p2(p.s));el.textContent='Online '+o.join(' ')}else{var hrs=Math.floor((Date.now()-START)/3600000);el.textContent='Online '+hrs.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+' jam'}}if(el){el.addEventListener('click',function(){mode=(mode+1)%2;render()});render();setInterval(render,1000)}}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} \u2014 ${siteTitle}</title><style>${css}</style></head><body><header><a class="brand" href="/"><span class="mark">H</span>${siteTitle}</a><nav><a href="/">Beranda</a><a href="/admin">Admin</a></nav></header><main>${content}</main><footer><p>\xA9 <span id="copyr">2024\u20132026</span> HozinKing \xB7 <span id="uptime" title="Klik untuk ganti mode tampilan" style="cursor:pointer;border-bottom:1px dotted #5b6b8c">\u2026</span></p></footer>${footerScript}</body></html>`;
}
var themeDefs = {
  terang: {
    name: "Terang",
    bg: "#f6f7fb",
    fg: "#0a0f1c",
    card: "#ffffff",
    muted: "#5c6a86",
    accent: "#3b82f6",
    border: "#d8deeb",
    accent2: "#8b5cf6",
    font: "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    radius: 18,
    maxWidth: 720
  },
  gelap: {
    name: "Gelap",
    bg: "#05070d",
    fg: "#f0f4fc",
    card: "#0d1424",
    muted: "#8b98b4",
    accent: "#3b82f6",
    border: "rgba(120,160,220,.12)",
    accent2: "#8b5cf6",
    font: "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    radius: 18,
    maxWidth: 720
  },
  majalah: {
    name: "Majalah",
    bg: "#faf9f6",
    fg: "#16130f",
    card: "#ffffff",
    muted: "#6b6257",
    accent: "#3b82f6",
    border: "#e3ddd0",
    accent2: "#8b5cf6",
    font: 'Georgia,"Times New Roman",serif',
    radius: 12,
    maxWidth: 780
  },
  minimal: {
    name: "Minimal",
    bg: "#ffffff",
    fg: "#111111",
    card: "#ffffff",
    muted: "#666666",
    accent: "#111111",
    border: "#e5e5e5",
    accent2: "#111111",
    font: "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
    radius: 8,
    maxWidth: 680
  }
};
var themes = Object.fromEntries(Object.entries(themeDefs).map(([id, def]) => [id, {
  name: def.name,
  render: ({ siteTitle, pageTitle, content }) => shell(baseCss(def), siteTitle, pageTitle, content)
}]));

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
var ACCESS_TTL_MS = 60 * 60 * 1e3;
var REFRESH_TTL_MS = 24 * 3600 * 1e3;
var REFRESH_REMEMBER_TTL_MS = 30 * 24 * 3600 * 1e3;
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
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    // CSP: skrip/style inline diizinkan karena tema + editor blok memakai
    // skrip inline (footer uptime, editor). Yang dilarang keras: objek/embed
    // (Flash/Java), frame dari luar (clickjacking sudah DENY juga), form ke
    // luar situs, dan gambar hanya dari situs sendiri / https / data.
    "content-security-policy": "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
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
  const cookie = parseCookies(request).cms_access || "";
  const [exp, sig] = cookie.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmacHex(env.ADMIN_TOKEN, "access:" + exp);
}
async function csrfToken(env) {
  return env.ADMIN_TOKEN ? await hmacHex(env.ADMIN_TOKEN, "csrf") : "";
}
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function accessCookie(env, exp) {
  return hmacHex(env.ADMIN_TOKEN, "access:" + exp).then((sig) => `cms_access=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ACCESS_TTL_MS / 1e3)}`);
}
async function issueTokens(env, request, remember) {
  const now = Date.now();
  const exp = String(now + ACCESS_TTL_MS);
  const access = await accessCookie(env, exp);
  const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(raw);
  const id = randomHex(12);
  const ttl = remember ? REFRESH_REMEMBER_TTL_MS : REFRESH_TTL_MS;
  const iso = new Date(now).toISOString();
  const expires = new Date(now + ttl).toISOString();
  const device = (request.headers.get("user-agent") || "").slice(0, 80);
  await env.DB.prepare(`INSERT INTO cms_refresh_tokens (id, token_hash, device, ip, created_at, last_used_at, expires_at, revoked, replaced_by, remember) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?)`).bind(id, hash, device, clientIp(request), iso, iso, expires, remember ? 1 : 0).run();
  const refresh = `cms_refresh=${raw}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttl / 1e3)}`;
  return [access, refresh];
}
async function getRefreshRow(request, env) {
  const raw = parseCookies(request).cms_refresh || "";
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  return await env.DB.prepare(`SELECT * FROM cms_refresh_tokens WHERE token_hash = ?`).bind(hash).first();
}
async function revokeAllRefresh(env) {
  await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1 WHERE revoked = 0`).run();
}
function setCookieInHeader(header, name, value) {
  const parts = (header || "").split(";").map((p) => p.trim()).filter((p) => p && !p.startsWith(name + "="));
  parts.push(`${name}=${value}`);
  return parts.join("; ");
}
async function tryRefresh(request, env) {
  const raw = parseCookies(request).cms_refresh || "";
  if (!raw || !env.ADMIN_TOKEN) return null;
  const row = await getRefreshRow(request, env);
  if (!row) return null;
  if (row.revoked) {
    if (row.replaced_by) await revokeAllRefresh(env);
    return null;
  }
  if (String(row.expires_at) <= (/* @__PURE__ */ new Date()).toISOString()) {
    await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1 WHERE id = ?`).bind(row.id).run();
    return null;
  }
  const now = Date.now();
  const newRaw = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const newHash = await sha256Hex(newRaw);
  const newId = randomHex(12);
  const ttl = row.remember ? REFRESH_REMEMBER_TTL_MS : REFRESH_TTL_MS;
  const iso = new Date(now).toISOString();
  const expires = new Date(now + ttl).toISOString();
  await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1, replaced_by = ? WHERE id = ?`).bind(newId, row.id).run();
  await env.DB.prepare(`INSERT INTO cms_refresh_tokens (id, token_hash, device, ip, created_at, last_used_at, expires_at, revoked, replaced_by, remember) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?)`).bind(newId, newHash, row.device || "", row.ip || "", iso, iso, expires, row.remember ? 1 : 0).run();
  const access = await accessCookie(env, String(now + ACCESS_TTL_MS));
  const refresh = `cms_refresh=${newRaw}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttl / 1e3)}`;
  const headers = new Headers(request.headers);
  let cookieHeader = request.headers.get("cookie") || "";
  cookieHeader = setCookieInHeader(cookieHeader, "cms_access", access.split(";")[0].split("=")[1]);
  cookieHeader = setCookieInHeader(cookieHeader, "cms_refresh", newRaw);
  headers.set("cookie", cookieHeader);
  return { request: new Request(request, { headers }), cookies: [access, refresh] };
}
function redirectWithCookies(location, cookies) {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}
function clearAuthCookies() {
  return [
    "cms_access=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "cms_refresh=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    "cms_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  ];
}
function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
function stripTags(s) {
  return String(s ?? "").replace(/<[^>]*>/g, "");
}
var ALLOWED_TAGS = /* @__PURE__ */ new Set(["p", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "br", "hr", "img", "figure", "figcaption", "pre", "code", "span", "div", "video", "audio", "source"]);
var ALLOWED_ATTRS = {
  a: /* @__PURE__ */ new Set(["href", "title"]),
  img: /* @__PURE__ */ new Set(["src", "alt", "title", "width", "height"]),
  video: /* @__PURE__ */ new Set(["src", "poster", "controls", "preload"]),
  audio: /* @__PURE__ */ new Set(["src", "controls", "preload"]),
  source: /* @__PURE__ */ new Set(["src", "type"])
};
function safeUrl(u) {
  const v = String(u || "").trim();
  if (/^(https?:\/\/|\/|#|mailto:)/i.test(v)) return v;
  return "";
}
function sanitizeHtml(input) {
  let s = String(input || "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "input", "textarea", "select", "button", "link", "meta", "title", "head", "body", "html"]) {
    s = s.replace(new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?<\\/" + tag + "\\s*>", "gi"), "");
    s = s.replace(new RegExp("<" + tag + "\\b[^>]*\\/?>", "gi"), "");
  }
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (whole, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    const closing = whole.startsWith("</");
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (closing) return "</" + tag + ">";
    const allowed = ALLOWED_ATTRS[tag] || /* @__PURE__ */ new Set();
    let out = "";
    const attrRe = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = attrRe.exec(attrs || "")) !== null) {
      const name = m[1].toLowerCase();
      if (!allowed.has(name)) continue;
      if (name === "controls") {
        out += " controls";
        continue;
      }
      const val = m[2] ?? m[3] ?? m[4] ?? "";
      if (name === "href" || name === "src" || name === "poster") {
        const safe = safeUrl(val);
        if (!safe) continue;
        out += " " + name + '="' + esc(safe) + '"';
      } else {
        out += " " + name + '="' + esc(val) + '"';
      }
    }
    const selfClose = tag === "br" || tag === "hr" || tag === "img" || tag === "source" ? " /" : "";
    return "<" + tag + out + selfClose + ">";
  });
  return s;
}
async function checkRateLimit(env, key, limit, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const k = key + ":" + bucket;
  const row = await env.DB.prepare(`SELECT count FROM cms_rate_limits WHERE key = ?`).bind(k).first();
  const n = row ? Number(row.count) : 0;
  if (n >= limit) return false;
  await env.DB.prepare(`INSERT INTO cms_rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1`).bind(k, (/* @__PURE__ */ new Date()).toISOString()).run();
  return true;
}
async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1e5, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function verifyPassword(password, saltHex, hashHex) {
  const h = await hashPassword(password, saltHex);
  if (h.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
async function userCsrf(env, userId) {
  return env.ADMIN_TOKEN ? await hmacHex(env.ADMIN_TOKEN, "user-csrf:" + userId) : "";
}
async function getCommenter(request, env) {
  if (!env.ADMIN_TOKEN) return null;
  const cookie = parseCookies(request).cms_user || "";
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  if (!userId || !exp || !sig || Number(exp) < Date.now()) return null;
  if (sig !== await hmacHex(env.ADMIN_TOKEN, "user:" + userId + ":" + exp)) return null;
  const row = await env.DB.prepare(`SELECT * FROM cms_users WHERE id = ?`).bind(userId).first();
  return row || null;
}
async function userSessionCookie(env, userId) {
  const exp = String(Date.now() + 30 * 24 * 3600 * 1e3);
  const sig = await hmacHex(env.ADMIN_TOKEN, "user:" + userId + ":" + exp);
  return `cms_user=${userId}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
}
function unlockCookieName(postId) {
  return "cms_unlock_" + String(postId).replace(/[^A-Za-z0-9_-]/g, "_");
}
async function isPostUnlocked(request, env, postId) {
  if (!env.ADMIN_TOKEN) return false;
  const cookie = parseCookies(request)[unlockCookieName(postId)] || "";
  const parts = cookie.split(".");
  if (parts.length !== 2) return false;
  const [exp, sig] = parts;
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmacHex(env.ADMIN_TOKEN, "post-unlock:" + postId + ":" + exp);
}
async function postUnlockCookie(env, postId) {
  const exp = String(Date.now() + 24 * 3600 * 1e3);
  const sig = await hmacHex(env.ADMIN_TOKEN, "post-unlock:" + postId + ":" + exp);
  return `${unlockCookieName(postId)}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${24 * 3600}`;
}
function isScheduled(post, nowIso) {
  return post.publish_at && String(post.publish_at) > nowIso;
}
function visibilityLabel(post, nowIso) {
  if (isScheduled(post, nowIso)) return "Terjadwal";
  if (post.visibility === "private") return "Private";
  if (post.visibility === "unlisted") return "Link saja";
  if (post.visibility === "password") return "Password";
  return "Publik";
}
async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const ddl = [
        `CREATE TABLE IF NOT EXISTS cms_posts (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cms_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER)`,
        `CREATE TABLE IF NOT EXISTS cms_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS cms_login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_backup_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS cms_refresh_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, device TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, replaced_by TEXT NOT NULL DEFAULT '', remember INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cms_users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS cms_comment_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, PRIMARY KEY (comment_id, user_key))`,
        `CREATE TABLE IF NOT EXISTS cms_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL)`
      ];
      for (const sql of ddl) await env.DB.prepare(sql).run();
      const info = await env.DB.prepare(`PRAGMA table_info(cms_posts)`).all();
      const have = new Set((info.results || []).map((r) => r.name));
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
        views: `ALTER TABLE cms_posts ADD COLUMN views INTEGER NOT NULL DEFAULT 0`
      };
      for (const [col, sql] of Object.entries(missing)) {
        if (!have.has(col)) await env.DB.prepare(sql).run();
      }
      const cInfo = await env.DB.prepare(`PRAGMA table_info(cms_comments)`).all();
      const cHave = new Set((cInfo.results || []).map((r) => r.name));
      if (!cHave.has("parent_id")) await env.DB.prepare(`ALTER TABLE cms_comments ADD COLUMN parent_id INTEGER`).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('site_title', 'Hozin King')`).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO cms_settings (key, value) VALUES ('theme', 'terang')`).run();
      for (const p of pluginDefs) {
        await env.DB.prepare(`INSERT OR IGNORE INTO cms_plugins (id, enabled) VALUES (?, 1)`).bind(p.id).run();
      }
      const existing = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_posts`).first();
      if (existing && Number(existing.n) === 0) {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, 'text', 'public', ?, '', '', 0)`).bind("p-welcome", "selamat-datang", "Selamat Datang di CMS Hozin", "Ini post pertama. Dari panel admin, kamu bisa menambah post baru, menyetujui komentar, mengganti tema, dan mengaktifkan plugin.", "Umum", now, now, now).run();
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
  const users = await env.DB.prepare(`SELECT * FROM cms_users ORDER BY created_at ASC`).all();
  const votes = await env.DB.prepare(`SELECT * FROM cms_comment_votes ORDER BY comment_id ASC`).all();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const bak = env.BACKUP_DB;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS cms_backup_posts (id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'Umum', status TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body_mode TEXT NOT NULL DEFAULT 'text', visibility TEXT NOT NULL DEFAULT 'public', publish_at TEXT NOT NULL DEFAULT '', post_password_hash TEXT NOT NULL DEFAULT '', post_password_salt TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_comments (id INTEGER PRIMARY KEY, post_id TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, parent_id INTEGER, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL, backup_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS cms_backup_votes (comment_id INTEGER NOT NULL, user_key TEXT NOT NULL, vote INTEGER NOT NULL, backup_at TEXT NOT NULL, PRIMARY KEY (comment_id, user_key))`
  ]) await bak.prepare(sql).run();
  const stmts = [
    bak.prepare(`DELETE FROM cms_backup_posts`),
    bak.prepare(`DELETE FROM cms_backup_comments`),
    bak.prepare(`DELETE FROM cms_backup_settings`),
    bak.prepare(`DELETE FROM cms_backup_plugins`),
    bak.prepare(`DELETE FROM cms_backup_users`),
    bak.prepare(`DELETE FROM cms_backup_votes`)
  ];
  for (const p of posts.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(p.id, p.slug, p.title, p.body, p.category, p.status, p.created_at, p.updated_at, p.body_mode || "text", p.visibility || "public", p.publish_at || p.created_at || "", p.post_password_hash || "", p.post_password_salt || "", Number(p.views) || 0, now));
  }
  for (const c of comments.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_comments (id, post_id, name, text, status, created_at, parent_id, backup_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.post_id, c.name, c.text, c.status, c.created_at, c.parent_id ?? null, now));
  }
  for (const u of users.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_users (id, username, password_hash, salt, created_at, backup_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(u.id, u.username, u.password_hash, u.salt, u.created_at, now));
  }
  for (const v of votes.results || []) {
    stmts.push(bak.prepare(`INSERT INTO cms_backup_votes (comment_id, user_key, vote, backup_at) VALUES (?, ?, ?, ?)`).bind(v.comment_id, v.user_key, v.vote, now));
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
  const plain = stripTags(post.body || "");
  const views = Number(post.views) || 0;
  return `<article class="card"><h2><a href="/p/${esc(post.slug)}">${esc(post.title)}</a></h2><p class="meta">${esc(post.category)} \xB7 ${esc(String(post.created_at || "").slice(0, 10))} \xB7 \u{1F441} ${views}${meta}</p><p>${esc(plain.slice(0, 200))}${plain.length > 200 ? "\u2026" : ""}</p></article>`;
}
function renderCommentsTree(comments, votes, myVotes, csrfField, canReply, postSlug) {
  const byParent = /* @__PURE__ */ new Map();
  for (const c of comments) {
    const key = c.parent_id ? String(c.parent_id) : "root";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }
  const renderOne = (c, depth) => {
    const v = votes.get(c.id) || { like: 0, dislike: 0 };
    const mine = myVotes.get(c.id) || 0;
    const indent = Math.min(depth, 3) * 18;
    const replyForm = canReply ? `<form method="post" action="/p/${esc(postSlug)}/comment" style="margin-top:8px"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="parent_id" value="${c.id}"><textarea name="text" maxlength="2000" placeholder="Balas ${esc(c.name)}\u2026" required></textarea><button type="submit">Balas</button></form>` : "";
    const voteForms = canReply ? `<form method="post" action="/p/${esc(postSlug)}/comment/vote" style="display:inline"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><input type="hidden" name="vote" value="1"><button type="submit">${mine === 1 ? "<b>\u{1F44D} " + v.like + "</b>" : "\u{1F44D} " + v.like}</button></form> <form method="post" action="/p/${esc(postSlug)}/comment/vote" style="display:inline"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><input type="hidden" name="vote" value="-1"><button type="submit">${mine === -1 ? "<b>\u{1F44E} " + v.dislike + "</b>" : "\u{1F44E} " + v.dislike}</button></form>` : `<span>\u{1F44D} ${v.like} \xB7 \u{1F44E} ${v.dislike}</span>`;
    const kids = (byParent.get(String(c.id)) || []).map((k) => renderOne(k, depth + 1)).join("");
    return `<div class="card" style="margin-left:${indent}px"><p><b>${esc(c.name)}</b></p><p>${esc(c.text)}</p><p>${voteForms}</p>${replyForm}${kids}</div>`;
  };
  const roots = [...byParent.get("root") || []];
  for (const c of comments) {
    if (c.parent_id && !comments.some((p) => p.id === c.parent_id) && !roots.includes(c)) roots.push(c);
  }
  return roots.map((c) => renderOne(c, 0)).join("") || "<p>Belum ada komentar.</p>";
}
var worker_default = {
  // Fallback anti-1101 (insiden 29 Okt 2026 20:28 WIB): bila D1 tidak bisa
  // diakses — mis. kuota baca harian gratis habis — JANGAN lempar exception
  // (Cloudflare mengubahnya jadi Error 1101 di semua halaman). Beranda tampil
  // statis, jalur lain dapat halaman 503 yang jelas. Begitu D1 bisa diakses
  // lagi (kuota reset tengah malam UTC = 07:00 WIB), semua kembali normal
  // tanpa redeploy, karena schemaReady di-reset saat gagal. Data tidak hilang:
  // ini hanya gagal baca, bukan gagal tulis.
  async fetch(request, env) {
    try {
      let req = request;
      let refreshedCookies = [];
      const u0 = new URL(request.url);
      if (u0.pathname.startsWith("/admin") && u0.pathname !== "/admin/login" && u0.pathname !== "/admin/logout") {
        if (!await isAdmin(request, env)) {
          const r = await tryRefresh(request, env);
          if (r) {
            req = r.request;
            refreshedCookies = r.cookies;
          }
        }
      }
      let res = await handleFetch(req, env);
      if (refreshedCookies.length) {
        const h = new Headers(res.headers);
        for (const c of refreshedCookies) h.append("set-cookie", c);
        res = new Response(res.body, { status: res.status, headers: h });
      }
      if (u0.pathname.startsWith("/admin") || u0.pathname.startsWith("/akun")) {
        const h = new Headers(res.headers);
        h.set("cache-control", "no-store");
        res = new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    } catch (e) {
      const theme = themes.terang;
      const maintenance = `<div class="card"><h2>Under Maintenance</h2><p>This site is currently under maintenance. We'll be back soon.</p><p>Please check back later.</p></div>`;
      return html(theme.render({ siteTitle: "Hozin King", pageTitle: "Under Maintenance", content: maintenance }), 503);
    }
  }
};
async function handleFetch(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  let nowIso = (/* @__PURE__ */ new Date()).toISOString();
  if (request.method === "POST") {
    const cl = Number(request.headers.get("content-length") || "0");
    if (cl > 2e5) {
      return html(themes.terang.render({ siteTitle: "Hozin King", pageTitle: "Terlalu besar", content: '<div class="card"><p>Data yang dikirim terlalu besar (maks 200 KB).</p></div>' }), 413);
    }
  }
  await ensureSchema(env);
  nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const admin = await isAdmin(request, env);
  const commenter = admin ? null : await getCommenter(request, env);
  if (request.method === "GET" && path === "/") {
    const rows = await env.DB.prepare(`SELECT * FROM cms_posts WHERE status = 'published' AND visibility = 'public' AND publish_at <= ? ORDER BY publish_at DESC`).bind(nowIso).all();
    const plugins = await getEnabledPlugins(env);
    const posts = rows.results || [];
    const content = posts.length ? posts.map((p) => postCard(p, plugins)).join("") : '<div class="card"><p>Belum ada post.</p></div>';
    return html(await renderPage(env, "Beranda", content));
  }
  const unlockMatch = path.match(/^\/p\/([A-Za-z0-9-]+)\/unlock$/);
  if (unlockMatch && request.method === "POST") {
    const slug = unlockMatch[1];
    const meta = await env.DB.prepare(`SELECT id, slug, visibility, publish_at, post_password_hash, post_password_salt FROM cms_posts WHERE slug = ?`).bind(slug).first();
    if (!meta || meta.visibility !== "password") return redirect(`/p/${slug}`);
    const ip = clientIp(request);
    if (!await checkRateLimit(env, "unlock:" + ip + ":" + meta.id, 5, 15 * 60 * 1e3)) {
      return html(await renderPage(env, "Post Terkunci", '<div class="card"><p>Terlalu banyak percobaan. Coba lagi 15 menit.</p><p><a href="/p/' + esc(slug) + '">Kembali</a></p></div>'), 429);
    }
    const form = await request.formData();
    const pw = String(form.get("password") || "");
    const ok = meta.post_password_salt && meta.post_password_hash && await verifyPassword(pw, meta.post_password_salt, meta.post_password_hash);
    if (!ok) {
      return html(await renderPage(env, "Post Terkunci", '<div class="card"><h2>Post Terkunci</h2><p>Password salah.</p><form method="post" action="/p/' + esc(slug) + '/unlock"><label>Password</label><input type="password" name="password" required><button type="submit">Buka</button></form></div>'), 403);
    }
    const cookie = await postUnlockCookie(env, meta.id);
    const headers = new Headers({ location: `/p/${slug}` });
    headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  }
  const postMatch = path.match(/^\/p\/([A-Za-z0-9-]+)(?:\/comment)?$/);
  if (postMatch) {
    const slug = postMatch[1];
    if (request.method === "GET") {
      const meta = await env.DB.prepare(`SELECT id, slug, visibility, publish_at, post_password_hash, post_password_salt FROM cms_posts WHERE slug = ?`).bind(slug).first();
      if (!meta) return html(await renderPage(env, "Tidak ditemukan", '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
      const scheduled = isScheduled(meta, nowIso);
      if (meta.visibility === "private" && !admin) return html(await renderPage(env, "Tidak ditemukan", '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
      if (scheduled && !admin) return html(await renderPage(env, "Tidak ditemukan", '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
      if (meta.visibility === "password" && !admin && !await isPostUnlocked(request, env, meta.id)) {
        const content2 = '<div class="card"><h2>Post Terkunci</h2><p>Post ini dilindungi password. Masukkan password untuk membukanya.</p><form method="post" action="/p/' + esc(slug) + '/unlock"><label>Password</label><input type="password" name="password" required><button type="submit">Buka</button></form></div>';
        return html(await renderPage(env, "Post Terkunci", content2));
      }
      const post = await env.DB.prepare(`SELECT * FROM cms_posts WHERE slug = ?`).bind(slug).first();
      if (!post || post.status !== "published") return html(await renderPage(env, "Tidak ditemukan", '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
      let viewCookie = null;
      if (!admin) {
        const viewName = "cms_view_" + String(post.id).replace(/[^A-Za-z0-9_-]/g, "_");
        if (!parseCookies(request)[viewName]) {
          await env.DB.prepare(`UPDATE cms_posts SET views = views + 1 WHERE id = ?`).bind(post.id).run();
          post.views = (Number(post.views) || 0) + 1;
          viewCookie = viewName + "=1; Path=/; Max-Age=86400";
        }
      }
      const plugins = await getEnabledPlugins(env);
      const comments = await env.DB.prepare(`SELECT * FROM cms_comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC`).bind(post.id).all();
      const rel = await env.DB.prepare(`SELECT * FROM cms_posts WHERE category = ? AND status = 'published' AND visibility = 'public' AND publish_at <= ? ORDER BY publish_at DESC`).bind(post.category, nowIso).all();
      const metaHtml = plugins.map((p) => p.postMeta ? p.postMeta(post) : "").join("");
      const footers = plugins.map((p) => p.postFooter ? p.postFooter(post, { related: rel.results || [], baseUrl: url.origin }) : "").join("");
      const notice = url.searchParams.get("komentar") === "menunggu" ? '<div class="card"><p>Komentar dikirim, menunggu persetujuan admin.</p></div>' : "";
      const voteRows = await env.DB.prepare(`SELECT comment_id, vote, COUNT(*) AS n FROM cms_comment_votes GROUP BY comment_id, vote`).all();
      const votes = /* @__PURE__ */ new Map();
      for (const vr of voteRows.results || []) {
        const cur = votes.get(vr.comment_id) || { like: 0, dislike: 0 };
        if (Number(vr.vote) === 1) cur.like = Number(vr.n);
        else cur.dislike = Number(vr.n);
        votes.set(vr.comment_id, cur);
      }
      const myKey = admin ? "admin" : commenter ? "u:" + commenter.id : null;
      const myVotes = /* @__PURE__ */ new Map();
      if (myKey) {
        const myRows = await env.DB.prepare(`SELECT comment_id, vote FROM cms_comment_votes WHERE user_key = ?`).bind(myKey).all();
        for (const mr of myRows.results || []) myVotes.set(mr.comment_id, Number(mr.vote));
      }
      const canReply = Boolean(admin || commenter);
      const csrfForComment = admin ? await csrfToken(env) : commenter ? await userCsrf(env, commenter.id) : "";
      const commentHtml = renderCommentsTree(comments.results || [], votes, myVotes, csrfForComment, canReply, slug);
      const commentForm = canReply ? `<form method="post" action="/p/${esc(slug)}/comment"><input type="hidden" name="csrf" value="${csrfForComment}"><label>Komentar sebagai ${admin ? "Admin" : esc(commenter.username)}</label><textarea name="text" maxlength="2000" required></textarea><button type="submit">Kirim Komentar</button></form>` : `<div class="card"><p>Untuk berkomentar, login dulu atau buat akun.</p><p><a href="/akun">Login / Daftar Akun</a></p></div>`;
      const previewBanner = admin && (scheduled || meta.visibility !== "public") ? `<div class="card"><p>Pratinjau admin: ${esc(visibilityLabel(post, nowIso))}${scheduled ? " \xB7 terbit " + esc(String(post.publish_at).slice(0, 16)) : ""}</p></div>` : "";
      const views = Number(post.views) || 0;
      const bodyHtml = post.body_mode === "html" ? sanitizeHtml(post.body) : para(post.body);
      const content = `${previewBanner}<article class="card"><h2>${esc(post.title)}</h2><p class="meta">${esc(post.category)} \xB7 ${esc(String(post.created_at || "").slice(0, 10))} \xB7 \u{1F441} ${views}${metaHtml}</p>${bodyHtml}</article>${footers}<h3>Komentar</h3>${commentHtml}${notice}${commentForm}`;
      const res = html(await renderPage(env, post.title, content));
      if (viewCookie) {
        const h = new Headers(res.headers);
        h.append("set-cookie", viewCookie);
        return new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    }
    if (request.method === "POST" && path.endsWith("/comment")) {
      if (!admin && !commenter) return redirect("/akun?pesan=login");
      const meta = await env.DB.prepare(`SELECT id, slug, visibility, publish_at FROM cms_posts WHERE slug = ?`).bind(slug).first();
      if (!meta) return redirect("/");
      if (meta.visibility === "private" && !admin) return redirect("/");
      if (isScheduled(meta, nowIso) && !admin) return redirect("/");
      const form = await request.formData();
      if (String(form.get("website") || "").trim()) return redirect(`/p/${slug}?komentar=menunggu`);
      const csrfNeed = admin ? await csrfToken(env) : await userCsrf(env, commenter.id);
      if (String(form.get("csrf") || "") !== csrfNeed) {
        return html(await renderPage(env, "Komentar", '<div class="card"><p>Token tidak valid. Muat ulang halaman lalu coba lagi.</p></div>'), 403);
      }
      const ip = clientIp(request);
      if (!await checkRateLimit(env, "comment:" + ip, 5, 10 * 60 * 1e3)) {
        return html(await renderPage(env, "Komentar", '<div class="card"><p>Terlalu banyak komentar. Coba lagi beberapa menit.</p></div>'), 429);
      }
      const text = String(form.get("text") || "").trim().slice(0, 2e3);
      const parentRaw = Number(form.get("parent_id") || 0);
      let parentId = null;
      if (parentRaw) {
        const parent = await env.DB.prepare(`SELECT id, post_id FROM cms_comments WHERE id = ?`).bind(parentRaw).first();
        if (parent && String(parent.post_id) === String(meta.id)) parentId = parentRaw;
      }
      if (text) {
        const name = admin ? "Admin" : commenter.username;
        const status = admin ? "approved" : "pending";
        await env.DB.prepare(`INSERT INTO cms_comments (post_id, name, text, status, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?)`).bind(meta.id, name, text, status, (/* @__PURE__ */ new Date()).toISOString(), parentId).run();
      }
      return redirect(`/p/${slug}?komentar=menunggu`);
    }
  }
  const voteMatch = path.match(/^\/p\/([A-Za-z0-9-]+)\/comment\/vote$/);
  if (voteMatch && request.method === "POST") {
    const slug = voteMatch[1];
    if (!admin && !commenter) return redirect("/akun?pesan=login");
    const form = await request.formData();
    const csrfNeed = admin ? await csrfToken(env) : await userCsrf(env, commenter.id);
    if (String(form.get("csrf") || "") !== csrfNeed) {
      return html(await renderPage(env, "Komentar", '<div class="card"><p>Token tidak valid.</p></div>'), 403);
    }
    const myKey = admin ? "admin" : "u:" + commenter.id;
    if (!await checkRateLimit(env, "vote:" + myKey, 30, 10 * 60 * 1e3)) {
      return html(await renderPage(env, "Komentar", '<div class="card"><p>Terlalu banyak vote. Coba lagi nanti.</p></div>'), 429);
    }
    const commentId = Number(form.get("comment_id") || 0);
    const vote = Number(form.get("vote") || 0);
    const meta = await env.DB.prepare(`SELECT id FROM cms_posts WHERE slug = ?`).bind(slug).first();
    const comment = commentId ? await env.DB.prepare(`SELECT id, post_id FROM cms_comments WHERE id = ?`).bind(commentId).first() : null;
    if (meta && comment && String(comment.post_id) === String(meta.id) && (vote === 1 || vote === -1)) {
      const existing = await env.DB.prepare(`SELECT vote FROM cms_comment_votes WHERE comment_id = ? AND user_key = ?`).bind(commentId, myKey).first();
      if (existing && Number(existing.vote) === vote) {
        await env.DB.prepare(`DELETE FROM cms_comment_votes WHERE comment_id = ? AND user_key = ?`).bind(commentId, myKey).run();
      } else if (existing) {
        await env.DB.prepare(`UPDATE cms_comment_votes SET vote = ? WHERE comment_id = ? AND user_key = ?`).bind(vote, commentId, myKey).run();
      } else {
        await env.DB.prepare(`INSERT INTO cms_comment_votes (comment_id, user_key, vote) VALUES (?, ?, ?)`).bind(commentId, myKey, vote).run();
      }
    }
    return redirect(`/p/${slug}`);
  }
  if (path === "/akun" && request.method === "GET") {
    if (admin) {
      return html(await renderPage(env, "Akun", '<div class="card"><p>Kamu login sebagai Admin. Admin tidak perlu akun komentator.</p><p><a href="/admin">Ke dashboard admin</a></p></div>'));
    }
    if (commenter) {
      return html(await renderPage(env, "Akun", `<div class="card"><h2>Akun Saya</h2><p>Login sebagai <b>${esc(commenter.username)}</b>.</p><form method="post" action="/akun/logout"><button type="submit">Keluar</button></form></div>`));
    }
    const pesan = url.searchParams.get("pesan") === "login" ? '<div class="card"><p>Login dulu atau buat akun untuk berkomentar.</p></div>' : "";
    const content = `${pesan}<div class="card"><h2>Login</h2><form method="post" action="/akun/login"><label>Nama pengguna</label><input name="username" maxlength="20" required><label>Password</label><input type="password" name="password" required><button type="submit">Masuk</button></form></div><div class="card"><h2>Buat Akun</h2><p>Akun hanya untuk berkomentar dan like/dislike. Bukan akun admin, tidak bisa membuat post atau membuka dashboard.</p><form method="post" action="/akun/daftar"><label>Nama pengguna (huruf kecil, angka, garis bawah, 3\u201320 karakter)</label><input name="username" maxlength="20" required><label>Password (minimal 8 karakter)</label><input type="password" name="password" required><button type="submit">Daftar</button></form></div>`;
    return html(await renderPage(env, "Akun", content));
  }
  if (path === "/akun/daftar" && request.method === "POST") {
    const ip = clientIp(request);
    if (!await checkRateLimit(env, "akun:" + ip, 5, 15 * 60 * 1e3)) {
      return html(await renderPage(env, "Akun", '<div class="card"><p>Terlalu banyak percobaan. Coba lagi 15 menit.</p></div>'), 429);
    }
    const form = await request.formData();
    const username = String(form.get("username") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    if (!/^[a-z0-9_]{3,20}$/.test(username) || password.length < 8) {
      return html(await renderPage(env, "Akun", '<div class="card"><p>Nama pengguna atau password tidak valid. Nama: 3\u201320 karakter (huruf kecil, angka, _). Password: minimal 8 karakter.</p><p><a href="/akun">Kembali</a></p></div>'), 400);
    }
    const clash = await env.DB.prepare(`SELECT id FROM cms_users WHERE username = ?`).bind(username).first();
    if (clash) {
      return html(await renderPage(env, "Akun", '<div class="card"><p>Nama pengguna sudah dipakai.</p><p><a href="/akun">Kembali</a></p></div>'), 409);
    }
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    const id = "u-" + Date.now().toString(36);
    await env.DB.prepare(`INSERT INTO cms_users (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, username, hash, salt, (/* @__PURE__ */ new Date()).toISOString()).run();
    const cookie = await userSessionCookie(env, id);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  }
  if (path === "/akun/login" && request.method === "POST") {
    const ip = clientIp(request);
    if (!await checkRateLimit(env, "akun:" + ip, 5, 15 * 60 * 1e3)) {
      return html(await renderPage(env, "Akun", '<div class="card"><p>Terlalu banyak percobaan. Coba lagi 15 menit.</p></div>'), 429);
    }
    const form = await request.formData();
    const username = String(form.get("username") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    const user = await env.DB.prepare(`SELECT * FROM cms_users WHERE username = ?`).bind(username).first();
    const ok = user && await verifyPassword(password, user.salt, user.password_hash);
    if (!ok) {
      return html(await renderPage(env, "Akun", '<div class="card"><p>Nama pengguna atau password salah.</p><p><a href="/akun">Kembali</a></p></div>'), 403);
    }
    const cookie = await userSessionCookie(env, user.id);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", cookie);
    return new Response(null, { status: 303, headers });
  }
  if (path === "/akun/logout" && request.method === "POST") {
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", "cms_user=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return new Response(null, { status: 303, headers });
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
      const remember = form.get("remember") === "1";
      const cookies = await issueTokens(env, request, remember);
      return redirectWithCookies("/admin", [...cookies, "cms_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"]);
    }
    await env.DB.prepare(`INSERT INTO cms_login_attempts (ip, created_at) VALUES (?, ?)`).bind(ip, (/* @__PURE__ */ new Date()).toISOString()).run();
    return html(await renderPage(env, "Admin", '<div class="card"><p>Password salah.</p><p><a href="/admin">Kembali</a></p></div>'), 403);
  }
  if (path === "/admin/logout" && request.method === "POST") {
    const form = await request.formData();
    if (String(form.get("csrf") || "") !== await csrfToken(env)) {
      return html(await renderPage(env, "Admin", '<div class="card"><p>Token CSRF tidak valid.</p></div>'), 403);
    }
    const row = await getRefreshRow(request, env);
    if (row) await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1 WHERE id = ?`).bind(row.id).run();
    return redirectWithCookies("/admin", clearAuthCookies());
  }
  if (path === "/admin") {
    if (request.method === "GET") {
      if (!admin) {
        return html(await renderPage(env, "Admin", '<div class="card"><h2>Login Admin</h2><form method="post" action="/admin/login"><label>Password admin</label><input type="password" name="password" required><label><input type="checkbox" name="remember" value="1"> Ingat saya di perangkat ini (refresh 30 hari, tanpa ini 1 hari)</label><p>Token akses berlaku 1 jam dan diperpanjang otomatis selama refresh masih sah.</p><button type="submit">Masuk</button></form></div>'));
      }
      const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at DESC`).all();
      const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at DESC`).all();
      const themeId = await getSetting(env, "theme", "terang");
      const siteTitle = await getSetting(env, "site_title", "Hozin King");
      const pluginRows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
      const pMap = new Map((pluginRows.results || []).map((r) => [r.id, Number(r.enabled)]));
      const csrf = await csrfToken(env);
      const csrfField = `<input type="hidden" name="csrf" value="${csrf}">`;
      const postRows = (posts.results || []).map((p) => `<div class="card"><b>${esc(p.title)}</b> (${esc(visibilityLabel(p, (/* @__PURE__ */ new Date()).toISOString()))} \xB7 \u{1F441} ${Number(p.views) || 0} \xB7 ${esc(p.body_mode || "text")})<form method="post" action="/admin/posts/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(p.id)}"><button type="submit">Hapus</button></form></div>`).join("");
      const users = await env.DB.prepare(`SELECT * FROM cms_users ORDER BY created_at DESC`).all();
      const userRows = (users.results || []).map((u) => `<div class="card"><b>${esc(u.username)}</b> \xB7 sejak ${esc(String(u.created_at || "").slice(0, 10))}<form method="post" action="/admin/users/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(u.id)}"><button type="submit">Hapus Akun</button></form></div>`).join("") || "<p>Belum ada akun komentator.</p>";
      const postError = new URL(request.url).searchParams.get("error") === "password" ? '<div class="card"><p>Password post minimal 8 karakter, post tidak dibuat.</p></div>' : "";
      const commentRows = (comments.results || []).map((c) => `<div class="card"><b>${esc(c.name)}</b> [${esc(c.status)}]<p>${esc(c.text)}</p><form method="post" action="/admin/comments/approve" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Setujui</button></form> <form method="post" action="/admin/comments/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Hapus</button></form></div>`).join("");
      const themeOptions = Object.entries(themes).map(([id, t]) => `<option value="${id}" ${id === themeId ? "selected" : ""}>${esc(t.name)}</option>`).join("");
      const pluginForms = pluginDefs.map((p) => `<div class="card"><b>${esc(p.name)}</b> \u2014 ${esc(p.description)}<form method="post" action="/admin/plugins/toggle">${csrfField}<input type="hidden" name="id" value="${p.id}"><input type="hidden" name="enabled" value="${pMap.get(p.id) === 0 ? "1" : "0"}"><button type="submit">${pMap.get(p.id) === 0 ? "Aktifkan" : "Nonaktifkan"}</button></form></div>`).join("");
      const backupRuns = await env.DB.prepare(`SELECT * FROM cms_backup_runs ORDER BY created_at DESC LIMIT 10`).all();
      const backupRows = (backupRuns.results || []).map((r) => `<div class="card"><b>${esc(r.status)}</b> \xB7 ${esc(r.created_at)} \xB7 ${r.posts} post, ${r.comments} komentar${r.error ? `<p>Error: ${esc(r.error)}</p>` : ""}</div>`).join("") || "<p>Belum ada backup.</p>";
      const backupCard = `<div class="card"><h3>Backup ke Stopwatch</h3><p>Database stopwatch khusus dipakai sebagai tempat backup CMS. Salinan tidak pernah ditulis dari jalur lain \u2014 hanya tombol ini yang menulis ke sana.</p><form method="post" action="/admin/backup">${csrfField}<button type="submit">Buat Backup Sekarang</button></form><h4>Riwayat Backup</h4>${backupRows}</div>`;
      const nowIso2 = (/* @__PURE__ */ new Date()).toISOString();
      const sessionRows = await env.DB.prepare(`SELECT id, device, ip, created_at, last_used_at, expires_at FROM cms_refresh_tokens WHERE revoked = 0 AND expires_at > ? ORDER BY last_used_at DESC`).bind(nowIso2).all();
      const currentRefresh = await getRefreshRow(request, env);
      const sessionRowsHtml = (sessionRows.results || []).map((s) => `<div class="card"><b>${esc(s.device || "Perangkat")}</b> \xB7 ${esc(s.ip)} \xB7 terakhir ${esc(s.last_used_at)} \xB7 sampai ${esc(s.expires_at)}${currentRefresh && s.id === currentRefresh.id ? " \xB7 <b>(perangkat ini)</b>" : ""}<form method="post" action="/admin/sessions/revoke" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(s.id)}"><button type="submit">Cabut</button></form></div>`).join("") || "<p>Tidak ada sesi aktif.</p>";
      const sessionsCard = `<div class="card"><h3>Sesi & Perangkat</h3><p>Token akses berlaku 1 jam, diperpanjang otomatis oleh token refresh. Refresh yang sudah diputar lalu dipakai lagi akan mencabut semua sesi (tanda token dicuri).</p><form method="post" action="/admin/logout-all">${csrfField}<button type="submit">Keluar dari Semua Perangkat</button></form><h4>Sesi aktif</h4>${sessionRowsHtml}</div>`;
      const editorCard = `<div class="card"><h3>Post Baru</h3><p><button type="button" id="modeTextBtn">Teks Biasa</button> <button type="button" id="modeBlocksBtn">Blok Mudah (drag &amp; drop)</button> <button type="button" id="modeHtmlBtn">HTML</button></p><form method="post" action="/admin/posts" id="postForm">${csrfField}<input type="hidden" name="body_mode" id="postMode" value="text"><input type="hidden" name="publish_at_iso" id="publishAtIso"><label>Judul</label><input name="title" required><label>Kategori</label><input name="category" value="Umum"><label>Visibilitas</label><select name="visibility" id="visSelect"><option value="public">Publik (beranda + link)</option><option value="private">Private (hanya admin)</option><option value="unlisted">Link saja (tidak di beranda)</option><option value="password">Password (link + password)</option></select><div id="pwWrap" style="display:none"><label>Password post (minimal 8 karakter)</label><input type="password" name="post_password"></div><label>Terbit pada (kosong = sekarang, isi = terjadwal)</label><input type="datetime-local" id="publishAt"><div id="edText"><label>Isi</label><textarea name="body" id="bodyText"></textarea></div><div id="edHtml" style="display:none"><label>Kode HTML</label><textarea id="htmlBody" placeholder="&lt;p&gt;Tulis HTML di sini&lt;/p&gt;"></textarea><p>Tag script, iframe, dan atribut onclick dibuang otomatis saat disimpan.</p></div><div id="edBlocks" style="display:none"><p>Tambah blok:</p><p><button type="button" id="addParaBtn">Paragraf</button> <button type="button" id="addJudulBtn">Judul</button> <button type="button" id="addDaftarBtn">Daftar</button> <button type="button" id="addKutipanBtn">Kutipan</button> <button type="button" id="addGambarBtn">Gambar</button> <button type="button" id="addVideoBtn">Video</button> <button type="button" id="addAudioBtn">Audio</button></p><div id="blocks"></div><p>Di HP, pakai tombol Naik / Turun untuk memindah blok. Di PC, blok bisa ditarik pakai mouse.</p></div><button type="submit">Terbitkan</button></form><script>var edMode='text';var dragged=null;function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}function showMode(m){edMode=m;document.getElementById('postMode').value=m;document.getElementById('edText').style.display=(m==='text'?'block':'none');document.getElementById('edHtml').style.display=(m==='html'?'block':'none');document.getElementById('edBlocks').style.display=(m==='blocks'?'block':'none');if(m==='blocks'&&document.getElementById('blocks').children.length===0){addBlock('paragraf')}}document.getElementById('modeTextBtn').onclick=function(){showMode('text')};document.getElementById('modeBlocksBtn').onclick=function(){showMode('blocks')};document.getElementById('modeHtmlBtn').onclick=function(){showMode('html')};document.getElementById('visSelect').onchange=function(){document.getElementById('pwWrap').style.display=(this.value==='password'?'block':'none')};function blockLabel(t){if(t==='paragraf')return 'Paragraf';if(t==='judul')return 'Judul';if(t==='daftar')return 'Daftar';if(t==='kutipan')return 'Kutipan';if(t==='gambar')return 'Gambar';if(t==='video')return 'Video';return 'Audio'}function blockField(t){if(t==='gambar')return '<label>Link gambar (https://...)</label><input class="blockUrl" placeholder="https://..."><label>Teks alt (opsional)</label><input class="blockAlt">';if(t==='video')return '<label>Link video langsung MP4/WebM (bukan link YouTube)</label><input class="blockUrl" placeholder="https://..."><label>Link poster (opsional)</label><input class="blockPoster">';if(t==='audio')return '<label>Link audio MP3 (https://...)</label><input class="blockUrl" placeholder="https://...">';if(t==='daftar')return '<label>Satu baris per item</label><textarea class="blockText"></textarea>';return '<label>Isi</label><textarea class="blockText"></textarea>'}function addBlock(t){var d=document.createElement('div');d.className='card block';d.draggable=true;d.setAttribute('data-type',t);d.innerHTML='<p><b>\u2630 '+blockLabel(t)+'</b></p>'+blockField(t)+'<p><button type="button" class="upBtn">Naik</button> <button type="button" class="downBtn">Turun</button> <button type="button" class="delBtn">Hapus</button></p>';d.querySelector('.upBtn').onclick=function(){var p=d.previousElementSibling;if(p){d.parentNode.insertBefore(d,p)}};d.querySelector('.downBtn').onclick=function(){var n=d.nextElementSibling;if(n){d.parentNode.insertBefore(n,d)}};d.querySelector('.delBtn').onclick=function(){d.remove()};d.addEventListener('dragstart',function(e){dragged=d;e.dataTransfer.setData('text/plain','x')});d.addEventListener('dragover',function(e){e.preventDefault()});d.addEventListener('drop',function(e){e.preventDefault();var c=document.getElementById('blocks');if(dragged&&dragged!==d){c.insertBefore(dragged,d)}});document.getElementById('blocks').appendChild(d)}document.getElementById('addParaBtn').onclick=function(){addBlock('paragraf')};document.getElementById('addJudulBtn').onclick=function(){addBlock('judul')};document.getElementById('addDaftarBtn').onclick=function(){addBlock('daftar')};document.getElementById('addKutipanBtn').onclick=function(){addBlock('kutipan')};document.getElementById('addGambarBtn').onclick=function(){addBlock('gambar')};document.getElementById('addVideoBtn').onclick=function(){addBlock('video')};document.getElementById('addAudioBtn').onclick=function(){addBlock('audio')};function safeU(u){u=String(u||'').trim();if(u.indexOf('http://')===0||u.indexOf('https://')===0){return u}return ''}function collectBlocks(){var out='';var kids=document.getElementById('blocks').children;for(var i=0;i<kids.length;i++){var b=kids[i];var ty=b.getAttribute('data-type');var ta=b.querySelector('.blockText');var txt=ta?ta.value:'';if(ty==='paragraf'){out+='<p>'+escH(txt).replace(/
/g,'<br>')+'</p>'}else if(ty==='judul'){out+='<h2>'+escH(txt)+'</h2>'}else if(ty==='daftar'){var items=txt.split('
');out+='<ul>';for(var j=0;j<items.length;j++){if(items[j].trim()){out+='<li>'+escH(items[j])+'</li>'}}out+='</ul>'}else if(ty==='kutipan'){out+='<blockquote><p>'+escH(txt).replace(/
/g,'<br>')+'</p></blockquote>'}else if(ty==='gambar'){var u=safeU(b.querySelector('.blockUrl').value);var alt=b.querySelector('.blockAlt').value;if(u){out+='<figure><img src="'+escH(u)+'" alt="'+escH(alt)+'" /></figure>'}}else if(ty==='video'){var vu=safeU(b.querySelector('.blockUrl').value);var po=safeU(b.querySelector('.blockPoster').value);if(vu){out+='<video controls preload="metadata" src="'+escH(vu)+'"'+(po?' poster="'+escH(po)+'"':'')+'></video>'}}else if(ty==='audio'){var au=safeU(b.querySelector('.blockUrl').value);if(au){out+='<audio controls preload="metadata" src="'+escH(au)+'"></audio>'}}}return out}document.getElementById('postForm').addEventListener('submit',function(){var dt=document.getElementById('publishAt');if(dt&&dt.value){document.getElementById('publishAtIso').value=new Date(dt.value).toISOString()}if(edMode==='html'){document.getElementById('bodyText').value=document.getElementById('htmlBody').value}else if(edMode==='blocks'){document.getElementById('bodyText').value=collectBlocks()}});<\/script></div>`;
      const content = `<h2>Dashboard Admin</h2><p>Peran: <b>Super-Super-Admin (satu-satunya)</b> \u2014 tidak ada akun admin lain. Akun komentator di bawah bukan akun admin.</p>${postError}<form method="post" action="/admin/logout">${csrfField}<button type="submit">Keluar</button></form>${backupCard}${sessionsCard}<div class="card"><h3>Pengaturan</h3><form method="post" action="/admin/settings">${csrfField}<label>Judul situs</label><input name="site_title" value="${esc(siteTitle)}"><label>Tema</label><select name="theme">${themeOptions}</select><button type="submit">Simpan Pengaturan</button></form></div>${editorCard}<h3>Post</h3>${postRows}<h3>Komentar</h3>${commentRows}<h3>Akun Komentator</h3>${userRows}<h3>Plugin</h3>${pluginForms}`;
      return html(await renderPage(env, "Admin", content));
    }
  }
  if (admin && request.method === "POST") {
    const form = await request.formData();
    if (String(form.get("csrf") || "") !== await csrfToken(env)) {
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
    if (path === "/admin/logout-all") {
      await revokeAllRefresh(env);
      return redirectWithCookies("/admin", clearAuthCookies());
    }
    if (path === "/admin/sessions/revoke") {
      const id = String(form.get("id") || "");
      const current = await getRefreshRow(request, env);
      await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1 WHERE id = ?`).bind(id).run();
      if (current && current.id === id) return redirectWithCookies("/admin", clearAuthCookies());
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
      const title = String(form.get("title") || "").trim().slice(0, 200);
      let body = String(form.get("body") || "").trim();
      const category = String(form.get("category") || "Umum").trim().slice(0, 80) || "Umum";
      const bodyMode = String(form.get("body_mode") || "text") === "html" ? "html" : "text";
      const visibilityRaw = String(form.get("visibility") || "public");
      const visibility = ["public", "private", "unlisted", "password"].includes(visibilityRaw) ? visibilityRaw : "public";
      const now = (/* @__PURE__ */ new Date()).toISOString();
      let publishAt = now;
      const publishRaw = String(form.get("publish_at_iso") || form.get("publish_at") || "");
      if (publishRaw) {
        const d = new Date(publishRaw);
        if (!isNaN(d.getTime())) publishAt = d.toISOString();
      }
      let pwHash = "";
      let pwSalt = "";
      if (visibility === "password") {
        const pw = String(form.get("post_password") || "");
        if (pw.length < 8) return redirect("/admin?error=password");
        pwSalt = randomHex(16);
        pwHash = await hashPassword(pw, pwSalt);
      }
      if (bodyMode === "html") body = sanitizeHtml(body).slice(0, 1e5);
      else body = body.slice(0, 5e4);
      if (title && body) {
        const id = "p-" + Date.now().toString(36);
        let slug = slugify(title);
        const clash = await env.DB.prepare(`SELECT id FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (clash) slug = slug + "-" + Date.now().toString(36).slice(-4);
        await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, 0)`).bind(id, slug, title, body, category, now, now, bodyMode, visibility, publishAt, pwHash, pwSalt).run();
      }
      return redirect("/admin");
    }
    if (path === "/admin/users/delete") {
      await env.DB.prepare(`DELETE FROM cms_users WHERE id = ?`).bind(String(form.get("id") || "")).run();
      return redirect("/admin");
    }
    if (path === "/admin/posts/delete") {
      const postId = String(form.get("id") || "");
      const cmts = await env.DB.prepare(`SELECT id FROM cms_comments WHERE post_id = ?`).bind(postId).all();
      for (const cm of cmts.results || []) {
        await env.DB.prepare(`DELETE FROM cms_comment_votes WHERE comment_id = ?`).bind(cm.id).run();
      }
      await env.DB.prepare(`DELETE FROM cms_comments WHERE post_id = ?`).bind(postId).run();
      await env.DB.prepare(`DELETE FROM cms_posts WHERE id = ?`).bind(postId).run();
      return redirect("/admin");
    }
    if (path === "/admin/comments/approve") {
      await env.DB.prepare(`UPDATE cms_comments SET status = 'approved' WHERE id = ?`).bind(Number(form.get("id"))).run();
      return redirect("/admin");
    }
    if (path === "/admin/comments/delete") {
      const cid = Number(form.get("id"));
      await env.DB.prepare(`DELETE FROM cms_comment_votes WHERE comment_id = ?`).bind(cid).run();
      await env.DB.prepare(`DELETE FROM cms_comments WHERE id = ?`).bind(cid).run();
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
export {
  worker_default as default
};
