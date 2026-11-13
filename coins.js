// Sistem Koin Cerpen Hozin (v87) — ekonomi baca dalam aplikasi.
//
// Modul mandiri: endpoint auth aplikasi (/api/cerpen-auth/*), endpoint koin
// (/api/cerpen-coins/*), endpoint admin (/api/admin/cerpen-koin/*), dan panel
// /kendali/koin. Semua tabel koin tinggal di D1 cms-db (env.DB) — satu DB
// dengan cms_users, supaya beli/redeem/migrasi bisa atomik (lihat DESIGN.md
// di ~/workspace/cerpen-koin/DESIGN.md).
//
// Prinsip: server satu-satunya otoritas saldo & unlock. Aplikasi tidak pernah
// dipercaya memberi saldo/unlock sendiri. Ban HANYA untuk akun (v1);
// perangkat masuk Daftar Pantauan (bukan hukuman, tidak memblokir).
import { esc, clientIp, randomHex, sha256Hex } from './util.js';
import { isAdmin, csrfToken, getCommenter, userSessionCookie, hashPassword, verifyPassword, isValidCommenterPassword } from './auth.js';
import { checkRateLimit } from './security.js';
import { validEmail, issueOtp, verifyOtp, OTP_SEND_LIMIT, OTP_SEND_WINDOW_MS } from './otp.js';
import { getSetting } from './store.js';
import { HEARTBEAT_MAX_SECONDS, READING_DAILY_CAP_SECONDS, READING_RATE_LIMIT, READING_RATE_WINDOW_MS } from './reading.js';

const COIN_MAX_BALANCE_DELTA = 100000; // batas sekali adjust admin
const COIN_MAX_ACCOUNTS_PER_DEVICE = 3;
const COIN_VOUCHER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa 0/1/I/O
const COIN_WATCH_FAIL_REDEEM_24H = 5;
const COIN_WATCH_CODES_24H = 5;
const WATCH_WINDOW_MS = 24 * 3600 * 1000;

const aj = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function readJsonBody(request) {
  let raw = '';
  try { raw = await request.text(); } catch (e) { return { err: 'body tidak bisa dibaca' }; }
  if (raw.length > 100 * 1024) return { err: 'body terlalu besar (maks 100 KB)' };
  if (!raw.trim()) return { body: {} };
  try { return { body: JSON.parse(raw) }; } catch (e) { return { err: 'body JSON tidak valid' }; }
}

const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const isUserId = v => /^u-[0-9a-z]+$/.test(String(v || ''));
const isTargetId = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
const isAndroidId = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
const isHash64 = v => /^[0-9a-f]{64}$/.test(String(v || ''));

