// Fitur sosial Cerpen Hozin (CMS v87.3, 14 Nov 2026) — view + like +
// dislike + report per konten, + statistik ala YouTube Studio (admin).
//
// Kontrak API (frozen): kind ∈ {cerpen, komik, berita}; ref cerpen =
// "series:season:no", komik = "komik:no", berita = id baris cerpen_news.
// Tabel sosial tinggal di D1 cms-db (env.DB); keberadaan konten dicek di
// D1 stopwatch-db (env.BACKUP_DB: cerpen_episodes /
// cerpen_komik_episodes / cerpen_news) — SAMA seperti endpoint konten
// Cerpen lain. Hari = tanggal WIB (UTC+7).
//
// Aturan kunci (dari kontrak): view 1× per viewer-key per hari WIB;
// like boleh guest (kunci device) atau login (kunci user); dislike WAJIB
// sesi akun valid (401 login_required); vote sama 2× = batalkan, ganti
// 1↔-1 diizinkan; report guest boleh, maks 1 per (kind, ref,
// reporter_key) per hari + maks 10 per reporter_key per hari (429
// already_reported). Dislike count DIKEMBALIKAN server — aplikasi yang
// menyembunyikannya, bukan server.
//
// Sesi akun: cookie cms_user (getCommenter) ATAU header Authorization:
// Bearer <nilai sesi yang sama dengan yang dikembalikan login aplikasi>
// (format userId.exp.sig, HMAC seperti cookie). Statistik admin hanya
// dari data yang ada — tanpa demografi / traffic source / perangkat.
import { esc, clientIp, randomHex, hmacHex } from './util.js';
import { getCommenter, csrfToken } from './auth.js';
import { checkRateLimit } from './security.js';

const aj = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const CATEGORIES = ['typo', 'gambar', 'tidak_pantas', 'lainnya'];
const REPORT_STATUSES = ['baru', 'ditangani', 'ditolak'];
const STATS_CACHE_MS = 5 * 60 * 1000; // agregasi statistik di-cache 5 menit

function wibDay(ms) { return new Date(Number(ms || 0) + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function wibText(ms) { const n = Number(ms || 0); const t = (n > 0 && n < 1e12) ? n * 1000 : n; return new Date(t + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16); }
const isId = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);

async function readJsonBody(request) {
  let raw = '';
  try { raw = await request.text(); } catch (e) { return { err: 'body tidak bisa dibaca' }; }
  if (raw.length > 100 * 1024) return { err: 'body terlalu besar (maks 100 KB)' };
  if (!raw.trim()) return { body: {} };
  try { return { body: JSON.parse(raw) }; } catch (e) { return { err: 'body JSON tidak valid' }; }
}

// Uraikan ref sesuai kind; null = format salah.
function parseRef(kind, ref) {
  const r = String(ref || '');
  if (kind === 'cerpen') {
    const m = /^([A-Za-z0-9_-]{1,64}):(\d{1,2}):(\d{1,4})$/.exec(r);
    if (!m) return null;
    const season = Number(m[2]); const no = Number(m[3]);
    if (season < 1 || season > 99 || no < 1 || no > 9999) return null;
    return { series: m[1], season, no };
  }
  if (kind === 'komik') {
    const m = /^([A-Za-z0-9_-]{1,64}):(\d{1,4})$/.exec(r);
    if (!m) return null;
    const no = Number(m[2]);
    if (no < 1 || no > 9999) return null;
    return { komik: m[1], no };
  }
  if (kind === 'berita') return isId(r) ? { id: r } : null;
  return null;
}

// Konten harus benar-benar ada di D1 stopwatch-db (BACKUP_DB).
async function contentExists(env, kind, p) {
  if (!env.BACKUP_DB) return false;
  const B = env.BACKUP_DB;
  if (kind === 'cerpen') return !!(await B.prepare(`SELECT series_id FROM cerpen_episodes WHERE series_id = ? AND season = ? AND no = ?`).bind(p.series, p.season, p.no).first());
  if (kind === 'komik') return !!(await B.prepare(`SELECT komik_id FROM cerpen_komik_episodes WHERE komik_id = ? AND no = ?`).bind(p.komik, p.no).first());
  return !!(await B.prepare(`SELECT id, title, summary, topic FROM cerpen_news WHERE id = ?`).bind(p.id).first());
}

// Sesi akun dari cookie ATAU Bearer (nilai sesi aplikasi).
async function resolveSocialUser(request, env) {
  const fromCookie = await getCommenter(request, env);
  if (fromCookie) return fromCookie;
  const m = /^Bearer\s+(.+)$/.exec(String(request.headers.get('authorization') || '').trim());
  if (!m || !env.ADMIN_TOKEN) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  if (!userId || !exp || !sig || Number(exp) < Date.now()) return null;
  if (sig !== await hmacHex(env.ADMIN_TOKEN, 'user:' + userId + ':' + exp)) return null;
  return await env.DB.prepare(`SELECT * FROM cms_users WHERE id = ?`).bind(userId).first();
}

// device_id dari body / query / header (pola coins.js).
function deviceFrom(request, body) {
  const q = new URL(request.url).searchParams;
  const d = (body && body.device_id) || request.headers.get('x-cerpen-device') || q.get('device_id') || '';
  return String(d).trim().slice(0, 128);
}

// Akun yang dibanned (cerpen_bans, pola coins.js) ditolak di aksi bersesi.
async function socialBanCheck(env, userId) {
  if (!userId) return null;
  const now = Date.now();
  await env.DB.prepare(`UPDATE cerpen_bans SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`).bind(now).run();
  const row = await env.DB.prepare(`SELECT id, reason, expires_at FROM cerpen_bans WHERE target_type = 'user' AND target_id = ? AND active = 1`).bind(userId).first();
  if (!row) return null;
  return { ok: false, error: 'banned', reason: String(row.reason || ''), expires_at: row.expires_at ? Number(row.expires_at) : null };
}

async function ensureStats(env, kind, ref) {
  await env.DB.prepare(`INSERT OR IGNORE INTO cerpen_content_stats (kind, ref, views, likes, dislikes, reports, updated_at) VALUES (?, ?, 0, 0, 0, 0, ?)`).bind(kind, ref, Date.now()).run();
}
async function readStats(env, kind, ref, voterKey) {
  const row = await env.DB.prepare(`SELECT views, likes, dislikes FROM cerpen_content_stats WHERE kind = ? AND ref = ?`).bind(kind, ref).first();
  let my = 0;
  if (voterKey) {
    const v = await env.DB.prepare(`SELECT vote FROM cerpen_content_votes WHERE kind = ? AND ref = ? AND voter_key = ?`).bind(kind, ref, voterKey).first();
    if (v) my = Number(v.vote) || 0;
  }
  return { views: row ? Number(row.views) || 0 : 0, likes: row ? Number(row.likes) || 0 : 0, dislikes: row ? Number(row.dislikes) || 0 : 0, my_vote: my };
}
// Validasi kind+ref+keberadaan konten; kembalikan parsed atau Response 400.
async function validContent(env, kind, ref) {
  const p = ['cerpen', 'komik', 'berita'].includes(kind) ? parseRef(kind, ref) : null;
  if (!p) return { err: aj({ ok: false, error: 'invalid_ref' }, 400) };
  if (!env.BACKUP_DB) return { err: aj({ ok: false, error: 'database_unavailable' }, 503) };
  if (!(await contentExists(env, kind, p))) return { err: aj({ ok: false, error: 'invalid_ref' }, 400) };
  return { parsed: p };
}

// Tren like harian (hari WIB, dilengkapi 0) dari baris created_at (ms).
// v87.4: tracking like — dipakai overview + endpoint daftar likers.
function likesTrend(rows, range) {
  const m = new Map();
  for (const r of rows || []) { const d = wibDay(Number(r.created_at) || 0); m.set(d, (m.get(d) || 0) + 1); }
  const out = [];
  for (let i = range - 1; i >= 0; i--) { const d = wibDay(Date.now() - i * 24 * 3600 * 1000); out.push({ day: d, likes: m.get(d) || 0 }); }
  return out;
}

// Judul konten untuk satu ref (BACKUP_DB; '' bila tak ketemu).
async function contentTitle(env, kind, p) {
  try {
    const B = env.BACKUP_DB;
    if (!B) return '';
    if (kind === 'cerpen') { const r = await B.prepare(`SELECT judul FROM cerpen_episodes WHERE series_id = ? AND season = ? AND no = ?`).bind(p.series, p.season, p.no).first(); return r ? String(r.judul || '') : ''; }
    if (kind === 'komik') { const r = await B.prepare(`SELECT judul FROM cerpen_komik_episodes WHERE komik_id = ? AND no = ?`).bind(p.komik, p.no).first(); return r ? String(r.judul || '') : ''; }
    const r = await B.prepare(`SELECT id, title, summary, topic FROM cerpen_news WHERE id = ?`).bind(p.id).first(); return r ? String(r.title || '') : '';
  } catch (e) { return ''; }
}

// Baris vote -> tampil admin: HANYA username/device id + waktu + konten.
// Login: username via cms_users; vote lama tanpa username -> "akun login (id)".
// Guest: device_id. voter_key mentah + user_id mentah tidak ikut keluar.
async function withUsernames(env, rows) {
  const ids = [...new Set((rows || []).map(r => r.user_id).filter(Boolean))];
  const nameMap = new Map();
  if (ids.length) {
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    for (const u of (users.results || [])) if (ids.includes(u.id)) nameMap.set(u.id, u.username);
  }
  return (rows || []).map(r => {
    const keyId = String(r.voter_key || '').replace(/^(user|device):/, '');
    const isUser = !!(r.user_id || String(r.voter_key || '').startsWith('user:'));
    const username = r.user_id ? (nameMap.get(r.user_id) || null) : null;
    const deviceId = isUser ? '' : (r.device_id || keyId);
    return {
      voter_type: isUser ? 'user' : 'guest',
      voter: username || (isUser ? 'akun login (' + (r.user_id || keyId) + ')' : deviceId),
      username,
      device_id: deviceId,
      vote: Number(r.vote) || 0,
      created_at: Number(r.created_at) || 0,
      created_at_wib: wibText(r.created_at),
    };
  });
}

// Konten yang punya like (segar, bukan cache overview) — untuk picker panel.
async function listLikedContents(env) {
  try {
    const rows = await env.DB.prepare(`SELECT kind, ref, likes FROM cerpen_content_stats WHERE likes > 0 ORDER BY likes DESC LIMIT 20`).all();
    return (rows.results || []).map(r => ({ kind: r.kind, ref: r.ref, likes: Number(r.likes) || 0 }));
  } catch (e) { return []; }
}

// ===================== Endpoint aplikasi =====================
export async function handleSocialApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const ip = clientIp(request);
  if (!env.DB) return aj({ ok: false, error: 'database_unavailable' }, 503);

  // POST /api/cerpen-social/view — 1× per viewer-key per hari WIB.
  if (method === 'POST' && path === '/api/cerpen-social/view') {
    if (!(await checkRateLimit(env, 'social-view:' + ip, 60, 10 * 60 * 1000))) return aj({ ok: false, error: 'too_many_requests' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const kind = String(body.kind || ''); const ref = String(body.ref || '');
    const v = await validContent(env, kind, ref);
    if (v.err) return v.err;
    const user = await resolveSocialUser(request, env);
    if (user) { const ban = await socialBanCheck(env, user.id); if (ban) return aj(ban, 403); }
    const deviceId = deviceFrom(request, body);
    const viewerKey = user ? 'user:' + user.id : (deviceId ? 'device:' + deviceId : '');
    if (!viewerKey) return aj({ ok: false, error: 'device_id_required' }, 400);
    const day = wibDay(Date.now());
    const ins = await env.DB.prepare(`INSERT OR IGNORE INTO cerpen_content_views (kind, ref, viewer_key, day, created_at) VALUES (?, ?, ?, ?, ?)`).bind(kind, ref, viewerKey, day, Date.now()).run();
    if (ins && ins.meta && Number(ins.meta.changes) === 1) {
      await ensureStats(env, kind, ref);
      await env.DB.prepare(`UPDATE cerpen_content_stats SET views = views + 1, updated_at = ? WHERE kind = ? AND ref = ?`).bind(Date.now(), kind, ref).run();
    }
    const s = await readStats(env, kind, ref, viewerKey);
    return aj({ ok: true, ...s });
  }

  // POST /api/cerpen-social/vote — like guest/login, dislike wajib login.
  if (method === 'POST' && path === '/api/cerpen-social/vote') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const kind = String(body.kind || ''); const ref = String(body.ref || '');
    const vote = Number(body.vote);
    if (![1, -1, 0].includes(vote)) return aj({ ok: false, error: 'invalid_vote' }, 400);
    const v = await validContent(env, kind, ref);
    if (v.err) return v.err;
    const user = await resolveSocialUser(request, env);
    if (vote === -1 && !user) return aj({ ok: false, error: 'login_required' }, 401);
    if (user) { const ban = await socialBanCheck(env, user.id); if (ban) return aj(ban, 403); }
    const deviceId = deviceFrom(request, body);
    const voterKey = user ? 'user:' + user.id : (deviceId ? 'device:' + deviceId : '');
    if (!voterKey) return aj({ ok: false, error: 'device_id_required' }, 400);
    if (!(await checkRateLimit(env, 'social-vote:' + voterKey, 30, 10 * 60 * 1000))) return aj({ ok: false, error: 'too_many_requests' }, 429);
    const now = Date.now();
    const existing = await env.DB.prepare(`SELECT vote FROM cerpen_content_votes WHERE kind = ? AND ref = ? AND voter_key = ?`).bind(kind, ref, voterKey).first();
    const oldVote = existing ? Number(existing.vote) || 0 : 0;
    // Vote sama 2× = batalkan; 0 = batalkan; selain itu ganti/simpan.
    const newVote = (vote === 0 || vote === oldVote) ? 0 : vote;
    const dLikes = (newVote === 1 ? 1 : 0) - (oldVote === 1 ? 1 : 0);
    const dDislikes = (newVote === -1 ? 1 : 0) - (oldVote === -1 ? 1 : 0);
    await ensureStats(env, kind, ref);
    const stmts = [];
    if (newVote === 0) {
      if (oldVote !== 0) stmts.push(env.DB.prepare(`DELETE FROM cerpen_content_votes WHERE kind = ? AND ref = ? AND voter_key = ?`).bind(kind, ref, voterKey));
    } else if (oldVote === 0) {
      stmts.push(env.DB.prepare(`INSERT INTO cerpen_content_votes (kind, ref, voter_key, vote, device_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(kind, ref, voterKey, newVote, user ? '' : deviceId, user ? user.id : '', now, now));
    } else {
      stmts.push(env.DB.prepare(`UPDATE cerpen_content_votes SET vote = ?, updated_at = ? WHERE kind = ? AND ref = ? AND voter_key = ?`).bind(newVote, now, kind, ref, voterKey));
    }
    if (dLikes !== 0 || dDislikes !== 0) stmts.push(env.DB.prepare(`UPDATE cerpen_content_stats SET likes = likes + ?, dislikes = dislikes + ?, updated_at = ? WHERE kind = ? AND ref = ?`).bind(dLikes, dDislikes, now, kind, ref));
    if (stmts.length) await env.DB.batch(stmts);
    const s = await readStats(env, kind, ref, voterKey);
    return aj({ ok: true, likes: s.likes, dislikes: s.dislikes, my_vote: s.my_vote });
  }

  // POST /api/cerpen-social/report — guest boleh; 1/konten/hari, 10/hari.
  if (method === 'POST' && path === '/api/cerpen-social/report') {
    if (!(await checkRateLimit(env, 'social-report:' + ip, 30, 10 * 60 * 1000))) return aj({ ok: false, error: 'too_many_requests' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const kind = String(body.kind || ''); const ref = String(body.ref || '');
    const category = String(body.category || '');
    if (!CATEGORIES.includes(category)) return aj({ ok: false, error: 'invalid_category' }, 400);
    const note = String(body.note || '').trim().slice(0, 500);
    const v = await validContent(env, kind, ref);
    if (v.err) return v.err;
    const user = await resolveSocialUser(request, env);
    if (user) { const ban = await socialBanCheck(env, user.id); if (ban) return aj(ban, 403); }
    const deviceId = deviceFrom(request, body);
    const reporterKey = user ? 'user:' + user.id : (deviceId ? 'device:' + deviceId : '');
    if (!reporterKey) return aj({ ok: false, error: 'device_id_required' }, 400);
    const day = wibDay(Date.now());
    const now = Date.now();
    const dup = await env.DB.prepare(`SELECT id FROM cerpen_content_reports WHERE kind = ? AND ref = ? AND reporter_key = ? AND day = ?`).bind(kind, ref, reporterKey, day).first();
    if (dup) return aj({ ok: false, error: 'already_reported' }, 429);
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cerpen_content_reports WHERE reporter_key = ? AND day = ?`).bind(reporterKey, day).first();
    if (cnt && Number(cnt.n) >= 10) return aj({ ok: false, error: 'too_many_reports' }, 429);
    const reportId = 'rep-' + randomHex(8);
    await ensureStats(env, kind, ref);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cerpen_content_reports (id, kind, ref, reporter_key, device_id, user_id, category, note, status, day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'baru', ?, ?, ?)`).bind(reportId, kind, ref, reporterKey, user ? '' : deviceId, user ? user.id : '', category, note, day, now, now),
      env.DB.prepare(`UPDATE cerpen_content_stats SET reports = reports + 1, updated_at = ? WHERE kind = ? AND ref = ?`).bind(now, kind, ref),
    ]);
    return aj({ ok: true, report_id: reportId }, 201);
  }

  // GET /api/cerpen-social/stats?kind=&ref=&device_id=
  if (method === 'GET' && path === '/api/cerpen-social/stats') {
    const kind = String(url.searchParams.get('kind') || '');
    const ref = String(url.searchParams.get('ref') || '');
    const v = await validContent(env, kind, ref);
    if (v.err) return v.err;
    const user = await resolveSocialUser(request, env);
    const deviceId = deviceFrom(request, null);
    const voterKey = user ? 'user:' + user.id : (deviceId ? 'device:' + deviceId : '');
    const s = await readStats(env, kind, ref, voterKey);
    return aj({ ok: true, ...s });
  }

  // POST /api/cerpen-social/stats-batch — maks 50 item; item tak valid dilewati.
  if (method === 'POST' && path === '/api/cerpen-social/stats-batch') {
    if (!(await checkRateLimit(env, 'social-batch:' + ip, 60, 10 * 60 * 1000))) return aj({ ok: false, error: 'too_many_requests' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length > 50) return aj({ ok: false, error: 'too_many_items' }, 400);
    const user = await resolveSocialUser(request, env);
    const deviceId = deviceFrom(request, body);
    const voterKey = user ? 'user:' + user.id : (deviceId ? 'device:' + deviceId : '');
    const stats = {};
    for (const it of items) {
      const kind = String(it && it.kind || ''); const ref = String(it && it.ref || '');
      const vv = await validContent(env, kind, ref);
      if (vv.err) continue;
      stats[kind + '|' + ref] = await readStats(env, kind, ref, voterKey);
    }
    return aj({ ok: true, stats });
  }
  return null;
}

// ===================== Statistik admin (ala YouTube Studio) =====================
// Agregasi server-side dari tabel yang ADA. Tidak ada demografi / traffic
// source / perangkat — metrik itu memang tidak ditampilkan.
let statsCache = { at: 0, range: 0, data: null };
export async function getSocialStatsOverview(env, rangeDays) {
  const range = rangeDays === 28 ? 28 : 7;
  if (statsCache.data && statsCache.range === range && Date.now() - statsCache.at < STATS_CACHE_MS) return statsCache.data;
  const today = wibDay(Date.now());
  const since = wibDay(Date.now() - (range - 1) * 24 * 3600 * 1000);
  const D = env.DB; const B = env.BACKUP_DB;
  const totals = await D.prepare(`SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(dislikes), 0) AS dislikes, COALESCE(SUM(reports), 0) AS reports FROM cerpen_content_stats`).first();
  const trendRows = await D.prepare(`SELECT day, COUNT(*) AS n FROM cerpen_content_views WHERE day >= ? GROUP BY day ORDER BY day ASC`).bind(since).all();
  const topRows = await D.prepare(`SELECT kind, ref, views, likes, dislikes FROM cerpen_content_stats ORDER BY views DESC LIMIT 10`).all();
  const likedRows = await D.prepare(`SELECT kind, ref, views, likes, dislikes FROM cerpen_content_stats ORDER BY likes DESC LIMIT 10`).all();
  const readTotal = await D.prepare(`SELECT COALESCE(SUM(seconds), 0) AS total FROM cms_reading_sessions`).first();
  const readTopRows = await D.prepare(`SELECT post_id, SUM(seconds) AS total FROM cms_reading_sessions GROUP BY post_id ORDER BY total DESC LIMIT 10`).all();
  const unlockRows = await D.prepare(`SELECT kind, target_id, season, no, COUNT(*) AS n FROM cerpen_unlocks GROUP BY kind, target_id, season, no ORDER BY n DESC LIMIT 10`).all();
  const coinRows = await D.prepare(`SELECT ref, SUM(0 - delta) AS spent FROM cerpen_coin_ledger WHERE delta < 0 GROUP BY ref ORDER BY spent DESC LIMIT 20`).all();
  const coinTotal = await D.prepare(`SELECT COALESCE(SUM(0 - delta), 0) AS spent FROM cerpen_coin_ledger WHERE delta < 0`).first();
  const newUserRows = await D.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM cms_users GROUP BY day ORDER BY day DESC LIMIT ?`).bind(range).all();
  const activeRows = await D.prepare(`SELECT day_wib, COUNT(DISTINCT user_id) AS n FROM cms_reading_sessions GROUP BY day_wib ORDER BY day_wib DESC LIMIT ?`).bind(range).all();
  const topReaderRows = await D.prepare(`SELECT user_id, SUM(seconds) AS total FROM cms_reading_sessions GROUP BY user_id ORDER BY total DESC LIMIT ? OFFSET ?`).bind(10, 0).all();
  const userRows = await D.prepare(`SELECT id, username FROM cms_users`).all();
  const reportCatRows = await D.prepare(`SELECT category, COUNT(*) AS n FROM cerpen_content_reports GROUP BY category`).all();
  const reportStatusRows = await D.prepare(`SELECT status, COUNT(*) AS n FROM cerpen_content_reports GROUP BY status`).all();
  // Judul konten untuk baris top (dari BACKUP_DB; gagal = tampil ref saja).
  const titles = new Map();
  try {
    if (B) {
      const refs = new Set([...(topRows.results || []), ...(likedRows.results || [])].map(r => r.kind + '|' + r.ref));
      for (const key of refs) {
        const [kind, ref] = key.split('|');
        const p = parseRef(kind, ref);
        if (!p) continue;
        if (kind === 'cerpen') { const r = await B.prepare(`SELECT judul FROM cerpen_episodes WHERE series_id = ? AND season = ? AND no = ?`).bind(p.series, p.season, p.no).first(); if (r) titles.set(key, r.judul); }
        else if (kind === 'komik') { const r = await B.prepare(`SELECT judul FROM cerpen_komik_episodes WHERE komik_id = ? AND no = ?`).bind(p.komik, p.no).first(); if (r) titles.set(key, r.judul); }
        else { const r = await B.prepare(`SELECT id, title, summary, topic FROM cerpen_news WHERE id = ?`).bind(p.id).first(); if (r) titles.set(key, r.title); }
      }
    }
  } catch (e) { /* judul opsional */ }
  // Total + terbaru konten (BACKUP_DB; tanpa itu, bagian konten kosong jujur).
  let content = { series: null, episodes: null, komik: null, komik_episodes: null, news: null, latest: [] };
  try {
    if (B) {
      const [s, e, k, ke, n] = await Promise.all([
        B.prepare(`SELECT COUNT(*) AS n FROM cerpen_series`).first(),
        B.prepare(`SELECT COUNT(*) AS n FROM cerpen_episodes`).first(),
        B.prepare(`SELECT COUNT(*) AS n FROM cerpen_komik`).first(),
        B.prepare(`SELECT COUNT(*) AS n FROM cerpen_komik_episodes`).first(),
        B.prepare(`SELECT COUNT(*) AS n FROM cerpen_news`).first(),
      ]);
      content = { series: Number(s && s.n) || 0, episodes: Number(e && e.n) || 0, komik: Number(k && k.n) || 0, komik_episodes: Number(ke && ke.n) || 0, news: Number(n && n.n) || 0, latest: [] };
      const [ls, le, ln] = await Promise.all([
        B.prepare(`SELECT id, judul, created_at FROM cerpen_series ORDER BY created_at DESC LIMIT 5`).all(),
        B.prepare(`SELECT series_id, season, no, judul, created_at FROM cerpen_episodes ORDER BY created_at DESC LIMIT 5`).all(),
        B.prepare(`SELECT id, title, added_at FROM cerpen_news ORDER BY added_at DESC LIMIT 5`).all(),
      ]);
      content.latest = [
        ...((ls.results || []).map(r => ({ kind: 'cerpen', label: r.judul, ref: r.id, at: wibText(r.created_at) }))),
        ...((le.results || []).map(r => ({ kind: 'cerpen', label: r.judul, ref: r.series_id + ':' + r.season + ':' + r.no, at: wibText(r.created_at) }))),
        ...((ln.results || []).map(r => ({ kind: 'berita', label: r.title, ref: r.id, at: String(r.added_at || '').slice(0, 10) }))),
      ].slice(0, 5);
    }
  } catch (e) { /* konten tetap null = belum tersedia */ }
  // Tren harian dilengkapkan: hari tanpa view = 0 (bukan grafik palsu).
  const trendMap = new Map((trendRows.results || []).map(r => [r.day, Number(r.n) || 0]));
  const trend = [];
  for (let i = range - 1; i >= 0; i--) { const d = wibDay(Date.now() - i * 24 * 3600 * 1000); trend.push({ day: d, views: trendMap.get(d) || 0 }); }
  const nameMap = new Map((userRows.results || []).map(u => [u.id, u.username]));
  const contentRef = /^(cerpen|komik):[A-Za-z0-9_-]+:\d+(:\d+)?$/;
  // v87.4: tren like harian (vote=1 baru per hari WIB).
  const likeRows = await D.prepare(`SELECT created_at FROM cerpen_content_votes WHERE vote = 1 AND created_at >= ?`).bind(Date.now() - (range - 1) * 24 * 3600 * 1000).all();
  const data = {
    range, today, since, generated_at: Date.now(),
    totals: { views: Number(totals && totals.views) || 0, likes: Number(totals && totals.likes) || 0, dislikes: Number(totals && totals.dislikes) || 0, reports: Number(totals && totals.reports) || 0 },
    trend,
    likes_trend: likesTrend(likeRows.results || [], range),
    top_views: (topRows.results || []).map(r => ({ kind: r.kind, ref: r.ref, title: titles.get(r.kind + '|' + r.ref) || '', views: Number(r.views) || 0, likes: Number(r.likes) || 0, dislikes: Number(r.dislikes) || 0 })),
    top_liked: (likedRows.results || []).map(r => ({ kind: r.kind, ref: r.ref, title: titles.get(r.kind + '|' + r.ref) || '', views: Number(r.views) || 0, likes: Number(r.likes) || 0, dislikes: Number(r.dislikes) || 0 })),
    reading: { total_seconds: Number(readTotal && readTotal.total) || 0, top: (readTopRows.results || []).map(r => ({ post_id: r.post_id, seconds: Number(r.total) || 0 })) },
    unlocks: { top: (unlockRows.results || []).map(r => ({ kind: r.kind, target_id: r.target_id, season: Number(r.season) || 1, no: Number(r.no) || 0, count: Number(r.n) || 0 })) },
    coins: { total_spent: Number(coinTotal && coinTotal.spent) || 0, top_spent: (coinRows.results || []).filter(r => contentRef.test(String(r.ref || ''))).map(r => ({ ref: r.ref, spent: Number(r.spent) || 0 })).slice(0, 10) },
    readers: {
      new_users: (newUserRows.results || []).map(r => ({ day: r.day, n: Number(r.n) || 0 })),
      active: (activeRows.results || []).map(r => ({ day: r.day_wib, n: Number(r.n) || 0 })),
      top: (topReaderRows.results || []).map(r => ({ user_id: r.user_id, username: nameMap.get(r.user_id) || r.user_id, seconds: Number(r.total) || 0 })),
    },
    reports: {
      by_category: (reportCatRows.results || []).map(r => ({ category: r.category, n: Number(r.n) || 0 })),
      by_status: (reportStatusRows.results || []).map(r => ({ status: r.status, n: Number(r.n) || 0 })),
    },
    content,
  };
  statsCache = { at: Date.now(), range, data };
  return data;
}

// Ringkasan kecil untuk dashboard admin (fail-silent: 0 bila tabel belum ada).
export async function getSocialDashboardSummary(env) {
  try {
    const t = await env.DB.prepare(`SELECT COALESCE(SUM(views), 0) AS views, COALESCE(SUM(likes), 0) AS likes, COALESCE(SUM(dislikes), 0) AS dislikes, COALESCE(SUM(reports), 0) AS reports FROM cerpen_content_stats`).first();
    const baru = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cerpen_content_reports WHERE status = ?`).bind('baru').first();
    return { views: Number(t && t.views) || 0, likes: Number(t && t.likes) || 0, reports: Number(t && t.reports) || 0, reports_baru: Number(baru && baru.n) || 0 };
  } catch (e) { return { views: 0, likes: 0, reports: 0, reports_baru: 0 }; }
}

// ===================== Endpoint admin JSON =====================
export async function handleSocialAdminApi(request, env, url, admin) {
  const path = url.pathname;
  const method = request.method;
  if (!admin) return aj({ ok: false, error: 'unauthorized' }, 401);
  if (String(request.headers.get('x-csrf') || '') !== await csrfToken(env)) return aj({ ok: false, error: 'csrf tidak valid' }, 403);
  if (method === 'GET' && path === '/api/admin/cerpen-social/stats-overview') {
    const range = Number(url.searchParams.get('range') || '7') === 28 ? 28 : 7;
    return aj({ ok: true, ...(await getSocialStatsOverview(env, range)) });
  }
  // GET /api/admin/cerpen-social/likes — tracking like (v87.4).
  // Detail per konten (?kind=&ref=): daftar pemberi like — username untuk
  // akun login, device id untuk guest — + waktu + tren harian konten itu.
  // Tanpa ref: ringkasan total like per konten (paginasi) + tren global.
  // Hanya username/device id + waktu + konten; tanpa data pribadi lain.
  if (method === 'GET' && path === '/api/admin/cerpen-social/likes') {
    const kind = String(url.searchParams.get('kind') || '');
    const ref = String(url.searchParams.get('ref') || '');
    const range = Number(url.searchParams.get('range') || '7') === 28 ? 28 : 7;
    const limitRaw = Number(url.searchParams.get('limit'));
    const offsetRaw = Number(url.searchParams.get('offset'));
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;
    const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    const sinceMs = Date.now() - (range - 1) * 24 * 3600 * 1000;
    if (kind || ref) {
      const p = ['cerpen', 'komik', 'berita'].includes(kind) ? parseRef(kind, ref) : null;
      if (!p) return aj({ ok: false, error: 'invalid_ref' }, 400);
      const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cerpen_content_votes WHERE kind = ? AND ref = ? AND vote = 1`).bind(kind, ref).first();
      const total = Number(totalRow && totalRow.n) || 0;
      const rows = await env.DB.prepare(`SELECT kind, ref, voter_key, vote, device_id, user_id, created_at, updated_at FROM cerpen_content_votes WHERE kind = ? AND ref = ? AND vote = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(kind, ref, limit, offset).all();
      const trendRows = await env.DB.prepare(`SELECT created_at FROM cerpen_content_votes WHERE kind = ? AND ref = ? AND vote = 1 AND created_at >= ?`).bind(kind, ref, sinceMs).all();
      return aj({ ok: true, kind, ref, title: await contentTitle(env, kind, p), total, limit, offset, likers: await withUsernames(env, rows.results || []), trend: likesTrend(trendRows.results || [], range) });
    }
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cerpen_content_stats WHERE likes > 0`).first();
    const total = Number(totalRow && totalRow.n) || 0;
    const rows = await env.DB.prepare(`SELECT kind, ref, likes FROM cerpen_content_stats WHERE likes > 0 ORDER BY likes DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();
    const trendRows = await env.DB.prepare(`SELECT created_at FROM cerpen_content_votes WHERE vote = 1 AND created_at >= ?`).bind(sinceMs).all();
    return aj({ ok: true, total, limit, offset, contents: (rows.results || []).map(r => ({ kind: r.kind, ref: r.ref, likes: Number(r.likes) || 0 })), trend: likesTrend(trendRows.results || [], range) });
  }
  const m = path.match(/^\/api\/admin\/cerpen-social\/reports\/(rep-[0-9a-f]+)\/status$/);
  if (m && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const status = String(body.status || '');
    if (!REPORT_STATUSES.includes(status)) return aj({ ok: false, error: 'invalid_status' }, 400);
    const upd = await env.DB.prepare(`UPDATE cerpen_content_reports SET status = ?, updated_at = ? WHERE id = ?`).bind(status, Date.now(), m[1]).run();
    if (!upd || !upd.meta || Number(upd.meta.changes) !== 1) return aj({ ok: false, error: 'not_found' }, 404);
    return aj({ ok: true, id: m[1], status });
  }
  return null;
}

// ===================== Panel admin =====================
async function listReports(env, kind, status, limit) {
  let sql = `SELECT id, kind, ref, reporter_key, device_id, user_id, category, note, status, day, created_at FROM cerpen_content_reports`;
  const args = [];
  const where = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  args.push(limit);
  const rows = await env.DB.prepare(sql).bind(...args).all();
  return rows.results || [];
}

export async function renderSocialReportsPanel(env, csrf, nav, notice, url) {
  const kind = String(url.searchParams.get('kind') || '');
  const status = String(url.searchParams.get('status') || '');
  const fKind = ['cerpen', 'komik', 'berita'].includes(kind) ? kind : '';
  const fStatus = REPORT_STATUSES.includes(status) ? status : '';
  const rows = await listReports(env, fKind, fStatus, 50);
  const opt = (name, val, cur, label) => `<option value="${val}"${val === cur ? ' selected' : ''}>${label}</option>`;
  const rowsHtml = rows.map(r => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(r.kind)} · ${esc(r.ref)} — ${esc(r.category)}</span><div class="adm-row-meta">${wibText(r.created_at)} · status: <b>${esc(r.status)}</b> · pelapor ${esc(String(r.reporter_key || '').slice(0, 30))}</div>${r.note ? `<div class="adm-row-meta">${esc(r.note)}</div>` : ''}</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${r.status !== 'ditangani' ? `<button type="button" data-report-status="ditangani" data-report-id="${esc(r.id)}">Tandai ditangani</button>` : ''}${r.status !== 'ditolak' ? `<button type="button" data-report-status="ditolak" data-report-id="${esc(r.id)}" style="background:#dc2626">Tolak</button>` : ''}</div></div>`).join('') || '<p>Belum ada laporan.</p>';
  const content = `<h2>Laporan Konten</h2>${nav}${notice}<div class="card"><form method="get" action="/kendali/laporan" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><label style="margin:0">Jenis<select name="kind">${opt(0, '', fKind, 'Semua')}${opt(0, 'cerpen', fKind, 'Cerpen')}${opt(0, 'komik', fKind, 'Komik')}${opt(0, 'berita', fKind, 'Berita')}</select></label><label style="margin:0">Status<select name="status">${opt(0, '', fStatus, 'Semua')}${opt(0, 'baru', fStatus, 'Baru')}${opt(0, 'ditangani', fStatus, 'Ditangani')}${opt(0, 'ditolak', fStatus, 'Ditolak')}</select></label><button type="submit">Filter</button></form></div><div class="card">${rowsHtml}</div><script>(function(){var csrf=${JSON.stringify(csrf)};document.querySelectorAll('[data-report-status]').forEach(function(b){b.addEventListener('click',function(){fetch('/api/admin/cerpen-social/reports/'+encodeURIComponent(b.dataset.reportId)+'/status',{method:'POST',headers:{'content-type':'application/json','x-csrf':csrf},body:JSON.stringify({status:b.dataset.reportStatus})}).then(function(r){return r.json()}).then(function(j){if(j.ok){location.reload()}else{alert('Gagal: '+(j.error||'unknown'))}}).catch(function(){alert('Gagal terhubung')})})})})();<\/script>`;
  return content;
}

export async function renderSocialStatsPanel(env, csrf, nav, notice, url) {
  const range = Number(url.searchParams.get('range') || '7') === 28 ? 28 : 7;
  const d = await getSocialStatsOverview(env, range);
  const num = n => Number(n || 0).toLocaleString('id-ID');
  const mins = s => Math.floor((Number(s) || 0) / 60).toLocaleString('id-ID');
  const likedContents = await listLikedContents(env); // segar (bukan cache overview)
  const likeOpts = likedContents.map(c => `<option value="${esc(c.kind + '|' + c.ref)}">${esc(c.kind)} · ${esc(c.ref)} (${num(c.likes)} like)</option>`).join('');
  const likersCard = `<div class="card"><h3>❤️ Pemberi Like</h3><p class="meta">Siapa yang like, per konten — username untuk akun login, device id untuk guest. Hanya itu yang dicatat.</p>${likeOpts ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><label style="margin:0">Konten<select id="likers-ref">${likeOpts}</select></label><button type="button" id="likers-load">Lihat pemberi like</button></div><div id="likers-out" style="margin-top:12px"></div>` : '<p>Belum ada like.</p>'}</div>`;
  const likersScript = `<script>(function(){var csrf=${JSON.stringify(csrf)};var sel=document.getElementById('likers-ref');var out=document.getElementById('likers-out');if(!sel||!out)return;function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}var off=0;function load(o){off=o;var kv=sel.value.split('|');fetch('/api/admin/cerpen-social/likes?kind='+encodeURIComponent(kv[0])+'&ref='+encodeURIComponent(kv[1])+'&limit=50&offset='+off,{headers:{'x-csrf':csrf}}).then(function(r){return r.json()}).then(function(j){if(!j.ok){out.innerHTML='<p>Gagal: '+esc(j.error||'unknown')+'</p>';return}var rows=j.likers.map(function(l){return '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">'+esc(l.voter)+'</span><div class="adm-row-meta">'+(l.voter_type==='user'?'akun login':'guest')+' · '+esc(l.created_at_wib)+' WIB</div></div></div>'}).join('')||'<p>Belum ada pemberi like.</p>';var nav='';if(off>0)nav+='<button type="button" id="likers-prev">← Sebelumnya</button> ';if(off+50<j.total)nav+='<button type="button" id="likers-next">Berikutnya →</button>';out.innerHTML='<p class="meta">'+j.total+' pemberi like · '+esc(j.title||j.ref)+'</p>'+rows+'<div style="display:flex;gap:8px;margin-top:8px">'+nav+'</div>';var pv=document.getElementById('likers-prev');if(pv)pv.addEventListener('click',function(){load(Math.max(0,off-50))});var nx=document.getElementById('likers-next');if(nx)nx.addEventListener('click',function(){load(off+50)})}).catch(function(){out.innerHTML='<p>Gagal terhubung</p>'})}document.getElementById('likers-load').addEventListener('click',function(){load(0)});sel.addEventListener('change',function(){load(0)})})();<\/script>`;
  const maxTrend = Math.max(1, ...d.trend.map(t => t.views));
  const bar = (label, val, max, suffix) => `<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="flex:0 0 92px;font-size:12px;opacity:.8">${esc(label)}</span><span style="display:block;height:14px;background:#3b82f6;border-radius:4px;width:${Math.max(2, Math.round((Number(val) || 0) / max * 100))}%"></span><span style="font-size:12px">${num(val)}${suffix || ''}</span></div>`;
  const row = (cells) => `<div class="adm-row"><div class="adm-row-body">${cells}</div></div>`;
  const topViewsHtml = d.top_views.map((r, i) => row(`<span class="adm-row-title">${i + 1}. ${esc(r.title || r.ref)}</span><div class="adm-row-meta">${esc(r.kind)} · ${esc(r.ref)} · ${num(r.views)} views · ${num(r.likes)} like · ${num(r.dislikes)} dislike</div>`)).join('') || '<p>Belum ada data views.</p>';
  const topLikedHtml = d.top_liked.map((r, i) => row(`<span class="adm-row-title">${i + 1}. ${esc(r.title || r.ref)}</span><div class="adm-row-meta">${esc(r.kind)} · ${esc(r.ref)} · ${num(r.likes)} like · ${num(r.views)} views</div>`)).join('') || '<p>Belum ada data like.</p>';
  const readTopHtml = d.reading.top.map((r, i) => row(`<span class="adm-row-title">${i + 1}. ${esc(r.post_id)}</span><div class="adm-row-meta">${mins(r.seconds)} menit (${num(r.seconds)} detik)</div>`)).join('') || '<p>Belum ada data waktu baca.</p>';
  const unlockHtml = d.unlocks.top.map((r, i) => row(`<span class="adm-row-title">${i + 1}. ${esc(r.kind)}:${esc(r.target_id)} S${r.season}E${r.no}</span><div class="adm-row-meta">${num(r.count)}× dibuka</div>`)).join('') || '<p>Belum ada episode dibuka pakai koin.</p>';
  const coinHtml = d.coins.top_spent.map((r, i) => row(`<span class="adm-row-title">${i + 1}. ${esc(r.ref)}</span><div class="adm-row-meta">${num(r.spent)} koin</div>`)).join('') || '<p>Belum ada pengeluaran koin per konten.</p>';
  const newUsersHtml = d.readers.new_users.map(r => bar(r.day.slice(5), r.n, Math.max(1, ...d.readers.new_users.map(x => x.n)), ' akun')).join('') || '<p>Belum ada data.</p>';
  const activeHtml = d.readers.active.map(r => bar(r.day.slice(5), r.n, Math.max(1, ...d.readers.active.map(x => x.n)), ' pembaca')).join('') || '<p>Belum ada data.</p>';
  const topReadersHtml = d.readers.top.map((r, i) => row(`<span class="adm-row-title">${i + 1}. ${esc(r.username)}</span><div class="adm-row-meta">${mins(r.seconds)} menit (${num(r.seconds)} detik)</div>`)).join('') || '<p>Belum ada data.</p>';
  const repCatHtml = d.reports.by_category.map(r => row(`<span class="adm-row-title">${esc(r.category)}</span><div class="adm-row-meta">${num(r.n)} laporan</div>`)).join('') || '<p>Belum ada laporan.</p>';
  const repStatusHtml = d.reports.by_status.map(r => row(`<span class="adm-row-title">${esc(r.status)}</span><div class="adm-row-meta">${num(r.n)} laporan</div>`)).join('') || '<p>Belum ada laporan.</p>';
  const contentHtml = d.content.series === null
    ? '<p>Belum tersedia — database konten tidak bisa dibaca saat ini.</p>'
    : `<p>${num(d.content.series)} series · ${num(d.content.episodes)} episode cerpen · ${num(d.content.komik)} komik · ${num(d.content.komik_episodes)} episode komik · ${num(d.content.news)} berita</p>` + (d.content.latest.map(r => row(`<span class="adm-row-title">${esc(r.label)}</span><div class="adm-row-meta">${esc(r.kind)} · ${esc(r.ref)} · ${esc(r.at)}</div>`)).join('') || '');
  const content = `<h2>Statistik Cerpen</h2>${nav}${notice}<p class="meta">Gaya YouTube Studio — semua angka dari data yang ada di sistem (cache 5 menit, rentang ${d.range} hari, hari WIB). <a href="/kendali/statistik?range=7">7 hari</a> · <a href="/kendali/statistik?range=28">28 hari</a></p>`
    + `<div class="card"><h3>Ringkasan</h3><div class="adm-stats"><div class="adm-stat"><span class="adm-stat-num">${num(d.totals.views)}</span><span class="adm-stat-label">views total</span></div><div class="adm-stat"><span class="adm-stat-num">${num(d.totals.likes)}</span><span class="adm-stat-label">like total</span></div><div class="adm-stat"><span class="adm-stat-num">${num(d.totals.dislikes)}</span><span class="adm-stat-label">dislike total (admin saja)</span></div><div class="adm-stat"><span class="adm-stat-num">${num(d.totals.reports)}</span><span class="adm-stat-label">laporan total</span><span class="adm-stat-sub"><a href="/kendali/laporan">Moderasi laporan</a></span></div><div class="adm-stat"><span class="adm-stat-num">${mins(d.reading.total_seconds)}</span><span class="adm-stat-label">menit dibaca (total)</span><span class="adm-stat-sub">hanya pembaca login</span></div><div class="adm-stat"><span class="adm-stat-num">${num(d.coins.total_spent)}</span><span class="adm-stat-label">koin terpakai (total)</span></div></div></div>`
    + `<div class="card"><h3>Views per hari — ${d.range} hari terakhir (penonton unik)</h3>${d.trend.map(t => bar(t.day.slice(5), t.views, maxTrend)).join('')}</div>`
    + `<div class="card"><h3>🔥 Konten teratas (views)</h3>${topViewsHtml}</div>`
    + `<div class="card"><h3>❤️ Konten teratas (like)</h3>${topLikedHtml}</div>`
    + `<div class="card"><h3>❤️ Like baru per hari — ${d.range} hari terakhir</h3>${(d.likes_trend || []).map(t => bar(t.day.slice(5), t.likes, Math.max(1, ...(d.likes_trend || []).map(x => x.likes)), ' like')).join('') || '<p>Belum ada data.</p>'}</div>`
    + likersCard + likersScript
    + `<div class="card"><h3>⏱️ Waktu baca per konten</h3>${readTopHtml}</div>`
    + `<div class="card"><h3>🔓 Episode paling banyak dibuka (unlock)</h3>${unlockHtml}</div>`
    + `<div class="card"><h3>🪙 Koin terpakai per konten</h3>${coinHtml}</div>`
    + `<div class="card"><h3>👥 Pengguna baru per hari</h3>${newUsersHtml}</div>`
    + `<div class="card"><h3>📖 Pembaca aktif per hari</h3>${activeHtml}</div>`
    + `<div class="card"><h3>🏆 Top pembaca (waktu baca)</h3>${topReadersHtml}</div>`
    + `<div class="card"><h3>🚩 Laporan per kategori</h3>${repCatHtml}</div>`
    + `<div class="card"><h3>🚩 Laporan per status</h3>${repStatusHtml}</div>`
    + `<div class="card"><h3>📚 Konten</h3>${contentHtml}</div>`
    + `<div class="card"><h3>Tidak ditampilkan (datanya tidak ada)</h3><p>Demografi (umur/jenis kelamin/lokasi pembaca), traffic source (dari mana pembaca datang), dan perangkat (Android/iOS/merk HP) — ketiganya tidak dicatat sistem, jadi tidak ditampilkan supaya tidak ada angka palsu. Waktu baca hanya dari pembaca login; pembaca guest tidak tercatat di pelacak baca.</p></div>`;
  return content;
}