function wibText(ms) {
  return new Date(Number(ms || 0) + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' WIB';
}
function wibDate(ms) {
  return new Date(Number(ms || 0) + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---- Kode voucher ----
export function randomVoucherCode() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += COIN_VOUCHER_CODE_ALPHABET[b % COIN_VOUCHER_CODE_ALPHABET.length];
  return 'CERPEN-' + raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
}
export function normVoucherCode(code) {
  return String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

// ---- Dompet / ledger / harga ----
async function getWallet(env, ownerKey) {
  return await env.DB.prepare(`SELECT owner_key, owner_type, user_id, device_id, balance FROM cerpen_wallets WHERE owner_key = ?`).bind(ownerKey).first();
}
async function ensureWallet(env, ownerKey, ownerType, userId, deviceId) {
  const now = Date.now();
  await env.DB.prepare(`INSERT OR IGNORE INTO cerpen_wallets (owner_key, owner_type, user_id, device_id, balance, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`).bind(ownerKey, ownerType, userId, deviceId, now, now).run();
  return getWallet(env, ownerKey);
}
async function addLedger(env, { ownerKey, userId, deviceId, delta, balanceAfter, reason, ref }) {
  await env.DB.prepare(`INSERT INTO cerpen_coin_ledger (id, owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('lg-' + randomHex(8), ownerKey, userId || null, deviceId || null, delta, balanceAfter, String(reason || '').slice(0, 200), String(ref || '').slice(0, 200), Date.now()).run();
}
async function getPricing(env) {
  const defPrice = parseInt(await getSetting(env, 'cerpen_coin_price_default', '10'), 10);
  const defFree = parseInt(await getSetting(env, 'cerpen_coin_free_episodes_default', '1'), 10);
  const rows = await env.DB.prepare(`SELECT kind, target_id, price, free_episodes FROM cerpen_coin_pricing`).all();
  const overrides = {};
  for (const r of (rows.results || [])) overrides[r.kind + ':' + r.target_id] = { price: Number(r.price) || 0, free_episodes: Number(r.free_episodes) || 0 };
  return {
    default_price: Number.isFinite(defPrice) && defPrice >= 0 ? defPrice : 10,
    free_episodes_default: Number.isFinite(defFree) && defFree >= 0 ? defFree : 1,
    overrides,
  };
}
function priceFor(pricing, kind, targetId, no) {
  const ov = pricing.overrides[kind + ':' + targetId];
  const price = ov ? ov.price : pricing.default_price;
  const freeN = ov ? ov.free_episodes : pricing.free_episodes_default;
  return { price, free: no <= freeN };
}
async function coinAudit(env, action, targetType, targetId, note) {
  await env.DB.prepare(`INSERT INTO coin_admin_audit (id, created_at, action, target_type, target_id, note) VALUES (?, ?, ?, ?, ?, ?)`).bind('ca-' + randomHex(6), Date.now(), action, targetType, targetId, String(note || '').slice(0, 500)).run();
}
async function logCoinEvent(env, kind, { deviceId = '', androidId = '', userId = null, detail = '' }) {
  try {
    await env.DB.prepare(`INSERT INTO cerpen_coin_events (id, kind, device_id, android_id, user_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind('ev-' + randomHex(8), kind, deviceId, androidId, userId, String(detail || '').slice(0, 200), Date.now()).run();
  } catch (e) { /* jejak tidak boleh menggagalkan alur utama */ }
}
// Registri pantauan: tiap request koin/auth yang membawa device_id dicatat
// (upsert, updated_at = terakhir terlihat). Tidak memblokir apa pun.
async function touchDeviceWatch(env, deviceId, androidId) {
  if (!isUuid(deviceId)) return;
  const now = Date.now();
  try {
    await env.DB.prepare(`INSERT INTO cerpen_device_watch (device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at) VALUES (?, ?, 0, 0, '', '', ?, ?) ON CONFLICT(device_id) DO UPDATE SET updated_at = ?, android_id = ?`).bind(deviceId, androidId || '', now, now, now, androidId || '').run();
  } catch (e) { /* pantauan tidak boleh menggagalkan alur utama */ }
}

// ---- Ban AKUN saja (v1) ----
// Sesi komentator stateless (HMAC) — tidak ada tabel sesi yang bisa dicabut.
// Maka pencabutan = cek ban di TIAP request bersesi: akun yang dibanned
// ditolak 403 walau cookie-nya masih valid.
async function coinBanCheck(env, userId) {
  if (!userId) return null;
  const now = Date.now();
  await env.DB.prepare(`UPDATE cerpen_bans SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`).bind(now).run();
  const row = await env.DB.prepare(`SELECT id, reason, expires_at FROM cerpen_bans WHERE target_type = 'user' AND target_id = ? AND active = 1`).bind(userId).first();
  if (row) return { target: 'user', reason: String(row.reason || ''), expires_at: row.expires_at ? Number(row.expires_at) : null };
  return null;
}
function bannedResponse(ban) {
  return aj({ ok: false, error: 'banned', target: ban.target, reason: ban.reason, expires_at: ban.expires_at }, 403);
}

// ---- VIP (19:17) ----
// Satu baris per akun di cerpen_vip. Selama expires_at > sekarang, semua
// episode terkunci bisa dibaca gratis (cek di /purchase, server-side).
// VIP TIDAK dibeli pakai koin di v1 — hanya grant admin / voucher.
async function vipStatus(env, userId) {
  if (!userId) return { active: false, expires_at: null };
  const row = await env.DB.prepare(`SELECT expires_at FROM cerpen_vip WHERE user_id = ?`).bind(userId).first();
  if (!row) return { active: false, expires_at: null };
  const exp = row.expires_at ? Number(row.expires_at) : null;
  if (exp && exp <= Date.now()) return { active: false, expires_at: exp };
  return { active: true, expires_at: exp };
}
async function grantVip(env, userId, days, grantedBy, reason) {
  const now = Date.now();
  const cur = await vipStatus(env, userId);
  const base = cur.active && cur.expires_at ? Math.max(cur.expires_at, now) : now;
  const expiresAt = base + Math.max(1, Math.round(days)) * 86400 * 1000;
  await env.DB.prepare(`INSERT INTO cerpen_vip (user_id, expires_at, granted_by, reason, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET expires_at = ?, granted_by = ?, reason = ?, created_at = ?`).bind(userId, expiresAt, grantedBy || 'admin', String(reason || '').slice(0, 200), now, expiresAt, grantedBy || 'admin', String(reason || '').slice(0, 200), now).run();
  return { expires_at: expiresAt };
}
async function revokeVip(env, userId) {
  const del = await env.DB.prepare(`DELETE FROM cerpen_vip WHERE user_id = ?`).bind(userId).run();
  return del && del.meta ? Number(del.meta.changes) || 0 : 0;
}

// ---- Papan peringkat (19:17) — pakai tabel pelacak v81, tanpa tabel baru ----
// Hanya post_id Cerpen (cerpen:/komik:) yang dihitung — bacaan post web CMS
// tidak masuk papan Cerpen. Hanya akun dengan reading_private=0; guest
// (device:...) tidak punya username sehingga otomatis tidak tampil.
function parsePostId(postId) {
  const m = String(postId || '').match(/^(cerpen|komik):([A-Za-z0-9_-]+):(?:s(\d+)e(\d+)|e(\d+))$/);
  if (!m) return null;
  return { kind: m[1], target_id: m[2], season: m[3] ? Number(m[3]) : 1, no: Number(m[4] || m[5]) };
}
function postIdFor(kind, targetId, season, no) {
  return kind === 'komik' ? `komik:${targetId}:e${no}` : `cerpen:${targetId}:s${season}e${no}`;
}
async function getLeaderboard(env, period, limit) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const since = period === 'weekly' ? wibDate(Date.now() - 6 * 24 * 3600 * 1000) : null;
  let rows;
  if (since) {
    rows = await env.DB.prepare(`SELECT user_id, SUM(seconds) AS total FROM cms_reading_sessions WHERE day_wib >= ? AND (post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%') GROUP BY user_id ORDER BY total DESC LIMIT ?`).bind(since, lim).all();
  } else {
    rows = await env.DB.prepare(`SELECT user_id, SUM(seconds) AS total FROM cms_reading_sessions WHERE post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%' GROUP BY user_id ORDER BY total DESC LIMIT ?`).bind(lim).all();
  }
  const users = await env.DB.prepare(`SELECT id, username, reading_private FROM cms_users`).all();
  const uMap = new Map((users.results || []).map(u => [u.id, u]));
  const out = [];
  for (const r of (rows.results || [])) {
    const u = uMap.get(r.user_id);
    if (!u || Number(u.reading_private) === 1) continue;
    out.push({ rank: out.length + 1, username: u.username, seconds: Number(r.total) || 0, minutes: Math.floor((Number(r.total) || 0) / 60) });
  }
  return out;
}

// ---- Voucher fleksibel (19:17) — hadiah koin / episode / season / series / VIP ----
const VOUCHER_REWARD_TYPES = ['coins', 'episode', 'season', 'series', 'vip'];
function rewardLabel(b) {
  const t = b.reward_type || 'coins';
  if (t === 'coins') return (Number(b.reward_coins ?? b.reward_value) || 0) + ' koin';
  if (t === 'vip') return 'VIP ' + (Number(b.reward_value) || 0) + ' hari';
  const tgt = (b.reward_target_kind || '') + ':' + (b.reward_target_id || '');
  if (t === 'episode') return 'Unlock episode ' + tgt + ' S' + (b.reward_season || 1) + 'E' + (b.reward_no || 0);
  if (t === 'season') return 'Unlock season ' + (b.reward_season || 1) + ' ' + tgt;
  if (t === 'series') return 'Unlock semua ' + tgt;
  return t;
}
// Uraikan hadiah konten voucher menjadi daftar episode dari BACKUP_DB
// (D1 stopwatch-db). Kembalikan {episodes:[...]} atau {error}.
async function resolveVoucherEpisodes(env, batch) {
  const t = batch.reward_type;
  const kind = batch.reward_target_kind;
  const target = batch.reward_target_id;
  if (!env.BACKUP_DB) return { error: 'data konten belum tersedia' };
  const B = env.BACKUP_DB;
  if (t === 'episode') {
    if (kind === 'cerpen') {
      const ex = await B.prepare(`SELECT series_id FROM cerpen_episodes WHERE series_id = ? AND season = ? AND no = ?`).bind(target, batch.reward_season || 1, batch.reward_no || 0).first();
      if (!ex) return { error: 'episode tidak ditemukan' };
      return { episodes: [{ kind: 'cerpen', target_id: target, season: batch.reward_season || 1, no: batch.reward_no || 0 }] };
    }
    if (kind === 'komik') {
      const ex = await B.prepare(`SELECT komik_id FROM cerpen_komik_episodes WHERE komik_id = ? AND no = ?`).bind(target, batch.reward_no || 0).first();
      if (!ex) return { error: 'episode tidak ditemukan' };
      return { episodes: [{ kind: 'komik', target_id: target, season: 1, no: batch.reward_no || 0 }] };
    }
    return { error: 'jenis konten tidak dikenal' };
  }
  if (t === 'season') {
    if (kind === 'cerpen') {
      const rows = await B.prepare(`SELECT season, no FROM cerpen_episodes WHERE series_id = ? AND season = ? ORDER BY no ASC`).bind(target, batch.reward_season || 1).all();
      const eps = (rows.results || []).map(r => ({ kind: 'cerpen', target_id: target, season: Number(r.season), no: Number(r.no) }));
      if (!eps.length) return { error: 'season tidak ditemukan' };
      return { episodes: eps };
    }
    if (kind === 'komik') {
      const rows = await B.prepare(`SELECT no FROM cerpen_komik_episodes WHERE komik_id = ? ORDER BY no ASC`).bind(target).all();
      const eps = (rows.results || []).map(r => ({ kind: 'komik', target_id: target, season: 1, no: Number(r.no) }));
      if (!eps.length) return { error: 'komik tidak ditemukan' };
      return { episodes: eps };
    }
    return { error: 'jenis konten tidak dikenal' };
  }
  if (t === 'series') {
    if (kind === 'cerpen') {
      const rows = await B.prepare(`SELECT season, no FROM cerpen_episodes WHERE series_id = ? ORDER BY season ASC, no ASC`).bind(target).all();
      const eps = (rows.results || []).map(r => ({ kind: 'cerpen', target_id: target, season: Number(r.season), no: Number(r.no) }));
      if (!eps.length) return { error: 'series tidak ditemukan' };
      return { episodes: eps };
    }
    if (kind === 'komik') {
      const rows = await B.prepare(`SELECT no FROM cerpen_komik_episodes WHERE komik_id = ? ORDER BY no ASC`).bind(target).all();
      const eps = (rows.results || []).map(r => ({ kind: 'komik', target_id: target, season: 1, no: Number(r.no) }));
      if (!eps.length) return { error: 'komik tidak ditemukan' };
      return { episodes: eps };
    }
    return { error: 'jenis konten tidak dikenal' };
  }
  return { error: 'jenis hadiah tidak dikenal' };
}

// ---- Identitas pemanggil (sesi akun ATAU perangkat guest) ----
function deviceFrom(request, body) {
  const q = new URL(request.url).searchParams;
  const deviceId = (body && body.device_id) || request.headers.get('x-cerpen-device') || q.get('device_id') || '';
  const androidId = (body && body.android_id) || request.headers.get('x-cerpen-android') || q.get('android_id') || '';
  return { deviceId: String(deviceId).trim(), androidId: String(androidId).trim() };
}
async function resolveCoinIdentity(request, env, body) {
  const user = await getCommenter(request, env);
  const { deviceId, androidId } = deviceFrom(request, body);
  if (user) {
    return { kind: 'user', user, userId: user.id, deviceId: isUuid(deviceId) ? deviceId : '', androidId: isAndroidId(androidId) ? androidId : '', ownerKey: 'user:' + user.id };
  }
  if (!isUuid(deviceId)) return null;
  return { kind: 'device', user: null, userId: null, deviceId, androidId: isAndroidId(androidId) ? androidId : '', ownerKey: 'device:' + deviceId };
}
// Bila bersesi + akun terkunci/banned -> respons 403, selain itu null.
async function bannedIfSession(env, ident) {
  if (!ident || ident.kind !== 'user') return null;
  if (Number(ident.user.locked) === 1) return aj({ ok: false, error: 'banned', target: 'user', reason: 'Akun dikunci oleh admin.', expires_at: null }, 403);
  const ban = await coinBanCheck(env, ident.userId);
  return ban ? bannedResponse(ban) : null;
}

// ---- Ikat perangkat ke akun + migrasi dompet/unlock guest (sekali) ----
// Perangkat yang sudah terikat ke akun LAIN: login tetap sukses, tapi
// ikatan + migrasi dilewati (perangkat tetap milik akun pertama).
async function linkDeviceAndMigrate(env, { userId, deviceId, androidId }) {
  const userKey = 'user:' + userId;
  let migrated = 0;
  if (deviceId && isUuid(deviceId)) {
    const link = await env.DB.prepare(`SELECT user_id FROM cerpen_devices WHERE device_id = ?`).bind(deviceId).first();
    const now = Date.now();
    const sameOwner = !link || link.user_id === userId;
    if (!link) {
      await env.DB.prepare(`INSERT INTO cerpen_devices (device_id, user_id, android_id, label, first_seen, last_seen) VALUES (?, ?, ?, '', ?, ?)`).bind(deviceId, userId, androidId || '', now, now).run();
    } else if (link.user_id === userId) {
      await env.DB.prepare(`UPDATE cerpen_devices SET last_seen = ?, android_id = ? WHERE device_id = ?`).bind(now, androidId || '', deviceId).run();
    }
    if (sameOwner) {
      const guestKey = 'device:' + deviceId;
      const gw = await getWallet(env, guestKey);
      const gUnlocks = await env.DB.prepare(`SELECT kind, target_id, season, no, created_at FROM cerpen_unlocks WHERE owner_key = ?`).bind(guestKey).all();
      const gList = gUnlocks.results || [];
      const gBal = gw ? Number(gw.balance) || 0 : 0;
      if (gBal > 0 || gList.length > 0) {
        const uw = await ensureWallet(env, userKey, 'user', userId, null);
        const newBal = (Number(uw.balance) || 0) + gBal;
        const stmts = [
          env.DB.prepare(`UPDATE cerpen_wallets SET balance = ?, updated_at = ? WHERE owner_key = ?`).bind(newBal, now, userKey),
          env.DB.prepare(`UPDATE cerpen_wallets SET balance = 0, updated_at = ? WHERE owner_key = ?`).bind(now, guestKey),
          ...gList.map(u => env.DB.prepare(`INSERT OR IGNORE INTO cerpen_unlocks (owner_key, kind, target_id, season, no, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(userKey, u.kind, u.target_id, u.season, u.no, u.created_at)),
          env.DB.prepare(`DELETE FROM cerpen_unlocks WHERE owner_key = ?`).bind(guestKey),
        ];
        await env.DB.batch(stmts);
        if (gBal > 0) {
          await addLedger(env, { ownerKey: userKey, userId, deviceId, delta: gBal, balanceAfter: newBal, reason: 'migrasi perangkat', ref: deviceId });
          await addLedger(env, { ownerKey: guestKey, userId: null, deviceId, delta: -gBal, balanceAfter: 0, reason: 'migrasi ke akun', ref: userId });
        }
        migrated = gBal;
      }
    }
  }
  const w = await getWallet(env, userKey);
  return { balance: w ? Number(w.balance) || 0 : 0, migrated };
}
function sessionValue(cookieStr) {
  const head = String(cookieStr || '').split(';')[0];
  return head.startsWith('cms_user=') ? head.slice('cms_user='.length) : '';
}

// ===================== Endpoint aplikasi =====================
export async function handleCoinApi(request, env, url, adminEmail) {
  const path = url.pathname;
  const ip = clientIp(request);
  const method = request.method;

  // ---- Auth aplikasi: daftar ----
  if (method === 'POST' && path === '/api/cerpen-auth/register') {
    if (!(await checkRateLimit(env, 'coin-reg:' + ip, 5, 15 * 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const email = String(body.email || '').trim().toLowerCase();
    const deviceId = String(body.device_id || '').trim();
    const androidId = String(body.android_id || '').trim();
    if (!/^[a-z0-9_]{3,20}$/.test(username) || !isValidCommenterPassword(password)) {
      return aj({ ok: false, error: 'Nama pengguna atau password tidak valid. Nama: 3–20 karakter (huruf kecil, angka, _). Password: 8–128 karakter.' }, 400);
    }
    if (username === 'admin') return aj({ ok: false, error: 'Nama pengguna atau email sudah dipakai.' }, 409);
    if (!validEmail(email) || email === String(adminEmail || '').toLowerCase()) {
      return aj({ ok: false, error: 'Email tidak valid.' }, 400);
    }
    // Batas akun per perangkat (anti-spam; BUKAN ban — perangkat tidak dibanned).
    if (isUuid(deviceId) || isAndroidId(androidId)) {
      let cntSql = `SELECT COUNT(DISTINCT user_id) AS c FROM cerpen_devices WHERE 1 = 0`;
      const args = [];
      if (isUuid(deviceId)) { cntSql = `SELECT COUNT(DISTINCT user_id) AS c FROM cerpen_devices WHERE device_id = ?`; args.push(deviceId); }
      if (isAndroidId(androidId)) {
        cntSql = args.length
          ? `SELECT COUNT(DISTINCT user_id) AS c FROM cerpen_devices WHERE device_id = ? OR android_id = ?`
          : `SELECT COUNT(DISTINCT user_id) AS c FROM cerpen_devices WHERE android_id = ?`;
        args.push(androidId);
      }
      const cnt = await env.DB.prepare(cntSql).bind(...args).first();
      if (cnt && Number(cnt.c) >= COIN_MAX_ACCOUNTS_PER_DEVICE) {
        await logCoinEvent(env, 'register_blocked', { deviceId: isUuid(deviceId) ? deviceId : '', androidId: isAndroidId(androidId) ? androidId : '', detail: 'batas akun per perangkat' });
        return aj({ ok: false, error: 'Terlalu banyak akun dibuat dari perangkat ini.' }, 403);
      }
    }
    const clash = await env.DB.prepare(`SELECT id FROM cms_users WHERE username = ?`).bind(username).first()
      || await env.DB.prepare(`SELECT id FROM cms_users WHERE email = ?`).bind(email).first();
    if (clash) return aj({ ok: false, error: 'Nama pengguna atau email sudah dipakai.' }, 409);
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    const id = 'u-' + Date.now().toString(36);
    await env.DB.prepare(`INSERT INTO cms_users (id, username, password_hash, salt, created_at, email, email_verified) VALUES (?, ?, ?, ?, ?, ?, 0)`).bind(id, username, hash, salt, new Date().toISOString(), email).run();
    if (!(await checkRateLimit(env, 'otp:' + email, OTP_SEND_LIMIT, OTP_SEND_WINDOW_MS))) {
      return aj({ ok: false, error: 'Terlalu banyak kode dikirim ke email ini. Coba lagi satu jam lagi.', needs_verification: true }, 429);
    }
    const issued = await issueOtp(env, email);
    if (!issued.ok) {
      return aj({ ok: false, error: 'Akun sudah dibuat, tapi kode verifikasi gagal dikirim (layanan email belum siap). Minta kode baru dari layar verifikasi.', needs_verification: true }, 502);
    }
    await touchDeviceWatch(env, deviceId, androidId);
    return aj({ ok: true, needs_verification: true }, 201);
  }

  // ---- Auth aplikasi: verifikasi OTP -> sesi + migrasi guest ----
  if (method === 'POST' && path === '/api/cerpen-auth/verify') {
    if (!(await checkRateLimit(env, 'coin-verify:' + ip, 10, 15 * 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const deviceId = String(body.device_id || '').trim();
    const androidId = String(body.android_id || '').trim();
    if (!validEmail(email) || !/^\d{6}$/.test(code)) return aj({ ok: false, error: 'Email atau kode tidak valid.' }, 400);
    const ok = (await verifyOtp(env, email, code)).ok;
    if (!ok) return aj({ ok: false, error: 'Kode salah atau sudah kedaluwarsa.' }, 400);
    await env.DB.prepare(`UPDATE cms_users SET email_verified = 1 WHERE email = ?`).bind(email).run();
    const user = await env.DB.prepare(`SELECT * FROM cms_users WHERE email = ?`).bind(email).first();
    if (!user) return aj({ ok: false, error: 'Akun tidak ditemukan.' }, 404);
    const ban = await coinBanCheck(env, user.id);
    if (ban) return bannedResponse(ban);
    if (Number(user.locked) === 1) return aj({ ok: false, error: 'banned', target: 'user', reason: 'Akun dikunci oleh admin.', expires_at: null }, 403);
    const session = sessionValue(await userSessionCookie(env, user.id));
    const mig = await linkDeviceAndMigrate(env, { userId: user.id, deviceId, androidId });
    await touchDeviceWatch(env, deviceId, androidId);
    return aj({ ok: true, session, username: user.username, balance: mig.balance, migrated: mig.migrated });
  }

  // ---- Auth aplikasi: kirim ulang OTP ----
  if (method === 'POST' && path === '/api/cerpen-auth/resend') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return aj({ ok: false, error: 'Email tidak valid.' }, 400);
    const user = await env.DB.prepare(`SELECT * FROM cms_users WHERE email = ?`).bind(email).first();
    if (user && Number(user.email_verified) === 0) {
      if (!(await checkRateLimit(env, 'otp:' + email, OTP_SEND_LIMIT, OTP_SEND_WINDOW_MS))) {
        return aj({ ok: false, error: 'Terlalu banyak kode dikirim. Coba lagi satu jam lagi.' }, 429);
      }
      const issued = await issueOtp(env, email);
      if (!issued.ok) return aj({ ok: false, error: 'Kode gagal dikirim (layanan email belum siap).' }, 502);
    }
    return aj({ ok: true });
  }

  // ---- Auth aplikasi: login ----
  if (method === 'POST' && path === '/api/cerpen-auth/login') {
    if (!(await checkRateLimit(env, 'coin-login:' + ip, 5, 15 * 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const deviceId = String(body.device_id || '').trim();
    const androidId = String(body.android_id || '').trim();
    // Pesan gagal generik bila password salah — status ban akun TIDAK BOLEH
    // bisa diprobe tanpa password yang benar (cek ban setelah verify).
    if (!isValidCommenterPassword(password)) {
      await logCoinEvent(env, 'login_failed', { deviceId: isUuid(deviceId) ? deviceId : '', androidId: isAndroidId(androidId) ? androidId : '', detail: 'password tidak valid' });
      return aj({ ok: false, error: 'Nama pengguna atau password salah.' }, 403);
    }
    const user = await env.DB.prepare(`SELECT * FROM cms_users WHERE username = ?`).bind(username).first();
    const pwOk = user && await verifyPassword(password, user.salt, user.password_hash);
    if (!pwOk) {
      await logCoinEvent(env, 'login_failed', { deviceId: isUuid(deviceId) ? deviceId : '', androidId: isAndroidId(androidId) ? androidId : '', userId: user ? user.id : null, detail: 'password salah' });
      return aj({ ok: false, error: 'Nama pengguna atau password salah.' }, 403);
    }
    const ban = await coinBanCheck(env, user.id);
    if (ban) return bannedResponse(ban);
    if (Number(user.locked) === 1) return aj({ ok: false, error: 'banned', target: 'user', reason: 'Akun dikunci oleh admin.', expires_at: null }, 403);
    if (Number(user.email_verified) === 0) {
      return aj({ ok: false, error: 'Akun ini belum diverifikasi. Cek email kamu untuk kode verifikasi.', needs_verification: true, email: user.email || '' }, 403);
    }
    const session = sessionValue(await userSessionCookie(env, user.id));
    const mig = await linkDeviceAndMigrate(env, { userId: user.id, deviceId, androidId });
    await touchDeviceWatch(env, deviceId, androidId);
    return aj({ ok: true, session, username: user.username, balance: mig.balance, migrated: mig.migrated });
  }

  // ---- Auth aplikasi: logout (sesi stateless — aplikasi hapus sesinya sendiri) ----
  if (method === 'POST' && path === '/api/cerpen-auth/logout') {
    const ident = await resolveCoinIdentity(request, env, null);
    if (!ident || ident.kind !== 'user') return aj({ ok: false, error: 'unauthorized' }, 401);
    return aj({ ok: true });
  }

  // ---- Koin: profil + saldo + unlock + harga (sync aplikasi) ----
  if (method === 'GET' && path === '/api/cerpen-coins/me') {
    const ident = await resolveCoinIdentity(request, env, null);
    if (!ident) return aj({ ok: false, error: 'Login dulu atau kirim device_id.' }, 401);
    const banned = await bannedIfSession(env, ident);
    if (banned) return banned;
    const w = await getWallet(env, ident.ownerKey);
    const unlocks = await env.DB.prepare(`SELECT kind, target_id, season, no FROM cerpen_unlocks WHERE owner_key = ? ORDER BY created_at ASC`).bind(ident.ownerKey).all();
    const pricing = await getPricing(env);
    const vip = ident.kind === 'user' ? await vipStatus(env, ident.userId) : { active: false, expires_at: null };
    const readingPrivate = ident.kind === 'user' ? (Number(ident.user.reading_private) === 1 ? 1 : 0) : 0;
    let devices = [];
    if (ident.kind === 'user') {
      const d = await env.DB.prepare(`SELECT device_id, android_id, label, first_seen, last_seen FROM cerpen_devices WHERE user_id = ? ORDER BY last_seen DESC`).bind(ident.userId).all();
      devices = d.results || [];
    }
    if (ident.deviceId) {
      await touchDeviceWatch(env, ident.deviceId, ident.androidId);
      if (ident.kind === 'user') {
        await env.DB.prepare(`UPDATE cerpen_devices SET last_seen = ? WHERE device_id = ? AND user_id = ?`).bind(Date.now(), ident.deviceId, ident.userId).run();
      }
    }
    return aj({
      ok: true, owner_key: ident.ownerKey,
      username: ident.user ? ident.user.username : null,
      balance: w ? Number(w.balance) || 0 : 0,
      vip, reading_private: readingPrivate,
      devices, unlocks: unlocks.results || [], pricing,
    });
  }

  // ---- Koin: harga (publik, untuk tampilan kunci di daftar) ----
  if (method === 'GET' && path === '/api/cerpen-coins/pricing') {
    const pricing = await getPricing(env);
    return new Response(JSON.stringify({ ok: true, ...pricing }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' } });
  }

  // ---- Koin: beli / unlock episode ----
  if (method === 'POST' && path === '/api/cerpen-coins/purchase') {
    if (!(await checkRateLimit(env, 'coin-buy:' + ip, 10, 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const kind = String(body.kind || '');
    const targetId = String(body.target_id || '');
    const season = Number(body.season);
    const no = Number(body.no);
    if (!['cerpen', 'komik'].includes(kind) || !isTargetId(targetId) || !Number.isInteger(season) || season < 1 || season > 99 || !Number.isInteger(no) || no < 1 || no > 9999) {
      return aj({ ok: false, error: 'Parameter tidak valid.' }, 400);
    }
    const ident = await resolveCoinIdentity(request, env, body);
    if (!ident) return aj({ ok: false, error: 'Login dulu atau kirim device_id.' }, 401);
    const banned = await bannedIfSession(env, ident);
    if (banned) return banned;
    const pricing = await getPricing(env);
    const { price, free } = priceFor(pricing, kind, targetId, no);
    const now = Date.now();
    const existing = await env.DB.prepare(`SELECT owner_key FROM cerpen_unlocks WHERE owner_key = ? AND kind = ? AND target_id = ? AND season = ? AND no = ?`).bind(ident.ownerKey, kind, targetId, season, no).first();
    if (existing) {
      const w0 = await getWallet(env, ident.ownerKey);
      return aj({ ok: true, already: true, balance: w0 ? Number(w0.balance) || 0 : 0 });
    }
    // VIP aktif: semua episode terkunci gratis, tanpa potong koin (cek
    // server-side; aplikasi tidak boleh memutuskan sendiri).
    if (ident.kind === 'user') {
      const vip = await vipStatus(env, ident.userId);
      if (vip.active) {
        await env.DB.prepare(`INSERT OR IGNORE INTO cerpen_unlocks (owner_key, kind, target_id, season, no, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(ident.ownerKey, kind, targetId, season, no, now).run();
        const wv = await getWallet(env, ident.ownerKey);
        await addLedger(env, { ownerKey: ident.ownerKey, userId: ident.userId, deviceId: ident.deviceId, delta: 0, balanceAfter: wv ? Number(wv.balance) || 0 : 0, reason: 'baca VIP', ref: kind + ':' + targetId + ':' + season + ':' + no });
        return aj({ ok: true, vip: true, vip_until: vip.expires_at, balance: wv ? Number(wv.balance) || 0 : 0 });
      }
    }
    if (free) {
      await env.DB.prepare(`INSERT OR IGNORE INTO cerpen_unlocks (owner_key, kind, target_id, season, no, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(ident.ownerKey, kind, targetId, season, no, now).run();
      await addLedger(env, { ownerKey: ident.ownerKey, userId: ident.userId, deviceId: ident.deviceId, delta: 0, balanceAfter: (await getWallet(env, ident.ownerKey))?.balance || 0, reason: 'episode gratis', ref: kind + ':' + targetId + ':' + season + ':' + no });
      const w0 = await getWallet(env, ident.ownerKey);
      return aj({ ok: true, free: true, balance: w0 ? Number(w0.balance) || 0 : 0 });
    }
    const wallet = await ensureWallet(env, ident.ownerKey, ident.kind, ident.userId, ident.deviceId || null);
    const balBefore = Number(wallet.balance) || 0;
    if (balBefore < price) {
      await logCoinEvent(env, 'purchase_failed', { deviceId: ident.deviceId, androidId: ident.androidId, userId: ident.userId, detail: 'saldo tidak cukup (' + balBefore + ' < ' + price + ')' });
      return aj({ ok: false, error: 'Saldo koin tidak cukup.', balance: balBefore, price }, 402);
    }
    // Potong kondisional atomik: bila dua request bersamaan, hanya satu
    // yang berhasil (changes==1); yang lain ditolak saldo kurang.
    const deducted = await env.DB.prepare(`UPDATE cerpen_wallets SET balance = balance - ?, updated_at = ? WHERE owner_key = ? AND balance >= ?`).bind(price, now, ident.ownerKey, price).run();
    if (!deducted || !deducted.meta || Number(deducted.meta.changes) !== 1) {
      await logCoinEvent(env, 'purchase_failed', { deviceId: ident.deviceId, androidId: ident.androidId, userId: ident.userId, detail: 'saldo tidak cukup (balapan)' });
      const w1 = await getWallet(env, ident.ownerKey);
      return aj({ ok: false, error: 'Saldo koin tidak cukup.', balance: w1 ? Number(w1.balance) || 0 : 0, price }, 402);
    }
    const balAfter = balBefore - price;
    const ins = await env.DB.prepare(`INSERT OR IGNORE INTO cerpen_unlocks (owner_key, kind, target_id, season, no, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(ident.ownerKey, kind, targetId, season, no, now).run();
    if (!ins || !ins.meta || Number(ins.meta.changes) !== 1) {
      // Balapan beli ganda: unlock sudah ada (dari request lain) — refund.
      await env.DB.prepare(`UPDATE cerpen_wallets SET balance = balance + ?, updated_at = ? WHERE owner_key = ?`).bind(price, now, ident.ownerKey).run();
      await addLedger(env, { ownerKey: ident.ownerKey, userId: ident.userId, deviceId: ident.deviceId, delta: price, balanceAfter: balBefore, reason: 'refund beli ganda', ref: kind + ':' + targetId + ':' + season + ':' + no });
      return aj({ ok: true, already: true, balance: balBefore });
    }
    await addLedger(env, { ownerKey: ident.ownerKey, userId: ident.userId, deviceId: ident.deviceId, delta: -price, balanceAfter: balAfter, reason: 'beli episode', ref: kind + ':' + targetId + ':' + season + ':' + no });
    await touchDeviceWatch(env, ident.deviceId, ident.androidId);
    return aj({ ok: true, balance: balAfter, price });
  }

  // ---- Koin: tukar kode voucher (fleksibel: koin / episode / season / series / VIP) ----
  if (method === 'POST' && path === '/api/cerpen-coins/redeem') {
    if (!(await checkRateLimit(env, 'coin-redeem:' + ip, 5, 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const code = normVoucherCode(body.code);
    if (!code || code.length < 8 || code.length > 32) return aj({ ok: false, error: 'Kode tidak valid.' }, 400);
    const ident = await resolveCoinIdentity(request, env, body);
    if (!ident) return aj({ ok: false, error: 'Login dulu atau kirim device_id.' }, 401);
    const banned = await bannedIfSession(env, ident);
    if (banned) return banned;
    if (!(await checkRateLimit(env, 'coin-redeem-owner:' + ident.ownerKey, 5, 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' }, 429);
    const fail = async (detail, status, msg) => {
      await logCoinEvent(env, 'redeem_failed', { deviceId: ident.deviceId, androidId: ident.androidId, userId: ident.userId, detail });
      return aj({ ok: false, error: msg }, status);
    };
    const codeHash = await sha256Hex(code);
    const v = await env.DB.prepare(`SELECT v.code_hash, v.batch_id, v.redeemed_count, v.active, b.reward_type, b.reward_coins, b.reward_value, b.reward_target_kind, b.reward_target_id, b.reward_season, b.reward_no, b.total_max, b.per_device_max, b.valid_from, b.expires_at, b.active AS batch_active FROM cerpen_vouchers v JOIN cerpen_voucher_batches b ON b.batch_id = v.batch_id WHERE v.code_hash = ?`).bind(codeHash).first();
    if (!v) return fail('kode tidak ditemukan', 404, 'Kode tidak ditemukan.');
    if (Number(v.active) !== 1 || Number(v.batch_active) !== 1) return fail('kode nonaktif', 409, 'Kode ini sudah dinonaktifkan.');
    // PERBAIKAN bug draf pertama: expires_at/valid_from disimpan sebagai
    // unix DETIK, jadi harus dikali 1000 sebelum dibanding Date.now() (ms).
    const nowMs = Date.now();
    if (v.valid_from && Number(v.valid_from) * 1000 > nowMs) return fail('kode belum berlaku', 409, 'Kode ini belum berlaku.');
    if (v.expires_at && Number(v.expires_at) * 1000 <= nowMs) return fail('kode kedaluwarsa', 409, 'Kode ini sudah kedaluwarsa.');
    // Batas per batch: maks per perangkat + maks per akun (bila login).
    const devCount = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_voucher_redemptions r JOIN cerpen_vouchers v ON v.code_hash = r.code_hash WHERE v.batch_id = ? AND r.device_id = ?`).bind(v.batch_id, ident.deviceId).first();
    if (devCount && Number(devCount.c) >= Number(v.per_device_max)) return fail('batas per perangkat (batch)', 409, 'Perangkat ini sudah menukar kode dari batch ini.');
    if (ident.userId) {
      const userCount = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_voucher_redemptions r JOIN cerpen_vouchers v ON v.code_hash = r.code_hash WHERE v.batch_id = ? AND r.user_id = ?`).bind(v.batch_id, ident.userId).first();
      if (userCount && Number(userCount.c) >= Number(v.per_device_max)) return fail('batas per akun (batch)', 409, 'Akun ini sudah menukar kode dari batch ini.');
    }
    const rewardType = v.reward_type || 'coins';
    // Hadiah konten: uraikan dulu (sebelum kuota dikonsumsi) — bila target
    // sudah tidak ada, kode TIDAK hangus.
    let episodes = null;
    if (['episode', 'season', 'series'].includes(rewardType)) {
      const res = await resolveVoucherEpisodes(env, v);
      if (res.error) return fail('target hadiah: ' + res.error, 409, 'Hadiah kode ini sudah tidak tersedia (' + res.error + ').');
      episodes = res.episodes;
    }
    if (rewardType === 'vip' && ident.kind !== 'user') return fail('vip butuh akun', 409, 'Hadiah VIP hanya bisa ditebus setelah login (bukan guest).');
    // Kenaikan hitungan BATCH kondisional atomik: kuota total batch tidak
    // bisa dilampaui walau banyak request bersamaan (draf pertama salah
    // menghitung kuota per kode, bukan per batch).
    const incBatch = await env.DB.prepare(`UPDATE cerpen_voucher_batches SET redeemed_count = redeemed_count + 1 WHERE batch_id = ? AND active = 1 AND redeemed_count < ?`).bind(v.batch_id, Number(v.total_max)).run();
    if (!incBatch || !incBatch.meta || Number(incBatch.meta.changes) !== 1) return fail('kuota habis', 409, 'Kuota penukaran batch ini sudah habis.');
    await env.DB.prepare(`UPDATE cerpen_vouchers SET redeemed_count = redeemed_count + 1 WHERE code_hash = ? AND active = 1`).bind(codeHash).run();
    const now = Date.now();
    const wallet = await ensureWallet(env, ident.ownerKey, ident.kind, ident.userId, ident.deviceId || null);
    const balBefore = Number(wallet.balance) || 0;
    await env.DB.prepare(`INSERT INTO cerpen_voucher_redemptions (id, code_hash, owner_key, device_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind('rd-' + randomHex(8), codeHash, ident.ownerKey, ident.deviceId, ident.userId, now).run();
    await touchDeviceWatch(env, ident.deviceId, ident.androidId);
    if (rewardType === 'coins') {
      const reward = Number(v.reward_coins ?? v.reward_value) || 0;
      const balAfter = balBefore + reward;
      await env.DB.batch([
        env.DB.prepare(`UPDATE cerpen_wallets SET balance = ?, updated_at = ? WHERE owner_key = ?`).bind(balAfter, now, ident.ownerKey),
        env.DB.prepare(`INSERT INTO cerpen_coin_ledger (id, owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind('lg-' + randomHex(8), ident.ownerKey, ident.userId, ident.deviceId, reward, balAfter, 'tukar kode', codeHash.slice(0, 8), now),
      ]);
      return aj({ ok: true, reward_type: 'coins', coins: reward, balance: balAfter });
    }
    if (rewardType === 'vip') {
      const days = Number(v.reward_value) || 0;
      const vip = await grantVip(env, ident.userId, days, 'voucher:' + v.batch_id, 'tukar kode ' + codeHash.slice(0, 8));
      await addLedger(env, { ownerKey: ident.ownerKey, userId: ident.userId, deviceId: ident.deviceId, delta: 0, balanceAfter: balBefore, reason: 'tukar kode: VIP ' + days + ' hari', ref: codeHash.slice(0, 8) });
      await coinAudit(env, 'vip_grant_voucher', 'user', ident.userId, days + ' hari via batch ' + v.batch_id);
      return aj({ ok: true, reward_type: 'vip', vip_days: days, vip_until: vip.expires_at, balance: balBefore });
    }
    // episode / season / series: unlock ditulis server-side, bukan aplikasi.
    const have = await env.DB.prepare(`SELECT kind, target_id, season, no FROM cerpen_unlocks WHERE owner_key = ?`).bind(ident.ownerKey).all();
    const haveSet = new Set((have.results || []).map(u => u.kind + ':' + u.target_id + ':' + u.season + ':' + u.no));
    const fresh = episodes.filter(e => !haveSet.has(e.kind + ':' + e.target_id + ':' + e.season + ':' + e.no));
    if (fresh.length) {
      await env.DB.batch(fresh.map(e => env.DB.prepare(`INSERT OR IGNORE INTO cerpen_unlocks (owner_key, kind, target_id, season, no, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(ident.ownerKey, e.kind, e.target_id, e.season, e.no, now)));
    }
    await addLedger(env, { ownerKey: ident.ownerKey, userId: ident.userId, deviceId: ident.deviceId, delta: 0, balanceAfter: balBefore, reason: 'tukar kode: ' + rewardLabel(v), ref: codeHash.slice(0, 8) });
    return aj({ ok: true, reward_type: rewardType, reward_label: rewardLabel(v), unlocks_granted: fresh.length, unlocks_total: episodes.length, already: fresh.length === 0, balance: balBefore });
  }

  // ---- Waktu baca aplikasi (19:17) — tulis ke tabel pelacak v81 ----
  // Algoritma sisi aplikasi sama seperti reading.js web: detik hanya dihitung
  // saat layar terlihat + ada aktivitas <15 dtk + sudah scroll ke bawah
  // sekali; flush tiap 30 dtk; pending maks 600 dtk. Server: maks 120 dtk
  // per flush, 6 flush/menit, 4 jam/hari (WIB) — sama seperti heartbeat web.
  if (method === 'POST' && path === '/api/cerpen-coins/reading') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const kind = String(body.kind || '');
    const targetId = String(body.target_id || '');
    const season = Number(body.season) || 1;
    const no = Number(body.no);
    const seconds = Number(body.seconds);
    if (!['cerpen', 'komik'].includes(kind) || !isTargetId(targetId) || !Number.isInteger(no) || no < 1 || no > 9999) {
      return aj({ ok: false, error: 'Parameter tidak valid.' }, 400);
    }
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > HEARTBEAT_MAX_SECONDS) return aj({ ok: false, error: 'detik tidak valid' }, 400);
    const ident = await resolveCoinIdentity(request, env, body);
    if (!ident) return aj({ ok: false, error: 'Login dulu atau kirim device_id.' }, 401);
    const banned = await bannedIfSession(env, ident);
    if (banned) return banned;
    if (!(await checkRateLimit(env, 'coin-reading:' + ident.ownerKey, READING_RATE_LIMIT, READING_RATE_WINDOW_MS))) return aj({ ok: false, error: 'terlalu sering' }, 429);
    const { date, hour } = { date: wibDate(Date.now()), hour: new Date(Date.now() + 7 * 3600 * 1000).getUTCHours() };
    // user_id di tabel v81 HARUS id akun mentah (bukan ownerKey
    // 'user:<id>'): leaderboard + /kendali/baca + cap harian web/app
    // berbagi tabel ini dan join ke cms_users.id. Guest tidak ditulis
    // ke tabel bersama (tidak punya username, tidak masuk papan) —
    // responsnya stored 0 + tracked false supaya aplikasi tahu.
    const todayRow = ident.kind === 'user'
      ? await env.DB.prepare(`SELECT SUM(seconds) AS total FROM cms_reading_sessions WHERE user_id = ? AND day_wib = ?`).bind(ident.userId, date).first()
      : null;
    const todayTotal = Number(todayRow && todayRow.total) || 0;
    const allowed = Math.max(0, Math.min(seconds, READING_DAILY_CAP_SECONDS - todayTotal));
    if (allowed <= 0) return aj({ ok: true, stored: 0, capped: true });
    if (ident.kind !== 'user') return aj({ ok: true, stored: 0, tracked: false, capped: false });
    const postId = postIdFor(kind, targetId, season, no);
    const maxScroll = Math.max(0, Math.min(1000, Number(body.max_scroll) || 0));
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cms_reading_sessions (user_id, day_wib, post_id, seconds, max_scroll, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, day_wib, post_id) DO UPDATE SET seconds = cms_reading_sessions.seconds + excluded.seconds, max_scroll = MAX(cms_reading_sessions.max_scroll, excluded.max_scroll), updated_at = excluded.updated_at`).bind(ident.userId, date, postId, allowed, maxScroll, nowIso),
      env.DB.prepare(`INSERT INTO cms_reading_hours (user_id, day_wib, hour_wib, seconds) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, day_wib, hour_wib) DO UPDATE SET seconds = cms_reading_hours.seconds + excluded.seconds`).bind(ident.userId, date, hour, allowed),
    ]);
    return aj({ ok: true, stored: allowed, capped: allowed < seconds });
  }

  // ---- Papan peringkat (19:17) — publik, username saja ----
  if (method === 'GET' && path === '/api/cerpen-coins/leaderboard') {
    const period = url.searchParams.get('period') === 'all' ? 'all' : 'weekly';
    const board = await getLeaderboard(env, period, 20);
    return new Response(JSON.stringify({ ok: true, period, leaderboard: board }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' } });
  }

  // ---- Riwayat konten (19:17) — yang dibeli + terakhir dibaca ----
  if (method === 'GET' && path === '/api/cerpen-coins/history') {
    const ident = await resolveCoinIdentity(request, env, null);
    if (!ident) return aj({ ok: false, error: 'Login dulu atau kirim device_id.' }, 401);
    const banned = await bannedIfSession(env, ident);
    if (banned) return banned;
    const unlocks = await env.DB.prepare(`SELECT kind, target_id, season, no, created_at FROM cerpen_unlocks WHERE owner_key = ? ORDER BY created_at DESC LIMIT 100`).bind(ident.ownerKey).all();
    // Tabel v81 keyed by id akun mentah (bukan ownerKey); guest tidak
    // punya baris di sana -> reading kosong.
    const read = ident.kind === 'user'
      ? await env.DB.prepare(`SELECT post_id, SUM(seconds) AS s, MAX(day_wib) AS last_day FROM cms_reading_sessions WHERE user_id = ? AND (post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%') GROUP BY post_id ORDER BY last_day DESC LIMIT 50`).bind(ident.userId).all()
      : { results: [] };
    const reading = (read.results || []).map(r => ({ ...(parsePostId(r.post_id) || { kind: '', target_id: r.post_id, season: 1, no: 0 }), seconds: Number(r.s) || 0, last_day: r.last_day }));
    return aj({ ok: true, unlocks: unlocks.results || [], reading });
  }

  // ---- Privasi papan peringkat (19:17) — sembunyikan diri ----
  if (method === 'POST' && path === '/api/cerpen-auth/reading-privacy') {
    const ident = await resolveCoinIdentity(request, env, null);
    if (!ident || ident.kind !== 'user') return aj({ ok: false, error: 'Butuh login akun.' }, 401);
    const banned = await bannedIfSession(env, ident);
    if (banned) return banned;
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const priv = body.private === true || body.private === 1 ? 1 : 0;
    await env.DB.prepare(`UPDATE cms_users SET reading_private = ? WHERE id = ?`).bind(priv, ident.userId).run();
    return aj({ ok: true, reading_private: priv });
  }

  return null;
}

// ===================== Endpoint admin =====================
export async function handleCoinAdmin(request, env, url, admin) {
  const path = url.pathname;
  const method = request.method;
  if (!path.startsWith('/api/admin/cerpen-koin')) return null;
  if (!admin) return aj({ ok: false, error: 'unauthorized' }, 401);
  if (String(request.headers.get('x-csrf') || '') !== await csrfToken(env)) return aj({ ok: false, error: 'csrf tidak valid' }, 403);
  if (!(await checkRateLimit(env, 'coin-admin:' + clientIp(request), 60, 10 * 60 * 1000))) return aj({ ok: false, error: 'terlalu banyak permintaan' }, 429);
  const q = (name) => url.searchParams.get(name) || '';

  // GET /api/admin/cerpen-koin/overview
  if (path === '/api/admin/cerpen-koin/overview' && method === 'GET') {
    const users = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cms_users`).first();
    const devices = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_devices`).first();
    const coins = await env.DB.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM cerpen_wallets`).first();
    const unlocks = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_unlocks`).first();
    const vouchers = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_vouchers WHERE active = 1`).first();
    const bans = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_bans WHERE target_type = 'user' AND active = 1`).first();
    const ledger24 = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_coin_ledger WHERE created_at >= ?`).bind(Date.now() - 24 * 3600 * 1000).first();
    const watched = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_device_watch WHERE watched = 1 OR auto_flag = 1`).first();
    const vipRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_vip WHERE expires_at IS NULL OR expires_at > ?`).bind(Date.now()).first();
    return aj({
      ok: true,
      users: Number(users?.c) || 0, devices: Number(devices?.c) || 0,
      coins_in_circulation: Number(coins?.s) || 0, unlocks: Number(unlocks?.c) || 0,
      active_voucher_codes: Number(vouchers?.c) || 0, active_bans: Number(bans?.c) || 0,
      ledger_24h: Number(ledger24?.c) || 0, watched_devices: Number(watched?.c) || 0,
      vip_active: Number(vipRow?.c) || 0,
    });
  }

  // GET /api/admin/cerpen-koin/users — daftar akun + saldo + perangkat + ban
  if (path === '/api/admin/cerpen-koin/users' && method === 'GET') {
    const term = q('q').trim();
    const limit = Math.min(Math.max(parseInt(q('limit') || '20', 10) || 20, 1), 50);
    let rows;
    if (term) {
      const like = '%' + term + '%';
      rows = await env.DB.prepare(`SELECT id, username, email, created_at, email_verified, locked FROM cms_users WHERE username LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT ?`).bind(like, like, limit).all();
    } else {
      rows = await env.DB.prepare(`SELECT id, username, email, created_at, email_verified, locked FROM cms_users ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    }
    const users = rows.results || [];
    const bals = await env.DB.prepare(`SELECT user_id, balance FROM cerpen_wallets WHERE user_id IS NOT NULL`).all();
    const balMap = new Map((bals.results || []).map(r => [r.user_id, Number(r.balance) || 0]));
    const devs = await env.DB.prepare(`SELECT user_id, COUNT(*) AS n FROM cerpen_devices GROUP BY user_id`).all();
    const devMap = new Map((devs.results || []).map(r => [r.user_id, Number(r.n) || 0]));
    const banRows = await env.DB.prepare(`SELECT target_id FROM cerpen_bans WHERE target_type = 'user' AND active = 1`).all();
    const banSet = new Set((banRows.results || []).map(r => r.target_id));
    return aj({ ok: true, users: users.map(u => ({ id: u.id, username: u.username, email: u.email || '', created_at: u.created_at, email_verified: Number(u.email_verified) || 0, locked: Number(u.locked) || 0, balance: balMap.get(u.id) || 0, devices: devMap.get(u.id) || 0, banned: banSet.has(u.id) })) });
  }

  // GET /api/admin/cerpen-koin/users/:id — detail akun
  const userDetail = path.match(/^\/api\/admin\/cerpen-koin\/users\/([^/]+)$/);
  if (userDetail && method === 'GET') {
    const userId = userDetail[1];
    if (!isUserId(userId)) return aj({ ok: false, error: 'user_id tidak valid' }, 400);
    const user = await env.DB.prepare(`SELECT id, username, email, created_at, email_verified, locked, reading_private FROM cms_users WHERE id = ?`).bind(userId).first();
    if (!user) return aj({ ok: false, error: 'akun tidak ditemukan' }, 404);
    const wallet = await getWallet(env, 'user:' + userId);
    const devices = await env.DB.prepare(`SELECT device_id, android_id, label, first_seen, last_seen FROM cerpen_devices WHERE user_id = ? ORDER BY last_seen DESC`).bind(userId).all();
    const unlocks = await env.DB.prepare(`SELECT kind, target_id, season, no, created_at FROM cerpen_unlocks WHERE owner_key = ? ORDER BY created_at DESC LIMIT 100`).bind('user:' + userId).all();
    const ledger = await env.DB.prepare(`SELECT delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger WHERE owner_key = ? ORDER BY created_at DESC LIMIT 50`).bind('user:' + userId).all();
    const bans = await env.DB.prepare(`SELECT id, reason, banned_by, created_at, expires_at, active, unbanned_at, unban_note FROM cerpen_bans WHERE target_type = 'user' AND target_id = ? ORDER BY created_at DESC LIMIT 10`).bind(userId).all();
    const vip = await vipStatus(env, userId);
    const readRows = await env.DB.prepare(`SELECT post_id, SUM(seconds) AS s, MAX(day_wib) AS last_day FROM cms_reading_sessions WHERE user_id = ? AND (post_id LIKE 'cerpen:%' OR post_id LIKE 'komik:%') GROUP BY post_id ORDER BY last_day DESC LIMIT 20`).bind(userId).all();
    const reading = (readRows.results || []).map(r => ({ ...(parsePostId(r.post_id) || { kind: '', target_id: r.post_id, season: 1, no: 0 }), seconds: Number(r.s) || 0, last_day: r.last_day }));
    return aj({ ok: true, user: { id: user.id, username: user.username, email: user.email || '', created_at: user.created_at, email_verified: Number(user.email_verified) || 0, locked: Number(user.locked) || 0, reading_private: Number(user.reading_private) || 0 }, balance: wallet ? Number(wallet.balance) || 0 : 0, vip, reading, devices: devices.results || [], unlocks: unlocks.results || [], ledger: ledger.results || [], bans: bans.results || [] });
  }

  // POST /api/admin/cerpen-koin/users/:id/adjust — beri/kurangi koin
  const userAdjust = path.match(/^\/api\/admin\/cerpen-koin\/users\/([^/]+)\/adjust$/);
  if (userAdjust && method === 'POST') {
    const userId = userAdjust[1];
    if (!isUserId(userId)) return aj({ ok: false, error: 'user_id tidak valid' }, 400);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const delta = Number(body.delta);
    const reason = String(body.reason || '').trim();
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > COIN_MAX_BALANCE_DELTA) return aj({ ok: false, error: 'delta harus integer bukan 0, maks ±' + COIN_MAX_BALANCE_DELTA }, 400);
    if (!reason || reason.length > 200) return aj({ ok: false, error: 'reason wajib 1–200 karakter' }, 400);
    const user = await env.DB.prepare(`SELECT id FROM cms_users WHERE id = ?`).bind(userId).first();
    if (!user) return aj({ ok: false, error: 'akun tidak ditemukan' }, 404);
    const wallet = await ensureWallet(env, 'user:' + userId, 'user', userId, null);
    const balBefore = Number(wallet.balance) || 0;
    if (delta < 0) {
      const upd = await env.DB.prepare(`UPDATE cerpen_wallets SET balance = balance + ?, updated_at = ? WHERE owner_key = ? AND balance + ? >= 0`).bind(delta, Date.now(), 'user:' + userId, delta).run();
      if (!upd || !upd.meta || Number(upd.meta.changes) !== 1) return aj({ ok: false, error: 'Saldo tidak cukup untuk dikurangi.', balance: balBefore }, 402);
    } else {
      await env.DB.prepare(`UPDATE cerpen_wallets SET balance = balance + ?, updated_at = ? WHERE owner_key = ?`).bind(delta, Date.now(), 'user:' + userId).run();
    }
    const balAfter = balBefore + delta;
    await addLedger(env, { ownerKey: 'user:' + userId, userId, deviceId: null, delta, balanceAfter: balAfter, reason: 'admin: ' + reason, ref: 'admin' });
    await coinAudit(env, 'coin_adjust', 'user', userId, (delta > 0 ? '+' : '') + delta + ' — ' + reason);
    return aj({ ok: true, user_id: userId, balance: balAfter, delta });
  }

  // POST /api/admin/cerpen-koin/users/:id/lock|unlock
  const userLock = path.match(/^\/api\/admin\/cerpen-koin\/users\/([^/]+)\/(lock|unlock)$/);
  if (userLock && method === 'POST') {
    const userId = userLock[1];
    if (!isUserId(userId)) return aj({ ok: false, error: 'user_id tidak valid' }, 400);
    const locked = userLock[2] === 'lock' ? 1 : 0;
    const user = await env.DB.prepare(`SELECT id FROM cms_users WHERE id = ?`).bind(userId).first();
    if (!user) return aj({ ok: false, error: 'akun tidak ditemukan' }, 404);
    await env.DB.prepare(`UPDATE cms_users SET locked = ? WHERE id = ?`).bind(locked, userId).run();
    await coinAudit(env, locked ? 'user_lock' : 'user_unlock', 'user', userId, '');
    return aj({ ok: true, user_id: userId, locked });
  }

  // POST /api/admin/cerpen-koin/devices/:device_id/unlink — lepas ikatan perangkat
  const devUnlink = path.match(/^\/api\/admin\/cerpen-koin\/devices\/([^/]+)\/unlink$/);
  if (devUnlink && method === 'POST') {
    const deviceId = devUnlink[1];
    if (!isUuid(deviceId)) return aj({ ok: false, error: 'device_id tidak valid' }, 400);
    const row = await env.DB.prepare(`SELECT user_id FROM cerpen_devices WHERE device_id = ?`).bind(deviceId).first();
    if (!row) return aj({ ok: false, error: 'perangkat tidak terikat ke akun mana pun' }, 404);
    await env.DB.prepare(`DELETE FROM cerpen_devices WHERE device_id = ?`).bind(deviceId).run();
    await coinAudit(env, 'device_unlink', 'device', deviceId, 'dari akun ' + row.user_id);
    return aj({ ok: true, device_id: deviceId });
  }

  // GET /api/admin/cerpen-koin/vouchers — daftar batch + kode
  if (path === '/api/admin/cerpen-koin/vouchers' && method === 'GET') {
    const batches = await env.DB.prepare(`SELECT batch_id, reward_type, reward_coins, reward_value, reward_target_kind, reward_target_id, reward_season, reward_no, total_max, per_device_max, valid_from, expires_at, redeemed_count, active, note, created_at FROM cerpen_voucher_batches ORDER BY created_at DESC LIMIT 50`).all();
    const counts = await env.DB.prepare(`SELECT batch_id, COUNT(*) AS total FROM cerpen_vouchers GROUP BY batch_id`).all();
    const cMap = new Map((counts.results || []).map(r => [r.batch_id, Number(r.total) || 0]));
    return aj({ ok: true, batches: (batches.results || []).map(b => ({ ...b, active: Number(b.active) || 0, reward_label: rewardLabel(b), codes: { total: cMap.get(b.batch_id) || 0, redeemed: Number(b.redeemed_count) || 0 } })) });
  }

  // GET /api/admin/cerpen-koin/vouchers/:batch — satu batch (untuk ubah draf)
  const batchGet = path.match(/^\/api\/admin\/cerpen-koin\/vouchers\/(vb-[0-9a-f]+)$/);
  if (batchGet && method === 'GET') {
    const b = await env.DB.prepare(`SELECT batch_id, reward_type, reward_coins, reward_value, reward_target_kind, reward_target_id, reward_season, reward_no, total_max, per_device_max, valid_from, expires_at, redeemed_count, active, note, created_at FROM cerpen_voucher_batches WHERE batch_id = ?`).bind(batchGet[1]).first();
    if (!b) return aj({ ok: false, error: 'batch tidak ditemukan' }, 404);
    return aj({ ok: true, batch: { ...b, active: Number(b.active) || 0, reward_label: rewardLabel(b) } });
  }

  // Validasi bersama untuk buat/ubah batch voucher (target konten dicek
  // keberadaannya di BACKUP_DB bila tersedia — kecuali saat dibuat sebagai
  // draf tanpa target, yang memang boleh diisi belakangan).
  async function validateVoucherReward(env, body, { allowEmptyTarget }) {
    const rewardType = String(body.reward_type || 'coins');
    if (!VOUCHER_REWARD_TYPES.includes(rewardType)) return { error: 'reward_type harus salah satu: ' + VOUCHER_REWARD_TYPES.join(', ') };
    const value = Number(body.reward_value ?? body.reward_coins);
    const targetKind = String(body.reward_target_kind || '');
    const targetId = String(body.reward_target_id || '').trim();
    const season = body.reward_season == null || body.reward_season === '' ? null : Number(body.reward_season);
    const no = body.reward_no == null || body.reward_no === '' ? null : Number(body.reward_no);
    const validFrom = body.valid_from == null || body.valid_from === '' ? null : Number(body.valid_from);
    const expiresAt = body.expires_at == null || body.expires_at === '' ? null : Number(body.expires_at);
    const nowS = Math.floor(Date.now() / 1000);
    if (rewardType === 'coins' && (!Number.isInteger(value) || value < 1 || value > 10000)) return { error: 'reward_value (koin) harus 1–10000' };
    if (rewardType === 'vip' && (!Number.isInteger(value) || value < 1 || value > 365)) return { error: 'reward_value (hari VIP) harus 1–365' };
    if (['episode', 'season', 'series'].includes(rewardType)) {
      if (!targetKind || !targetId) {
        if (!allowEmptyTarget) return { error: 'reward_target_kind + reward_target_id wajib untuk hadiah konten' };
      } else {
        if (!['cerpen', 'komik'].includes(targetKind)) return { error: 'reward_target_kind harus cerpen/komik' };
        if (!isTargetId(targetId)) return { error: 'reward_target_id tidak valid' };
        if (rewardType === 'episode' && (!Number.isInteger(season) || season < 1 || season > 99 || !Number.isInteger(no) || no < 1 || no > 9999)) return { error: 'reward_season (1–99) + reward_no (1–9999) wajib untuk hadiah episode' };
        if (rewardType === 'season' && targetKind === 'cerpen' && (!Number.isInteger(season) || season < 1 || season > 99)) return { error: 'reward_season (1–99) wajib untuk hadiah season cerpen' };
      }
    }
    if (validFrom !== null && (!Number.isInteger(validFrom) || validFrom < 0 || validFrom > nowS + 2 * 365 * 86400)) return { error: 'valid_from harus unix detik (maks 2 tahun ke depan)' };
    if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= nowS || expiresAt > nowS + 2 * 365 * 86400)) return { error: 'expires_at harus unix detik di masa depan (maks 2 tahun)' };
    if (validFrom !== null && expiresAt !== null && expiresAt <= validFrom) return { error: 'expires_at harus setelah valid_from' };
    return { rewardType, value: Number.isInteger(value) ? value : 0, targetKind: targetKind || null, targetId: targetId || null, season, no, validFrom, expiresAt };
  }

  // POST /api/admin/cerpen-koin/vouchers — buat batch (plaintext SEKALI)
  if (path === '/api/admin/cerpen-koin/vouchers' && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const count = Number(body.count);
    const totalMax = Number(body.total_max);
    const perDeviceMax = Number(body.per_device_max);
    const active = body.active === 0 || body.active === false ? 0 : 1;
    const note = String(body.note || '').trim().slice(0, 200);
    if (!Number.isInteger(count) || count < 1 || count > 500) return aj({ ok: false, error: 'count harus 1–500' }, 400);
    if (!Number.isInteger(totalMax) || totalMax < 1 || totalMax > 100000) return aj({ ok: false, error: 'total_max harus 1–100000' }, 400);
    if (!Number.isInteger(perDeviceMax) || perDeviceMax < 1 || perDeviceMax > 100) return aj({ ok: false, error: 'per_device_max harus 1–100' }, 400);
    const v = await validateVoucherReward(env, body, { allowEmptyTarget: active === 0 });
    if (v.error) return aj({ ok: false, error: v.error }, 400);
    if (active === 1 && ['episode', 'season', 'series'].includes(v.rewardType) && v.targetId) {
      const check = await resolveVoucherEpisodes(env, { reward_type: v.rewardType, reward_target_kind: v.targetKind, reward_target_id: v.targetId, reward_season: v.season, reward_no: v.no });
      if (check.error) return aj({ ok: false, error: 'target hadiah tidak ditemukan: ' + check.error }, 400);
    }
    const batchId = 'vb-' + randomHex(4);
    const now = Date.now();
    const codes = [];
    const seen = new Set();
    while (codes.length < count) {
      const c = randomVoucherCode();
      if (!seen.has(c)) { seen.add(c); codes.push(c); }
    }
    const rewardCoins = v.rewardType === 'coins' ? v.value : 0;
    await env.DB.prepare(`INSERT INTO cerpen_voucher_batches (batch_id, reward_type, reward_coins, reward_value, reward_target_kind, reward_target_id, reward_season, reward_no, total_max, per_device_max, valid_from, expires_at, redeemed_count, active, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).bind(batchId, v.rewardType, rewardCoins, v.value, v.targetKind, v.targetId, v.season, v.no, totalMax, perDeviceMax, v.validFrom, v.expiresAt, active, note, now).run();
    const stmts = [];
    for (const c of codes) {
      const h = await sha256Hex(normVoucherCode(c));
      stmts.push(env.DB.prepare(`INSERT INTO cerpen_vouchers (code_hash, batch_id, code_prefix, redeemed_count, active, created_at) VALUES (?, ?, ?, 0, 1, ?)`).bind(h, batchId, h.slice(0, 8), now));
    }
    await env.DB.batch(stmts);
    await coinAudit(env, 'voucher_batch_create', 'batch', batchId, count + ' kode × ' + rewardLabel({ reward_type: v.rewardType, reward_coins: rewardCoins, reward_value: v.value, reward_target_kind: v.targetKind, reward_target_id: v.targetId, reward_season: v.season, reward_no: v.no }) + (active ? '' : ' (draf)') + (note ? ' — ' + note : ''));
    return aj({ ok: true, batch_id: batchId, codes }, 201);
  }

  // POST /api/admin/cerpen-koin/vouchers/:batch — ubah batch DRAF (belum aktif)
  const batchUpdate = path.match(/^\/api\/admin\/cerpen-koin\/vouchers\/(vb-[0-9a-f]+)$/);
  if (batchUpdate && method === 'POST') {
    const batchId = batchUpdate[1];
    const row = await env.DB.prepare(`SELECT batch_id, active FROM cerpen_voucher_batches WHERE batch_id = ?`).bind(batchId).first();
    if (!row) return aj({ ok: false, error: 'batch tidak ditemukan' }, 404);
    if (Number(row.active) === 1) return aj({ ok: false, error: 'Batch sudah aktif — nonaktifkan dulu bila mau mengubah (target/hadiah batch aktif tidak bisa diubah).' }, 409);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const v = await validateVoucherReward(env, body, { allowEmptyTarget: true });
    if (v.error) return aj({ ok: false, error: v.error }, 400);
    const totalMax = body.total_max === undefined ? null : Number(body.total_max);
    const perDeviceMax = body.per_device_max === undefined ? null : Number(body.per_device_max);
    const note = body.note === undefined ? null : String(body.note || '').trim().slice(0, 200);
    if (totalMax !== null && (!Number.isInteger(totalMax) || totalMax < 1 || totalMax > 100000)) return aj({ ok: false, error: 'total_max harus 1–100000' }, 400);
    if (perDeviceMax !== null && (!Number.isInteger(perDeviceMax) || perDeviceMax < 1 || perDeviceMax > 100)) return aj({ ok: false, error: 'per_device_max harus 1–100' }, 400);
    const rewardCoins = v.rewardType === 'coins' ? v.value : 0;
    await env.DB.prepare(`UPDATE cerpen_voucher_batches SET reward_type = ?, reward_coins = ?, reward_value = ?, reward_target_kind = ?, reward_target_id = ?, reward_season = ?, reward_no = ?, valid_from = ?, expires_at = ? WHERE batch_id = ?`).bind(v.rewardType, rewardCoins, v.value, v.targetKind, v.targetId, v.season, v.no, v.validFrom, v.expiresAt, batchId).run();
    if (totalMax !== null) await env.DB.prepare(`UPDATE cerpen_voucher_batches SET total_max = ? WHERE batch_id = ?`).bind(totalMax, batchId).run();
    if (perDeviceMax !== null) await env.DB.prepare(`UPDATE cerpen_voucher_batches SET per_device_max = ? WHERE batch_id = ?`).bind(perDeviceMax, batchId).run();
    if (note !== null) await env.DB.prepare(`UPDATE cerpen_voucher_batches SET note = ? WHERE batch_id = ?`).bind(note, batchId).run();
    await coinAudit(env, 'voucher_batch_update', 'batch', batchId, 'draf diubah: ' + rewardLabel({ reward_type: v.rewardType, reward_coins: rewardCoins, reward_value: v.value, reward_target_kind: v.targetKind, reward_target_id: v.targetId, reward_season: v.season, reward_no: v.no }));
    return aj({ ok: true, batch_id: batchId });
  }

  // POST /api/admin/cerpen-koin/vouchers/:batch/activate — aktifkan draf
  const batchActivate = path.match(/^\/api\/admin\/cerpen-koin\/vouchers\/(vb-[0-9a-f]+)\/activate$/);
  if (batchActivate && method === 'POST') {
    const batchId = batchActivate[1];
    const b = await env.DB.prepare(`SELECT batch_id, reward_type, reward_target_kind, reward_target_id, reward_season, reward_no, active FROM cerpen_voucher_batches WHERE batch_id = ?`).bind(batchId).first();
    if (!b) return aj({ ok: false, error: 'batch tidak ditemukan' }, 404);
    if (Number(b.active) === 1) return aj({ ok: false, error: 'Batch sudah aktif.' }, 409);
    if (['episode', 'season', 'series'].includes(b.reward_type || 'coins')) {
      if (!b.reward_target_id) return aj({ ok: false, error: 'Isi dulu target konten batch ini sebelum diaktifkan.' }, 400);
      const check = await resolveVoucherEpisodes(env, b);
      if (check.error) return aj({ ok: false, error: 'target hadiah tidak ditemukan: ' + check.error }, 400);
    }
    await env.DB.prepare(`UPDATE cerpen_voucher_batches SET active = 1 WHERE batch_id = ?`).bind(batchId).run();
    await coinAudit(env, 'voucher_batch_activate', 'batch', batchId, '');
    return aj({ ok: true, batch_id: batchId, active: 1 });
  }

  // GET /api/admin/cerpen-koin/targets — daftar konten untuk dropdown voucher
  if (path === '/api/admin/cerpen-koin/targets' && method === 'GET') {
    if (!env.BACKUP_DB) return aj({ ok: false, error: 'data konten belum tersedia' }, 502);
    const kind = q('kind');
    const targetId = q('target_id');
    const series = await env.BACKUP_DB.prepare(`SELECT id, judul FROM cerpen_series ORDER BY judul ASC LIMIT 200`).all();
    const komik = await env.BACKUP_DB.prepare(`SELECT id, judul FROM cerpen_komik ORDER BY judul ASC LIMIT 200`).all();
    let seasons = [];
    let episodes = [];
    if (kind === 'cerpen' && targetId) {
      const sRows = await env.BACKUP_DB.prepare(`SELECT DISTINCT season FROM cerpen_episodes WHERE series_id = ? ORDER BY season ASC`).bind(targetId).all();
      seasons = (sRows.results || []).map(r => Number(r.season));
      const eRows = await env.BACKUP_DB.prepare(`SELECT season, no, judul FROM cerpen_episodes WHERE series_id = ? ORDER BY season ASC, no ASC LIMIT 500`).bind(targetId).all();
      episodes = eRows.results || [];
    }
    if (kind === 'komik' && targetId) {
      const eRows = await env.BACKUP_DB.prepare(`SELECT no, judul FROM cerpen_komik_episodes WHERE komik_id = ? ORDER BY no ASC LIMIT 500`).bind(targetId).all();
      episodes = eRows.results || [];
    }
    return aj({ ok: true, cerpen: series.results || [], komik: komik.results || [], seasons, episodes });
  }

  // GET /api/admin/cerpen-koin/vip — daftar VIP aktif
  if (path === '/api/admin/cerpen-koin/vip' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT user_id, expires_at, granted_by, reason, created_at FROM cerpen_vip WHERE expires_at IS NULL OR expires_at > ? ORDER BY expires_at ASC`).bind(Date.now()).all();
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
    return aj({ ok: true, vip: (rows.results || []).map(r => ({ ...r, username: nameMap.get(r.user_id) || '' })) });
  }

  // POST /api/admin/cerpen-koin/vip — beri VIP (days atau expires_at)
  if (path === '/api/admin/cerpen-koin/vip' && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const userId = String(body.user_id || '').trim();
    const reason = String(body.reason || '').trim().slice(0, 200);
    if (!isUserId(userId)) return aj({ ok: false, error: 'user_id tidak valid' }, 400);
    const user = await env.DB.prepare(`SELECT id, username FROM cms_users WHERE id = ?`).bind(userId).first();
    if (!user) return aj({ ok: false, error: 'akun tidak ditemukan' }, 404);
    let days = Number(body.days);
    const expiresAt = body.expires_at == null || body.expires_at === '' ? null : Number(body.expires_at);
    if (expiresAt !== null) {
      if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || expiresAt > Math.floor(Date.now() / 1000) + 2 * 365 * 86400) return aj({ ok: false, error: 'expires_at harus unix detik di masa depan (maks 2 tahun)' }, 400);
      days = Math.max(1, Math.ceil((expiresAt * 1000 - Date.now()) / 86400000));
    } else if (!Number.isInteger(days) || days < 1 || days > 730) {
      return aj({ ok: false, error: 'days harus 1–730 (atau isi expires_at)' }, 400);
    }
    const vip = await grantVip(env, userId, days, 'admin', reason);
    await coinAudit(env, 'vip_grant', 'user', userId, days + ' hari — ' + reason);
    return aj({ ok: true, user_id: userId, username: user.username, vip_until: vip.expires_at }, 201);
  }

  // POST /api/admin/cerpen-koin/vip/:user_id/revoke — cabut VIP
  const vipRevoke = path.match(/^\/api\/admin\/cerpen-koin\/vip\/([^/]+)\/revoke$/);
  if (vipRevoke && method === 'POST') {
    const userId = vipRevoke[1];
    if (!isUserId(userId)) return aj({ ok: false, error: 'user_id tidak valid' }, 400);
    const n = await revokeVip(env, userId);
    if (!n) return aj({ ok: false, error: 'akun ini tidak punya VIP aktif' }, 404);
    await coinAudit(env, 'vip_revoke', 'user', userId, '');
    return aj({ ok: true, user_id: userId });
  }

  // POST /api/admin/cerpen-koin/vouchers/:batch/deactivate
  const batchDeact = path.match(/^\/api\/admin\/cerpen-koin\/vouchers\/(vb-[0-9a-f]+)\/deactivate$/);
  if (batchDeact && method === 'POST') {
    const batchId = batchDeact[1];
    const row = await env.DB.prepare(`SELECT batch_id FROM cerpen_voucher_batches WHERE batch_id = ?`).bind(batchId).first();
    if (!row) return aj({ ok: false, error: 'batch tidak ditemukan' }, 404);
    await env.DB.prepare(`UPDATE cerpen_voucher_batches SET active = 0 WHERE batch_id = ?`).bind(batchId).run();
    await coinAudit(env, 'voucher_batch_deactivate', 'batch', batchId, '');
    return aj({ ok: true, batch_id: batchId, active: 0 });
  }

  // POST /api/admin/cerpen-koin/vouchers/:hash/deactivate
  const codeDeact = path.match(/^\/api\/admin\/cerpen-koin\/vouchers\/([0-9a-f]{64})\/deactivate$/);
  if (codeDeact && method === 'POST') {
    const hash = codeDeact[1];
    const row = await env.DB.prepare(`SELECT code_hash FROM cerpen_vouchers WHERE code_hash = ?`).bind(hash).first();
    if (!row) return aj({ ok: false, error: 'kode tidak ditemukan' }, 404);
    await env.DB.prepare(`UPDATE cerpen_vouchers SET active = 0 WHERE code_hash = ?`).bind(hash).run();
    await coinAudit(env, 'voucher_code_deactivate', 'code', hash.slice(0, 8), '');
    return aj({ ok: true, code_prefix: hash.slice(0, 8), active: 0 });
  }

  // GET /api/admin/cerpen-koin/pricing
  if (path === '/api/admin/cerpen-koin/pricing' && method === 'GET') {
    const pricing = await getPricing(env);
    return aj({ ok: true, ...pricing });
  }

  // POST /api/admin/cerpen-koin/pricing — default
  if (path === '/api/admin/cerpen-koin/pricing' && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const dp = body.default_price === undefined ? null : Number(body.default_price);
    const fe = body.free_episodes_default === undefined ? null : Number(body.free_episodes_default);
    if (dp !== null && (!Number.isInteger(dp) || dp < 0 || dp > 10000)) return aj({ ok: false, error: 'default_price harus 0–10000' }, 400);
    if (fe !== null && (!Number.isInteger(fe) || fe < 0 || fe > 100)) return aj({ ok: false, error: 'free_episodes_default harus 0–100' }, 400);
    if (dp !== null) await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('cerpen_coin_price_default', ?)`).bind(String(dp)).run();
    if (fe !== null) await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('cerpen_coin_free_episodes_default', ?)`).bind(String(fe)).run();
    await coinAudit(env, 'pricing_default', 'pricing', 'default', 'price=' + dp + ' free=' + fe);
    return aj({ ok: true, ...(await getPricing(env)) });
  }

  // POST /api/admin/cerpen-koin/pricing/:kind/:target — override / hapus
  const pricingOv = path.match(/^\/api\/admin\/cerpen-koin\/pricing\/([^/]+)\/([^/]+)$/);
  if (pricingOv && method === 'POST') {
    const kind = pricingOv[1];
    const target = decodeURIComponent(pricingOv[2]);
    if (!['cerpen', 'komik'].includes(kind) || !isTargetId(target)) return aj({ ok: false, error: 'kind/target tidak valid' }, 400);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    if (body.delete === true) {
      await env.DB.prepare(`DELETE FROM cerpen_coin_pricing WHERE kind = ? AND target_id = ?`).bind(kind, target).run();
      await coinAudit(env, 'pricing_override_delete', 'pricing', kind + ':' + target, '');
      return aj({ ok: true, deleted: true });
    }
    const price = Number(body.price);
    const freeEp = Number(body.free_episodes);
    if (!Number.isInteger(price) || price < 0 || price > 10000) return aj({ ok: false, error: 'price harus 0–10000' }, 400);
    if (!Number.isInteger(freeEp) || freeEp < 0 || freeEp > 100) return aj({ ok: false, error: 'free_episodes harus 0–100' }, 400);
    await env.DB.prepare(`INSERT OR REPLACE INTO cerpen_coin_pricing (kind, target_id, price, free_episodes) VALUES (?, ?, ?, ?)`).bind(kind, target, price, freeEp).run();
    await coinAudit(env, 'pricing_override_set', 'pricing', kind + ':' + target, 'price=' + price + ' free=' + freeEp);
    return aj({ ok: true, kind, target_id: target, price, free_episodes: freeEp });
  }

  // GET /api/admin/cerpen-koin/ledger
  if (path === '/api/admin/cerpen-koin/ledger' && method === 'GET') {
    const owner = q('owner').trim();
    const limit = Math.min(Math.max(parseInt(q('limit') || '50', 10) || 50, 1), 100);
    let rows;
    if (owner) {
      rows = await env.DB.prepare(`SELECT owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger WHERE owner_key = ? ORDER BY created_at DESC LIMIT ?`).bind(owner, limit).all();
    } else {
      rows = await env.DB.prepare(`SELECT owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    }
    return aj({ ok: true, ledger: rows.results || [] });
  }

  // GET /api/admin/cerpen-koin/bans — daftar ban AKUN
  if (path === '/api/admin/cerpen-koin/bans' && method === 'GET') {
    const activeOnly = q('active') !== '0';
    let rows;
    if (activeOnly) {
      rows = await env.DB.prepare(`SELECT id, target_id, reason, banned_by, created_at, expires_at, active FROM cerpen_bans WHERE target_type = 'user' AND active = 1 ORDER BY created_at DESC LIMIT 100`).all();
    } else {
      rows = await env.DB.prepare(`SELECT id, target_id, reason, banned_by, created_at, expires_at, active, unbanned_at, unban_note FROM cerpen_bans WHERE target_type = 'user' ORDER BY created_at DESC LIMIT 100`).all();
    }
    const list = rows.results || [];
    const names = new Map();
    if (list.length) {
      const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
      for (const u of (users.results || [])) names.set(u.id, u.username);
    }
    return aj({ ok: true, bans: list.map(b => ({ ...b, username: names.get(b.target_id) || '', active: Number(b.active) || 0 })) });
  }

  // POST /api/admin/cerpen-koin/bans — ban AKUN (v1: hanya user)
  if (path === '/api/admin/cerpen-koin/bans' && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const userId = String(body.user_id || '').trim();
    const reason = String(body.reason || '').trim();
    const expiresAt = body.expires_at == null || body.expires_at === '' ? null : Number(body.expires_at);
    if (!isUserId(userId)) return aj({ ok: false, error: 'user_id tidak valid' }, 400);
    if (!reason || reason.length > 500) return aj({ ok: false, error: 'reason wajib 1–500 karakter' }, 400);
    if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || expiresAt > Math.floor(Date.now() / 1000) + 2 * 365 * 86400)) return aj({ ok: false, error: 'expires_at harus unix detik di masa depan (maks 2 tahun)' }, 400);
    const user = await env.DB.prepare(`SELECT id, username FROM cms_users WHERE id = ?`).bind(userId).first();
    if (!user) return aj({ ok: false, error: 'akun tidak ditemukan' }, 404);
    const id = 'ban-' + randomHex(6);
    try {
      await env.DB.prepare(`INSERT INTO cerpen_bans (id, target_type, target_id, reason, banned_by, created_at, expires_at, active) VALUES (?, 'user', ?, ?, 'admin', ?, ?, 1)`).bind(id, userId, reason, Date.now(), expiresAt).run();
    } catch (e) {
      return aj({ ok: false, error: 'Akun ini sudah dibanned (cabut dulu bila mau ban lagi).' }, 409);
    }
    await coinAudit(env, 'ban_create', 'user', userId, reason + (expiresAt ? ' sampai ' + wibText(expiresAt * 1000) : ' (permanen)'));
    return aj({ ok: true, id, user_id: userId, username: user.username, reason, expires_at: expiresAt }, 201);
  }

  // POST /api/admin/cerpen-koin/bans/:id/unban
  const banUnban = path.match(/^\/api\/admin\/cerpen-koin\/bans\/([^/]+)\/unban$/);
  if (banUnban && method === 'POST') {
    const banId = banUnban[1];
    if (!/^ban-[0-9a-f]+$/.test(banId)) return aj({ ok: false, error: 'ban_id tidak valid' }, 400);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const note = String(body.note || '').trim().slice(0, 500);
    const upd = await env.DB.prepare(`UPDATE cerpen_bans SET active = 0, unbanned_at = ?, unbanned_by = 'admin', unban_note = ? WHERE id = ? AND active = 1`).bind(Date.now(), note, banId).run();
    if (!upd || !upd.meta || Number(upd.meta.changes) !== 1) return aj({ ok: false, error: 'ban tidak ditemukan atau sudah dicabut' }, 404);
    const row = await env.DB.prepare(`SELECT target_id FROM cerpen_bans WHERE id = ?`).bind(banId).first();
    await coinAudit(env, 'ban_unban', 'user', row ? row.target_id : banId, note);
    return aj({ ok: true, id: banId });
  }

  // GET /api/admin/cerpen-koin/devices — daftar pantauan
  if (path === '/api/admin/cerpen-koin/devices' && method === 'GET') {
    const list = await listDevicesWithFlags(env, { q: q('q').trim(), limit: Math.min(Math.max(parseInt(q('limit') || '20', 10) || 20, 1), 50) });
    return aj({ ok: true, devices: list });
  }

  // GET /api/admin/cerpen-koin/devices/:device_id — detail perangkat
  const devDetail = path.match(/^\/api\/admin\/cerpen-koin\/devices\/([^/]+)$/);
  if (devDetail && method === 'GET') {
    const deviceId = devDetail[1];
    if (!isUuid(deviceId)) return aj({ ok: false, error: 'device_id tidak valid' }, 400);
    const watch = await env.DB.prepare(`SELECT device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at FROM cerpen_device_watch WHERE device_id = ?`).bind(deviceId).first();
    const links = await env.DB.prepare(`SELECT device_id, user_id, android_id, first_seen, last_seen FROM cerpen_devices WHERE device_id = ? ORDER BY last_seen DESC`).bind(deviceId).all();
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
    const ledger = await env.DB.prepare(`SELECT owner_key, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger WHERE device_id = ? ORDER BY created_at DESC LIMIT 50`).bind(deviceId).all();
    const redemptions = await env.DB.prepare(`SELECT code_hash, owner_key, user_id, created_at FROM cerpen_voucher_redemptions WHERE device_id = ? ORDER BY created_at DESC LIMIT 50`).bind(deviceId).all();
    const unlocks = await env.DB.prepare(`SELECT kind, target_id, season, no, created_at FROM cerpen_unlocks WHERE owner_key = ? ORDER BY created_at DESC LIMIT 100`).bind('device:' + deviceId).all();
    const events = await env.DB.prepare(`SELECT kind, detail, created_at FROM cerpen_coin_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 100`).bind(deviceId).all();
    return aj({
      ok: true,
      device: watch || { device_id: deviceId, android_id: '', watched: 0, auto_flag: 0, flag_reason: '', note: '', created_at: null, updated_at: null },
      links: (links.results || []).map(l => ({ ...l, username: nameMap.get(l.user_id) || '' })),
      ledger: ledger.results || [], redemptions: redemptions.results || [],
      unlocks: unlocks.results || [], events: events.results || [],
    });
  }

  // POST /api/admin/cerpen-koin/devices/:device_id/watch — tandai pantau
  const devWatch = path.match(/^\/api\/admin\/cerpen-koin\/devices\/([^/]+)\/watch$/);
  if (devWatch && method === 'POST') {
    const deviceId = devWatch[1];
    if (!isUuid(deviceId)) return aj({ ok: false, error: 'device_id tidak valid' }, 400);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const watched = body.watched === 1 || body.watched === true ? 1 : 0;
    const note = String(body.note || '').trim().slice(0, 200);
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO cerpen_device_watch (device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at) VALUES (?, '', ?, 0, '', ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET watched = ?, note = ?, updated_at = ?`).bind(deviceId, watched, note, now, now, watched, note, now).run();
    await coinAudit(env, watched ? 'device_watch' : 'device_unwatch', 'device', deviceId, note);
    return aj({ ok: true, device_id: deviceId, watched });
  }

  return aj({ ok: false, error: 'endpoint tidak dikenal' }, 404);
}

// ---- Daftar pantauan: agregat aktivitas + penanda otomatis ----
async function listDevicesWithFlags(env, { q: term, limit }) {
  const now = Date.now();
  const since24 = now - WATCH_WINDOW_MS;
  let watchRows;
  if (term) {
    const like = '%' + term + '%';
    watchRows = await env.DB.prepare(`SELECT device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at FROM cerpen_device_watch WHERE device_id LIKE ? OR android_id LIKE ? ORDER BY updated_at DESC LIMIT ?`).bind(like, like, limit).all();
  } else {
    watchRows = await env.DB.prepare(`SELECT device_id, android_id, watched, auto_flag, flag_reason, note, created_at, updated_at FROM cerpen_device_watch ORDER BY updated_at DESC LIMIT ?`).bind(limit).all();
  }
  const devices = watchRows.results || [];
  if (!devices.length) return [];
  // Agregat sekali jalan (GROUP BY), digabung di JS — bukan N+1 query.
  const accounts = await env.DB.prepare(`SELECT device_id, COUNT(DISTINCT user_id) AS n FROM cerpen_devices GROUP BY device_id`).all();
  const accountsByAndroid = await env.DB.prepare(`SELECT android_id, COUNT(DISTINCT user_id) AS n FROM cerpen_devices WHERE android_id != '' GROUP BY android_id`).all();
  const ledgerN = await env.DB.prepare(`SELECT device_id, COUNT(*) AS n FROM cerpen_coin_ledger GROUP BY device_id`).all();
  const redeemN = await env.DB.prepare(`SELECT device_id, COUNT(*) AS n FROM cerpen_voucher_redemptions GROUP BY device_id`).all();
  const unlockN = await env.DB.prepare(`SELECT owner_key, COUNT(*) AS n FROM cerpen_unlocks GROUP BY owner_key`).all();
  const fail24 = await env.DB.prepare(`SELECT device_id, COUNT(*) AS n FROM cerpen_coin_events WHERE kind = 'redeem_failed' AND created_at >= ? GROUP BY device_id`).bind(since24).all();
  const codes24 = await env.DB.prepare(`SELECT device_id, COUNT(DISTINCT code_hash) AS n FROM cerpen_voucher_redemptions WHERE created_at >= ? GROUP BY device_id`).bind(since24).all();
  const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
  const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
  const links = await env.DB.prepare(`SELECT device_id, user_id FROM cerpen_devices`).all();
  const linkMap = new Map();
  for (const l of (links.results || [])) {
    if (!linkMap.has(l.device_id)) linkMap.set(l.device_id, []);
    linkMap.get(l.device_id).push({ user_id: l.user_id, username: nameMap.get(l.user_id) || '' });
  }
  const toMap = (rows) => new Map((rows.results || []).map(r => [r.device_id || r.owner_key, Number(r.n) || 0]));
  const mAccounts = toMap(accounts), mAccountsAndroid = toMap(accountsByAndroid), mLedger = toMap(ledgerN),
    mRedeem = toMap(redeemN), mUnlock = toMap(unlockN), mFail24 = toMap(fail24), mCodes24 = toMap(codes24);
  const out = [];
  const updates = [];
  for (const d of devices) {
    const accountsN = Math.max(mAccounts.get(d.device_id) || 0, mAccountsAndroid.get(d.android_id) || 0);
    const f24 = mFail24.get(d.device_id) || 0;
    const c24 = mCodes24.get(d.device_id) || 0;
    let flagReason = '';
    if (accountsN >= COIN_MAX_ACCOUNTS_PER_DEVICE) flagReason = 'banyak akun (' + accountsN + ' akun dari perangkat ini)';
    else if (f24 >= COIN_WATCH_FAIL_REDEEM_24H) flagReason = 'banyak gagal redeem (' + f24 + 'x dalam 24 jam)';
    else if (c24 >= COIN_WATCH_CODES_24H) flagReason = 'banyak kode ditukar (' + c24 + ' kode berbeda dalam 24 jam)';
    const autoFlag = flagReason ? 1 : 0;
    if (autoFlag !== (Number(d.auto_flag) || 0) || (autoFlag && flagReason !== String(d.flag_reason || ''))) {
      updates.push(env.DB.prepare(`UPDATE cerpen_device_watch SET auto_flag = ?, flag_reason = ?, updated_at = ? WHERE device_id = ?`).bind(autoFlag, flagReason, now, d.device_id));
    }
    out.push({
      device_id: d.device_id, android_id: d.android_id || '',
      watched: Number(d.watched) || 0, auto_flag: autoFlag, flag_reason: flagReason,
      note: d.note || '', created_at: d.created_at, updated_at: d.updated_at,
      accounts: accountsN, accounts_detail: linkMap.get(d.device_id) || [],
      ledger_n: mLedger.get(d.device_id) || 0, redeem_n: mRedeem.get(d.device_id) || 0,
      unlock_n: mUnlock.get('device:' + d.device_id) || 0,
      fail_redeem_24h: f24, codes_24h: c24,
      status: autoFlag ? 'perlu perhatian' : (Number(d.watched) ? 'dipantau' : 'normal'),
    });
  }
  if (updates.length) await env.DB.batch(updates);
  return out;
}

// ===================== Panel admin /kendali/koin =====================
// Dipanggil worker.js dari cabang GET /kendali (admin sudah terverifikasi).
// Semua aksi lewat fetch ke /api/admin/cerpen-koin/* dengan header x-csrf.
export async function renderCoinPanel(env, csrf, nav, notice) {
  const wib = v => { const n = Number(v || 0); const ms = (n > 0 && n < 1e12) ? n * 1000 : n; return new Date(ms + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16); };
  const users = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cms_users`).first();
  const devices = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_devices`).first();
  const coins = await env.DB.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM cerpen_wallets`).first();
  const unlocks = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_unlocks`).first();
  const vouchers = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_vouchers WHERE active = 1`).first();
  const bans = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_bans WHERE target_type = 'user' AND active = 1`).first();
  const watched = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_device_watch WHERE watched = 1 OR auto_flag = 1`).first();
  const pricing = await getPricing(env);
  const userRows = await env.DB.prepare(`SELECT id, username, email, created_at, email_verified, locked FROM cms_users ORDER BY created_at DESC LIMIT 20`).all();
  const bals = await env.DB.prepare(`SELECT user_id, balance FROM cerpen_wallets WHERE user_id IS NOT NULL`).all();
  const balMap = new Map((bals.results || []).map(r => [r.user_id, Number(r.balance) || 0]));
  const banRows = await env.DB.prepare(`SELECT id, target_id, reason, banned_by, created_at, expires_at FROM cerpen_bans WHERE target_type = 'user' AND active = 1 ORDER BY created_at DESC LIMIT 50`).all();
  const allUsers = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
  const nameMap = new Map((allUsers.results || []).map(u => [u.id, u.username]));
  const vipRows = await env.DB.prepare(`SELECT user_id, expires_at, granted_by, reason, created_at FROM cerpen_vip WHERE expires_at IS NULL OR expires_at > ? ORDER BY expires_at ASC`).bind(Date.now()).all();
  const vipHtml = (vipRows.results || []).map(v => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(nameMap.get(v.user_id) || v.user_id)}</span><div class="adm-row-meta">sampai ${wib(v.expires_at)}${v.reason ? ' · ' + esc(v.reason) : ''}</div></div><button type="button" data-koin-vip-revoke="${esc(v.user_id)}">Cabut VIP</button></div>`).join('') || '<p>Tidak ada VIP aktif.</p>';
  const boardWeekly = await getLeaderboard(env, 'weekly', 10);
  const boardAll = await getLeaderboard(env, 'all', 10);
  const boardHtml = (title, list) => `<h4>${title}</h4>` + (list.map(r => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${r.rank}. ${esc(r.username)}</span><div class="adm-row-meta">${r.minutes} menit (${r.seconds} detik)</div></div></div>`).join('') || '<p>Belum ada data.</p>');
  let targetOptions = '';
  try {
    if (env.BACKUP_DB) {
      const [sRows, kRows] = await Promise.all([
        env.BACKUP_DB.prepare(`SELECT id, judul FROM cerpen_series ORDER BY judul ASC LIMIT 200`).all(),
        env.BACKUP_DB.prepare(`SELECT id, judul FROM cerpen_komik ORDER BY judul ASC LIMIT 200`).all(),
      ]);
      targetOptions = [...(sRows.results || []).map(r => `<option value="${esc(r.id)}">${esc(r.judul)} (cerpen)</option>`), ...(kRows.results || []).map(r => `<option value="${esc(r.id)}">${esc(r.judul)} (komik)</option>`)].join('');
    }
  } catch (e) { /* dropdown target opsional — admin tetap bisa ketik ID manual */ }
  const ledgerRows = await env.DB.prepare(`SELECT owner_key, user_id, device_id, delta, balance_after, reason, ref, created_at FROM cerpen_coin_ledger ORDER BY created_at DESC LIMIT 20`).all();
  const auditRows = await env.DB.prepare(`SELECT action, target_type, target_id, note, created_at FROM coin_admin_audit ORDER BY created_at DESC LIMIT 20`).all();
  const watchList = await listDevicesWithFlags(env, { q: '', limit: 20 });
  const ovRows = Object.entries(pricing.overrides).map(([k, v]) => {
    const [kind, target] = k.split(':');
    return `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(kind)}:${esc(target)}</span><div class="adm-row-meta">${v.price} koin · ${v.free_episodes} episode gratis</div></div><button type="button" data-koin-pricing-del="${esc(kind)}:${esc(target)}" style="background:#dc2626">Hapus</button></div>`;
  }).join('') || '<p>Belum ada override per series.</p>';
  const userHtml = (userRows.results || []).map(u => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(u.username)}</span><div class="adm-row-meta">${esc(u.email || '')} · saldo <b>${balMap.get(u.id) || 0} koin</b> · sejak ${esc(String(u.created_at || '').slice(0, 10))}${Number(u.locked) ? ' · 🔒 terkunci' : ''}${Number(u.email_verified) === 0 ? ' · belum verifikasi' : ''}</div></div><button type="button" data-koin-user="${esc(u.id)}">Detail</button></div>`).join('') || '<p>Belum ada akun.</p>';
  const banHtml = (banRows.results || []).map(b => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(nameMap.get(b.target_id) || b.target_id)}</span><div class="adm-row-meta">${esc(b.reason)} · sejak ${wib(b.created_at)} · ${b.expires_at ? 'sampai ' + wib(Number(b.expires_at) * 1000) : 'PERMANEN'}</div></div><button type="button" data-koin-unban="${esc(b.id)}">Unban</button></div>`).join('') || '<p>Tidak ada ban aktif.</p>';
  const watchHtml = watchList.map(d => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${d.status === 'perlu perhatian' ? '⚠' : d.status === 'dipantau' ? '👁' : ''} <code>${esc(String(d.device_id).slice(0, 8))}…</code></span><div class="adm-row-meta">${d.accounts_detail.map(a => esc(a.username)).join(', ') || 'guest'} · ${d.accounts} akun · ${d.redeem_n} redeem · ${d.unlock_n} unlock · terakhir ${wib(d.updated_at)}${d.flag_reason ? ' · ' + esc(d.flag_reason) : ''}</div></div><button type="button" data-koin-device="${esc(d.device_id)}">Detail</button> <button type="button" data-koin-watch="${esc(d.device_id)}" data-watched="${d.watched ? 0 : 1}">${d.watched ? 'Berhenti pantau' : 'Pantau'}</button></div>`).join('') || '<p>Belum ada perangkat tercatat.</p>';
  const ledgerHtml = (ledgerRows.results || []).map(l => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${Number(l.delta) > 0 ? '+' : ''}${l.delta} koin → saldo ${l.balance_after}</span><div class="adm-row-meta">${esc(l.owner_key)} · ${esc(l.reason)}${l.ref ? ' · ' + esc(l.ref) : ''} · ${wib(l.created_at)}</div></div></div>`).join('') || '<p>Belum ada mutasi.</p>';
  const auditHtml = (auditRows.results || []).map(a => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(a.action)}</span><div class="adm-row-meta">${esc(a.target_type)}:${esc(a.target_id)}${a.note ? ' · ' + esc(a.note) : ''} · ${wib(a.created_at)}</div></div></div>`).join('') || '<p>Belum ada audit.</p>';
  return `<h2>Koin Cerpen</h2>${nav}${notice}<div id="koin-msg"></div>
<div class="card"><h3>Ringkasan</h3><div class="adm-stats">
<div class="adm-stat"><span class="adm-stat-num">${Number(users?.c) || 0}</span><span class="adm-stat-label">Akun</span></div>
<div class="adm-stat"><span class="adm-stat-num">${Number(devices?.c) || 0}</span><span class="adm-stat-label">Perangkat terikat</span></div>
<div class="adm-stat"><span class="adm-stat-num">${Number(coins?.s) || 0}</span><span class="adm-stat-label">Koin beredar</span></div>
<div class="adm-stat"><span class="adm-stat-num">${Number(unlocks?.c) || 0}</span><span class="adm-stat-label">Unlock</span></div>
<div class="adm-stat"><span class="adm-stat-num">${Number(vouchers?.c) || 0}</span><span class="adm-stat-label">Kode voucher aktif</span></div>
<div class="adm-stat"><span class="adm-stat-num">${Number(bans?.c) || 0}</span><span class="adm-stat-label">Akun dibanned</span></div>
<div class="adm-stat"><span class="adm-stat-num">${(vipRows.results || []).length}</span><span class="adm-stat-label">VIP aktif</span></div>
<div class="adm-stat"><span class="adm-stat-num">${Number(watched?.c) || 0}</span><span class="adm-stat-label">Perangkat dipantau</span></div>
</div></div>
<div class="card"><h3>Harga</h3><form id="koin-pricing-form"><label>Harga default per episode (koin)<input name="default_price" type="number" min="0" max="10000" value="${pricing.default_price}" required></label><label>Episode gratis per series (default)<input name="free_episodes_default" type="number" min="0" max="100" value="${pricing.free_episodes_default}" required></label><p><button type="submit">Simpan Harga Default</button></p></form><h4>Override per series/komik</h4>${ovRows}<form id="koin-pricing-ov-form"><label>Jenis<select name="kind"><option value="cerpen">cerpen</option><option value="komik">komik</option></select></label><label>ID series/komik<input name="target_id" required maxlength="64" placeholder="mis. cerpen-01"></label><label>Harga (koin)<input name="price" type="number" min="0" max="10000" value="10" required></label><label>Episode gratis<input name="free_episodes" type="number" min="0" max="100" value="1" required></label><p><button type="submit">Simpan Override</button></p></form></div>
<div class="card"><h3>Akun</h3><form id="koin-user-search" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><label style="margin:0">Cari<input name="q" maxlength="64" placeholder="username / email"></label><button type="submit">Cari</button></form><div id="koin-users">${userHtml}</div><div class="card" id="koin-user-detail" hidden><h3>Detail akun</h3><div id="koin-user-detail-body"><p>Pilih tombol Detail pada salah satu akun.</p></div></div></div>
<div class="card"><h3>Voucher</h3><form id="koin-voucher-form"><label>Jenis hadiah<select name="reward_type" id="koin-reward-type"><option value="coins">Koin</option><option value="episode">Unlock 1 episode</option><option value="season">Unlock 1 season penuh</option><option value="series">Unlock 1 series penuh</option><option value="vip">VIP (hari)</option></select></label><label id="koin-reward-value-label">Reward per kode (koin)<input name="reward_value" type="number" min="1" max="10000" value="50" required></label><div id="koin-target-fields" hidden><label>Jenis konten<select name="reward_target_kind"><option value="cerpen">cerpen</option><option value="komik">komik</option></select></label><label>Target (ID series/komik)<input name="reward_target_id" list="koin-target-list" maxlength="64" placeholder="mis. cerpen-01"></label><datalist id="koin-target-list">${targetOptions}</datalist><label>Season (cerpen)<input name="reward_season" type="number" min="1" max="99" value="1"></label><label>No. episode<input name="reward_no" type="number" min="1" max="9999" value="1"></label></div><label>Jumlah kode<input name="count" type="number" min="1" max="500" value="10" required></label><label>Maks total penukaran<input name="total_max" type="number" min="1" max="100000" value="10" required></label><label>Maks per akun/perangkat<input name="per_device_max" type="number" min="1" max="100" value="1" required></label><label>Berlaku mulai (opsional)<input name="valid_from" type="datetime-local"></label><label>Kedaluwarsa (opsional)<input name="expires_at" type="datetime-local"></label><label>Catatan<input name="note" maxlength="200" placeholder="mis. event akhir pekan"></label><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="draft" value="1"> Buat sebagai draf (belum aktif — target/hadiah masih bisa diubah, lalu Aktifkan)</label><p><button type="submit">Buat Batch Voucher</button></p><p style="font-size:13px;opacity:.7">Kode plaintext tampil SEKALI di bawah setelah dibuat — salin segera. Di database hanya hash-nya yang disimpan. Batch draf bisa diubah (target/hadiah/waktu/limit) sampai diaktifkan; batch aktif tidak bisa diubah hadiahnya.</p></form><div id="koin-codes" hidden><h4>Kode batch baru (salin sekarang)</h4><pre id="koin-codes-pre" style="white-space:pre-wrap;word-break:break-all"></pre><p><button type="button" id="koin-codes-copy">Salin Semua Kode</button></p></div><div id="koin-batches"></div></div>
<div class="card"><h3>VIP</h3><p style="font-size:13px;opacity:.7">Selama VIP aktif, semua episode terkunci bisa dibaca gratis (tanpa potong koin). VIP diberikan lewat panel ini atau voucher khusus — bukan dibeli pakai koin di v1.</p><form id="koin-vip-form"><label>ID akun (u-...)<input name="user_id" required maxlength="64" placeholder="u-..."></label><label>Lama (hari)<input name="days" type="number" min="1" max="730" value="30" required></label><label>Alasan<input name="reason" maxlength="200" placeholder="mis. pemenang event"></label><p><button type="submit">Beri VIP</button></p></form><h4>VIP aktif</h4><div id="koin-vips">${vipHtml}</div></div>
<div class="card"><h3>Papan Peringkat (waktu baca)</h3><p style="font-size:13px;opacity:.7">Dari pelacak waktu baca v81 (hanya bacaan Cerpen di aplikasi). Akun dengan reading_private=1 tidak tampil.</p>${boardHtml('Mingguan (7 hari terakhir)', boardWeekly)}${boardHtml('Sepanjang waktu', boardAll)}</div>
<div class="card"><h3>Ban Akun</h3><p style="font-size:13px;opacity:.7">Ban hanya untuk AKUN. Perangkat tidak dibanned — lihat Daftar Pantauan di bawah.</p><form id="koin-ban-form"><label>ID akun (u-...)<input name="user_id" required maxlength="64" placeholder="u-..."></label><label>Alasan (wajib)<input name="reason" required maxlength="500" placeholder="mis. spam kode voucher"></label><label>Sampai (kosong = permanen)<input name="expires_at" type="datetime-local"></label><p><button type="submit" style="background:#dc2626">Ban Akun</button></p></form><h4>Ban aktif</h4><div id="koin-bans">${banHtml}</div></div>
<div class="card"><h3>Daftar Pantauan Perangkat</h3><p style="font-size:13px;opacity:.7">Pantauan BUKAN hukuman — perangkat yang dipantau tetap bisa memakai aplikasi normal. Tanda ⚠ "perlu perhatian" dibuat otomatis oleh pola mencurigakan (≥3 akun, ≥5 gagal redeem/24 jam, ≥5 kode berbeda/24 jam) dan tidak memblokir apa pun.</p><div id="koin-devices">${watchHtml}</div><div class="card" id="koin-device-detail" hidden><h3>Detail perangkat</h3><div id="koin-device-detail-body"><p>Pilih tombol Detail pada salah satu perangkat.</p></div></div></div>
<div class="card"><h3>Ledger (20 mutasi terakhir)</h3>${ledgerHtml}</div>
<div class="card"><h3>Riwayat admin (audit)</h3>${auditHtml}</div>
<script>
const COIN_CSRF = "${csrf}";
const koinMsg = document.getElementById('koin-msg');
function koinSay(t, ok) { koinMsg.innerHTML = '<div class="card"><p>' + t + '</p></div>'; koinMsg.scrollIntoView(); }
async function koinFetch(url, method, body) {
  const res = await fetch(url, { method: method, headers: { 'x-csrf': COIN_CSRF, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (!res.ok || j.ok === false) throw new Error(j.error || ('gagal (' + res.status + ')'));
  return j;
}
function koinNum(v, d) { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; }
function koinDtLocal(v) { if (!v) return null; const t = Date.parse(v); return Number.isNaN(t) ? null : Math.floor(t / 1000); }
document.getElementById('koin-pricing-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { const j = await koinFetch('/api/admin/cerpen-koin/pricing', 'POST', { default_price: koinNum(f.get('default_price'), 10), free_episodes_default: koinNum(f.get('free_episodes_default'), 1) }); koinSay('Harga default disimpan: ' + j.default_price + ' koin, ' + j.free_episodes_default + ' episode gratis.', true); } catch (err) { koinSay(err.message); }
});
document.getElementById('koin-pricing-ov-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const kind = String(f.get('kind') || 'cerpen'), target = String(f.get('target_id') || '').trim();
  try { await koinFetch('/api/admin/cerpen-koin/pricing/' + encodeURIComponent(kind) + '/' + encodeURIComponent(target), 'POST', { price: koinNum(f.get('price'), 10), free_episodes: koinNum(f.get('free_episodes'), 1) }); koinSay('Override disimpan untuk ' + kind + ':' + target + '. Muat ulang halaman untuk melihat daftar.', true); } catch (err) { koinSay(err.message); }
});
document.getElementById('koin-user-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = new FormData(e.target).get('q') || '';
  try {
    const j = await koinFetch('/api/admin/cerpen-koin/users?q=' + encodeURIComponent(q) + '&limit=20', 'GET');
    document.getElementById('koin-users').innerHTML = j.users.map(u => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + u.username + '</span><div class="adm-row-meta">' + (u.email || '') + ' · saldo <b>' + u.balance + ' koin</b>' + (u.locked ? ' · 🔒 terkunci' : '') + (u.banned ? ' · 🚫 dibanned' : '') + '</div></div><button type="button" data-koin-user="' + u.id + '">Detail</button></div>').join('') || '<p>Tidak ada akun.</p>';
  } catch (err) { koinSay(err.message); }
});
document.getElementById('koin-reward-type').addEventListener('change', (e) => {
  const t = e.target.value;
  const targetFields = document.getElementById('koin-target-fields');
  const valueLabel = document.getElementById('koin-reward-value-label');
  const valueInput = valueLabel.querySelector('input');
  targetFields.hidden = !['episode', 'season', 'series'].includes(t);
  if (t === 'coins') { valueLabel.childNodes[0].textContent = 'Reward per kode (koin)'; valueInput.min = '1'; valueInput.max = '10000'; valueInput.value = '50'; }
  if (t === 'vip') { valueLabel.childNodes[0].textContent = 'Reward per kode (hari VIP)'; valueInput.min = '1'; valueInput.max = '365'; valueInput.value = '30'; }
  if (['episode', 'season', 'series'].includes(t)) { valueLabel.childNodes[0].textContent = 'Nilai (tidak dipakai untuk hadiah konten)'; valueInput.min = '0'; valueInput.max = '0'; valueInput.value = '0'; }
});
document.getElementById('koin-voucher-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const rewardType = String(f.get('reward_type') || 'coins');
  try {
    const j = await koinFetch('/api/admin/cerpen-koin/vouchers', 'POST', { reward_type: rewardType, reward_value: koinNum(f.get('reward_value'), rewardType === 'coins' ? 50 : 0), reward_target_kind: String(f.get('reward_target_kind') || ''), reward_target_id: String(f.get('reward_target_id') || '').trim(), reward_season: f.get('reward_season') === '' ? null : koinNum(f.get('reward_season'), 1), reward_no: f.get('reward_no') === '' ? null : koinNum(f.get('reward_no'), 1), count: koinNum(f.get('count'), 10), total_max: koinNum(f.get('total_max'), 10), per_device_max: koinNum(f.get('per_device_max'), 1), valid_from: koinDtLocal(f.get('valid_from')), expires_at: koinDtLocal(f.get('expires_at')), active: f.get('draft') ? 0 : 1, note: String(f.get('note') || '') });
    document.getElementById('koin-codes-pre').textContent = j.codes.join('\\n');
    document.getElementById('koin-codes').hidden = false;
    koinSay('Batch ' + j.batch_id + ' dibuat: ' + j.codes.length + ' kode. Salin sekarang — kode tidak akan ditampilkan lagi.', true);
  } catch (err) { koinSay(err.message); }
});
document.getElementById('koin-vip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const j = await koinFetch('/api/admin/cerpen-koin/vip', 'POST', { user_id: String(f.get('user_id') || '').trim(), days: koinNum(f.get('days'), 30), reason: String(f.get('reason') || '') });
    koinSay('VIP diberikan ke ' + j.username + ' sampai ' + new Date(j.vip_until).toLocaleString('id-ID') + '. Muat ulang halaman untuk melihat daftar.', true);
  } catch (err) { koinSay(err.message); }
});
document.getElementById('koin-codes-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(document.getElementById('koin-codes-pre').textContent); koinSay('Kode disalin.', true); } catch (err) { koinSay('Gagal menyalin — salin manual dari kotak di atas.'); }
});
document.getElementById('koin-ban-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const j = await koinFetch('/api/admin/cerpen-koin/bans', 'POST', { user_id: String(f.get('user_id') || '').trim(), reason: String(f.get('reason') || '').trim(), expires_at: koinDtLocal(f.get('expires_at')) });
    koinSay('Akun ' + j.username + ' dibanned' + (j.expires_at ? ' sampai ' + new Date(j.expires_at * 1000).toLocaleString('id-ID') : ' (permanen)') + '. Muat ulang halaman untuk melihat daftar.', true);
  } catch (err) { koinSay(err.message); }
});
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-koin-user],[data-koin-unban],[data-koin-device],[data-koin-watch],[data-koin-pricing-del],[data-koin-vip-revoke]');
  if (!t) return;
  try {
    if (t.hasAttribute('data-koin-vip-revoke')) {
      await koinFetch('/api/admin/cerpen-koin/vip/' + encodeURIComponent(t.getAttribute('data-koin-vip-revoke')) + '/revoke', 'POST', {});
      koinSay('VIP dicabut. Muat ulang halaman untuk melihat daftar.', true);
    }
    if (t.hasAttribute('data-koin-user')) {
      const j = await koinFetch('/api/admin/cerpen-koin/users/' + encodeURIComponent(t.getAttribute('data-koin-user')), 'GET');
      const u = j.user;
      document.getElementById('koin-user-detail-body').innerHTML = '<p><b>' + u.username + '</b> · ' + (u.email || '') + ' · saldo <b>' + j.balance + ' koin</b>' + (j.vip && j.vip.active ? ' · <b>VIP sampai ' + new Date(j.vip.expires_at).toLocaleDateString('id-ID') + '</b>' : '') + ' · perangkat: ' + j.devices.length + ' · unlock: ' + j.unlocks.length + (u.reading_private ? ' · papan peringkat: disembunyikan' : '') + '</p>'
        + '<form id="koin-adjust-form"><label>Ubah saldo (delta, bisa negatif)<input name="delta" type="number" required placeholder="mis. 100 atau -50"></label><label>Alasan (wajib)<input name="reason" required maxlength="200"></label><p><button type="submit">Simpan</button> <button type="button" id="koin-lock-btn">' + (u.locked ? 'Buka Kunci Akun' : 'Kunci Akun') + '</button> <button type="button" id="koin-ban2-btn">Ban Akun Ini</button></p></form>'
        + '<h4>Yang sudah dibeli</h4>' + (j.unlocks.map(x => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + x.kind + ':' + x.target_id + ' S' + x.season + 'E' + x.no + '</span></div></div>').join('') || '<p>Belum ada unlock.</p>')
        + '<h4>Terakhir dibaca</h4>' + (j.reading.map(x => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + x.kind + ':' + x.target_id + ' S' + x.season + 'E' + x.no + '</span><div class="adm-row-meta">' + Math.floor(x.seconds / 60) + ' menit · terakhir ' + x.last_day + '</div></div></div>').join('') || '<p>Belum ada riwayat baca.</p>')
        + '<h4>Ledger</h4>' + (j.ledger.map(l => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + (l.delta > 0 ? '+' : '') + l.delta + ' → ' + l.balance_after + '</span><div class="adm-row-meta">' + l.reason + '</div></div></div>').join('') || '<p>Belum ada mutasi.</p>');
      document.getElementById('koin-user-detail').hidden = false;
      document.getElementById('koin-adjust-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        try { const r = await koinFetch('/api/admin/cerpen-koin/users/' + encodeURIComponent(u.id) + '/adjust', 'POST', { delta: koinNum(f.get('delta'), 0), reason: String(f.get('reason') || '') }); koinSay('Saldo ' + u.username + ' jadi ' + r.balance + ' koin.', true); } catch (err) { koinSay(err.message); }
      });
      document.getElementById('koin-lock-btn').addEventListener('click', async () => {
        try { const r = await koinFetch('/api/admin/cerpen-koin/users/' + encodeURIComponent(u.id) + '/' + (u.locked ? 'unlock' : 'lock'), 'POST', {}); koinSay('Akun ' + u.username + (r.locked ? ' dikunci.' : ' dibuka.'), true); } catch (err) { koinSay(err.message); }
      });
      document.getElementById('koin-ban2-btn').addEventListener('click', async () => {
        const reason = prompt('Alasan ban untuk ' + u.username + ' (wajib):');
        if (!reason) return;
        try { await koinFetch('/api/admin/cerpen-koin/bans', 'POST', { user_id: u.id, reason: reason, expires_at: null }); koinSay('Akun ' + u.username + ' dibanned (permanen).', true); } catch (err) { koinSay(err.message); }
      });
    }
    if (t.hasAttribute('data-koin-unban')) {
      const note = prompt('Catatan unban (opsional):') || '';
      await koinFetch('/api/admin/cerpen-koin/bans/' + encodeURIComponent(t.getAttribute('data-koin-unban')) + '/unban', 'POST', { note });
      koinSay('Ban dicabut. Muat ulang halaman untuk melihat daftar.', true);
    }
    if (t.hasAttribute('data-koin-device')) {
      const j = await koinFetch('/api/admin/cerpen-koin/devices/' + encodeURIComponent(t.getAttribute('data-koin-device')), 'GET');
      const d = j.device;
      document.getElementById('koin-device-detail-body').innerHTML = '<p><code>' + d.device_id + '</code></p><p>Akun terikat: ' + (j.links.map(l => l.username || l.user_id).join(', ') || 'guest') + ' · redeem: ' + j.redemptions.length + ' · unlock: ' + j.unlocks.length + ' · kejadian gagal: ' + j.events.length + '</p>'
        + '<h4>Kejadian</h4>' + (j.events.map(ev => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + ev.kind + '</span><div class="adm-row-meta">' + ev.detail + '</div></div></div>').join('') || '<p>Tidak ada kejadian.</p>');
      document.getElementById('koin-device-detail').hidden = false;
    }
    if (t.hasAttribute('data-koin-watch')) {
      const watched = t.getAttribute('data-watched') === '1' ? 1 : 0;
      await koinFetch('/api/admin/cerpen-koin/devices/' + encodeURIComponent(t.getAttribute('data-koin-watch')) + '/watch', 'POST', { watched, note: '' });
      koinSay(watched ? 'Perangkat ditandai dipantau.' : 'Tanda pantau dihapus.', true);
    }
    if (t.hasAttribute('data-koin-pricing-del')) {
      const [kind, target] = t.getAttribute('data-koin-pricing-del').split(':');
      await koinFetch('/api/admin/cerpen-koin/pricing/' + encodeURIComponent(kind) + '/' + encodeURIComponent(target), 'POST', { delete: true });
      koinSay('Override ' + kind + ':' + target + ' dihapus.', true);
    }
  } catch (err) { koinSay(err.message); }
});
(async () => {
  try {
    const j = await koinFetch('/api/admin/cerpen-koin/vouchers', 'GET');
    document.getElementById('koin-batches').innerHTML = '<h4>Batch voucher</h4>' + j.batches.map(b => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + b.batch_id + ' · ' + b.reward_label + '</span><div class="adm-row-meta">' + b.codes.redeemed + '/' + b.codes.total + ' kode ditukar · maks total ' + b.total_max + ' · maks per akun/perangkat ' + b.per_device_max + (b.valid_from ? ' · mulai ' + new Date(b.valid_from * 1000).toLocaleString('id-ID') : '') + (b.expires_at ? ' · sampai ' + new Date(b.expires_at * 1000).toLocaleString('id-ID') : ' · tanpa kedaluwarsa') + ' · ' + (b.active ? 'aktif' : 'DRAF') + '</div></div>' + (b.active ? '<button type="button" data-koin-batch-deact="' + b.batch_id + '">Nonaktifkan</button>' : '<button type="button" data-koin-batch-act="' + b.batch_id + '">Aktifkan</button>') + '</div>').join('');
    document.querySelectorAll('[data-koin-batch-deact]').forEach(btn => btn.addEventListener('click', async () => {
      try { await koinFetch('/api/admin/cerpen-koin/vouchers/' + encodeURIComponent(btn.getAttribute('data-koin-batch-deact')) + '/deactivate', 'POST', {}); koinSay('Batch dinonaktifkan.', true); } catch (err) { koinSay(err.message); }
    }));
    document.querySelectorAll('[data-koin-batch-act]').forEach(btn => btn.addEventListener('click', async () => {
      try { await koinFetch('/api/admin/cerpen-koin/vouchers/' + encodeURIComponent(btn.getAttribute('data-koin-batch-act')) + '/activate', 'POST', {}); koinSay('Batch diaktifkan.', true); } catch (err) { koinSay(err.message); }
    }));
  } catch (err) { /* daftar batch gagal dimuat — panel tetap jalan */ }
})();
</script>`;
}
