// Paket Admin/Keamanan Cerpen Hozin — ID + tracking + redeem + ban
// real-time + deteksi + anti-bypass API key + pencocokan pola perilaku
// + deteksi emulator/root/integritas (18 Nov 2026).
//
// Modul mandiri: endpoint aplikasi (/api/cerpen-track/*), endpoint admin
// (/api/admin/cerpen-track/*), dan panel /kendali/cerpen-pantau. Semua
// tabel baru tinggal di D1 cms-db (env.DB) — satu DB dengan tabel koin,
// supaya ban/unban + cabut kunci + pantauan bisa konsisten dengan
// fondasi yang sudah ada (cerpen_bans, cerpen_vip, cerpen_vouchers,
// cerpen_device_watch, cerpen_coin_events).
//
// Prinsip yang disambung dari coins.js:
//  - server satu-satunya otoritas ban/unlock; aplikasi tidak pernah
//    dipercaya memutuskan sendiri;
//  - ban HANYA untuk akun di v1 koin — modul ini MEMPERLUAS ke perangkat
//    + fingerprint, tapi tetap lewat tabel cerpen_bans yang sama;
//  - pantauan BUKAN hukuman (tidak memblokir);
//  - root SENDIRIAN dan integritas gagal SENDIRIAN tidak pernah
//    menaikkan skor deteksi dan tidak pernah memicu auto-ban (aturan
//    keras — HP user sendiri root).
//
// Batas jujur (jangan dihapus dari laporan/kontrak):
//  - tidak ada yang 100% anti-bypass: ganti perangkat + reset pabrik
//    bisa menghasilkan fingerprint baru. Yang membuat bypass sulit
//    adalah penegakan server-side di TIAP request (kunci dicabut,
//    fingerprint dikenali, pola perilaku dicocokkan) — bukan apa pun
//    yang disimpan di aplikasi.
//  - expires_at di cerpen_bans disimpan sebagai unix DETIK (sama seperti
//    endpoint ban koin yang sudah ada). Bandingkan SELALU dengan detik,
//    bukan Date.now() (ms) — bug D4 yang sudah dikenal (ban berjangka
//    tak bekerja bila dibandingkan dengan ms) TIDAK diulang di sini.
import { esc, clientIp, randomHex, sha256Hex, b64url, safeEqualHex, escapeLikeTerm } from './util.js';
import { isAdmin, csrfToken, getCommenter } from './auth.js';
import { checkRateLimit } from './security.js';
import { getSetting } from './store.js';

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
const isOwnerKey = v => /^(user:u-[0-9a-z]+|device:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(String(v || ''));
const isTargetId = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
const isAndroidId = v => typeof v === 'string' && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
const isHash64 = v => /^[0-9a-f]{64}$/.test(String(v || ''));
const isApiKey = v => /^ck-[0-9a-f]{32}$/.test(String(v || ''));
const clampInt = (v, dflt, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };

function wibText(ms) {
  return new Date(Number(ms || 0) + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' WIB';
}
function wibHour(ms) {
  return new Date(Number(ms || 0) + 7 * 3600 * 1000).getUTCHours();
}
function nowSec() { return Math.floor(Date.now() / 1000); }

// ---- Ambang deteksi (cms_settings, bisa diubah admin) ----
const DETECT_DEFAULTS = {
  cerpen_detect_enabled: '1',
  cerpen_detect_watch_score: '40',
  cerpen_detect_auto_ban_score: '100',
  cerpen_detect_behavior_match: '50',
  cerpen_detect_behavior_ban: '80',
};
async function getDetectSettings(env) {
  const out = {};
  for (const [k, dflt] of Object.entries(DETECT_DEFAULTS)) {
    const v = await getSetting(env, k, dflt);
    out[k] = k === 'cerpen_detect_enabled' ? (String(v) !== '0' ? 1 : 0) : clampInt(v, parseInt(dflt, 10), 0, 100);
  }
  return {
    enabled: out.cerpen_detect_enabled,
    watchScore: out.cerpen_detect_watch_score,
    autoBanScore: out.cerpen_detect_auto_ban_score,
    behaviorMatch: out.cerpen_detect_behavior_match,
    behaviorBan: out.cerpen_detect_behavior_ban,
  };
}

// ---- God-mode admin Cerpen (21 Nov 2026, TANPA panel) ----
// Satu baris per akun di cerpen_admins (DDL + seed u-mwf1z8n0 hozinking
// di store.js/schema.sql). Hak admin HANYA berlaku bila fingerprint
// request cocok dengan fingerprint yang terikat; fingerprint pertama
// yang register untuk akun admin menjadi yang terikat (bound_at).
// Rebind HANYA manual di D1 — tidak ada UI rebind. Token/flag admin
// berlaku 30 hari sejak register/heartbeat terakhir (admin_expires_at,
// unix DETIK); aplikasi me-cache-nya dan mengecek lokal saat offline —
// expiry TIDAK pernah diperpanjang lokal.
export const CERPEN_ADMIN_TOKEN_TTL_SEC = 30 * 24 * 3600;

async function getCerpenAdminRow(env, userId) {
  if (!userId) return null;
  try {
    return await env.DB.prepare(`SELECT user_id, fingerprint_hash, bound_at, note FROM cerpen_admins WHERE user_id = ?`).bind(userId).first();
  } catch (e) { return null; }
}

// true bila akun ini admin. Tanpa fingerprint (jalur koin/ban yang
// tidak membawa fingerprint) -> cukup ada baris admin-nya.
export async function isCerpenAdminUser(env, userId) {
  return !!(await getCerpenAdminRow(env, userId));
}

// true bila akun ini admin DAN fingerprint-nya cocok dengan yang terikat.
// Akun admin yang BELUM terikat TIDAK lolos (fail-closed — pengikatan
// terjadi di resolveCerpenAdmin saat register). Dipakai untuk LEWATI
// ban/deteksi di jalur track.
export async function isCerpenAdmin(env, userId, fingerprintHash) {
  const row = await getCerpenAdminRow(env, userId);
  if (!row) return false;
  const bound = String(row.fingerprint_hash || '');
  if (!bound) return false;
  return safeEqualHex(bound, String(fingerprintHash || ''));
}

// Ikat fingerprint pertama + kembalikan status admin untuk respons.
// Dipanggil saat register/heartbeat/status (sudah ada user).
export async function resolveCerpenAdmin(env, userId, fingerprintHash) {
  const row = await getCerpenAdminRow(env, userId);
  if (!row) return { admin: false, admin_expires_at: 0 };
  const fp = String(fingerprintHash || '');
  const bound = String(row.fingerprint_hash || '');
  if (!bound && fp) {
    try {
      await env.DB.prepare(`UPDATE cerpen_admins SET fingerprint_hash = ?, bound_at = ? WHERE user_id = ?`).bind(fp, Date.now(), userId).run();
    } catch (e) { return { admin: false, admin_expires_at: 0 }; }
  } else if (bound && bound !== fp) {
    return { admin: false, admin_expires_at: 0 };
  }
  return { admin: true, admin_expires_at: nowSec() + CERPEN_ADMIN_TOKEN_TTL_SEC };
}

// Admin untuk pembelian koin: akun admin + perangkat pembelian sama
// dengan perangkat terikat di baris track (kunci 1 HP).
export async function isCerpenAdminDevice(env, userId, deviceId) {
  if (!userId || !deviceId) return false;
  const row = await getCerpenAdminRow(env, userId);
  if (!row || !String(row.fingerprint_hash || '')) return false;
  let track = null;
  try {
    track = await env.DB.prepare(`SELECT device_id, fingerprint_hash FROM cerpen_track_users WHERE owner_key = ?`).bind('user:' + userId).first();
  } catch (e) { return false; }
  if (!track) return false;
  return String(track.device_id || '') === String(deviceId) && String(track.fingerprint_hash || '') === String(row.fingerprint_hash);
}

// Medan admin untuk respons register/heartbeat/status.
function adminFields(st) {
  return { admin: !!st.admin, admin_expires_at: st.admin ? st.admin_expires_at : 0 };
}

// ---- Ban (tabel cerpen_bans yang sudah ada; expires_at = unix DETIK) ----
// Sapu ban kedaluwarsa (banding DETIK — bukan ms; lihat catatan D4 di atas).
async function sweepExpiredBans(env) {
  try {
    await env.DB.prepare(`UPDATE cerpen_bans SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?`).bind(nowSec()).run();
  } catch (e) { /* sapu gagal -> cek di bawah tetap memakai expires_at */ }
}
// Cek ban untuk akun / perangkat / fingerprint. Kembalikan null bila bersih,
// atau {target, target_id, reason, expires_at} (expires_at detik / null).
export async function cerpenTrackBanCheck(env, { userId = '', deviceId = '', fingerprintHash = '' } = {}) {
  await sweepExpiredBans(env);
  const nowS = nowSec();
  const checks = [];
  if (userId) checks.push(env.DB.prepare(`SELECT id, reason, expires_at FROM cerpen_bans WHERE target_type = 'user' AND target_id = ? AND active = 1`).bind(userId).first().then(r => r ? { target: 'user', target_id: userId, reason: String(r.reason || ''), expires_at: r.expires_at ? Number(r.expires_at) : null } : null));
  if (deviceId) checks.push(env.DB.prepare(`SELECT id, reason, expires_at FROM cerpen_bans WHERE target_type = 'device' AND target_id = ? AND active = 1`).bind(deviceId).first().then(r => r ? { target: 'device', target_id: deviceId, reason: String(r.reason || ''), expires_at: r.expires_at ? Number(r.expires_at) : null } : null));
  if (fingerprintHash) checks.push(env.DB.prepare(`SELECT id, reason, expires_at FROM cerpen_bans WHERE target_type = 'fingerprint' AND target_id = ? AND active = 1`).bind(fingerprintHash).first().then(r => r ? { target: 'fingerprint', target_id: fingerprintHash, reason: String(r.reason || ''), expires_at: r.expires_at ? Number(r.expires_at) : null } : null));
  const found = (await Promise.all(checks)).filter(Boolean);
  if (!found.length) return null;
  // Ban berjangka yang sudah lewat tapi sapu gagal: anggap tidak aktif.
  const live = found.filter(b => !b.expires_at || b.expires_at > nowS);
  return live.length ? live[0] : null;
}
function bannedResponse(ban) {
  return aj({ ok: false, error: 'banned', target: ban.target, reason: ban.reason, expires_at: ban.expires_at }, 403);
}

// ---- API key per instalasi (hanya HASH yang disimpan) ----
// Format plaintext: 'ck-' + 32 hex. Plaintext HANYA dikembalikan sekali
// saat register/rotate — tidak pernah ditulis ke D1/log/panel.
function randomApiKey() { return 'ck-' + randomHex(16); }
async function issueApiKey(env, { ownerKey, deviceId, fingerprintHash }) {
  const plain = randomApiKey();
  const hash = await sha256Hex(plain);
  const keyId = 'ckey-' + randomHex(4);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO cerpen_track_api_keys (key_id, key_hash, owner_key, device_id, fingerprint_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`).bind(keyId, hash, ownerKey, deviceId || '', fingerprintHash || '', now).run();
  return { key_id: keyId, api_key: plain, key_hash: hash };
}
async function lookupApiKey(env, plain) {
  if (!isApiKey(plain)) return null;
  const hash = await sha256Hex(plain);
  const row = await env.DB.prepare(`SELECT key_id, key_hash, owner_key, device_id, fingerprint_hash, status, created_at, revoked_at, revoke_reason, last_used_at FROM cerpen_track_api_keys WHERE key_hash = ?`).bind(hash).first();
  return row || null;
}
async function revokeKeysForOwner(env, ownerKey, reason) {
  const now = Date.now();
  await env.DB.prepare(`UPDATE cerpen_track_api_keys SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE owner_key = ? AND status = 'active'`).bind(now, reason, ownerKey).run();
}
async function revokeKeysForFingerprint(env, fingerprintHash, reason) {
  if (!fingerprintHash) return;
  const now = Date.now();
  await env.DB.prepare(`UPDATE cerpen_track_api_keys SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE fingerprint_hash = ? AND status = 'active'`).bind(now, reason, fingerprintHash).run();
}
async function touchApiKey(env, keyHash) {
  try {
    await env.DB.prepare(`UPDATE cerpen_track_api_keys SET last_used_at = ? WHERE key_hash = ?`).bind(Date.now(), keyHash).run();
  } catch (e) { /* jejak pakai tidak boleh menggagalkan request */ }
}
// Penegakan kunci di rute Cerpen yang SUDAH ADA (koin/auth/sosial/
// bookmark): HANYA bila request membawa header x-cerpen-api-key.
// Tanpa header -> perilaku lama (klien lama tanpa kunci tetap jalan).
// Header ada + kunci dicabut / pemilik dibanned -> 403. Dipakai worker.js.
export async function enforceCerpenApiKeyIfPresent(request, env) {
  const plain = String(request.headers.get('x-cerpen-api-key') || '').trim();
  if (!plain) return null;
  const key = await lookupApiKey(env, plain);
  if (!key) return aj({ ok: false, error: 'api_key_tidak_valid' }, 401);
  if (key.status !== 'active') return aj({ ok: false, error: 'banned', target: 'api_key', reason: 'Kunci API dicabut.', expires_at: null }, 403);
  // God-mode admin: lewati cek ban (kunci admin tidak pernah dicabut
  // oleh deteksi — applyCerpenBan menolak ban admin).
  const ownerUserId = String(key.owner_key || '').startsWith('user:') ? String(key.owner_key).slice(5) : '';
  const adminHere = ownerUserId ? await isCerpenAdmin(env, ownerUserId, key.fingerprint_hash || '') : false;
  if (!adminHere) {
    const ban = await cerpenTrackBanCheck(env, { userId: ownerUserId, deviceId: key.device_id || '', fingerprintHash: key.fingerprint_hash || '' });
    if (ban) return bannedResponse(ban);
  }
  await touchApiKey(env, key.key_hash);
  return null;
}

// ---- Jejak deteksi + watchlist ----
async function logDetection(env, kind, { ownerKey = '', deviceId = '', userId = null, detail = '', score = 0 }) {
  try {
    await env.DB.prepare(`INSERT INTO cerpen_detection_events (id, kind, owner_key, device_id, user_id, detail, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind('de-' + randomHex(8), kind, ownerKey, deviceId, userId, String(detail || '').slice(0, 500), score, Date.now()).run();
  } catch (e) { /* jejak tidak boleh menggagalkan alur utama */ }
}
async function upsertWatchlist(env, { subjectType, subjectId, ownerKey, reason, evidence, score }) {
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT id, subject_type, subject_id, owner_key, reason, evidence, score, status, created_at, updated_at FROM cerpen_watchlist WHERE subject_type = ? AND subject_id = ? AND status = 'watching'`).bind(subjectType, subjectId).first();
  if (existing) {
    const newScore = Math.max(Number(existing.score) || 0, score);
    const mergedEvidence = String(existing.evidence || '') + (existing.evidence ? ' | ' : '') + evidence;
    await env.DB.prepare(`UPDATE cerpen_watchlist SET score = ?, evidence = ?, updated_at = ? WHERE id = ?`).bind(newScore, mergedEvidence.slice(0, 2000), now, existing.id).run();
    return { id: existing.id, score: newScore, updated: true };
  }
  const id = 'wl-' + randomHex(6);
  await env.DB.prepare(`INSERT INTO cerpen_watchlist (id, subject_type, subject_id, owner_key, reason, evidence, score, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?)`).bind(id, subjectType, subjectId, ownerKey, reason, evidence.slice(0, 2000), score, now, now).run();
  return { id, score, updated: false };
}

// Terapkan ban (dipakai admin + auto-ban deteksi): baris ban + cabut kunci
// pemilik + (bila target perangkat dan fingerprint-nya bukan emulator)
// ban fingerprint-nya juga, supaya install ulang dari perangkat yang sama
// tetap ditolak. Fingerprint emulator TIDAK ikut dibanned (generik —
// banyak perangkat sah berbagi sidik yang sama).
export async function applyCerpenBan(env, { targetType, targetId, reason, expiresAtSec = null, by = 'admin', fingerprintHash = '', isEmulator = false }) {
  const id = 'ban-' + randomHex(6);
  const now = Date.now();
  const lit = targetType === 'device' ? 'device' : targetType === 'fingerprint' ? 'fingerprint' : 'user';
  // God-mode admin: akun admin / fingerprint terikatnya / perangkat
  // miliknya TIDAK BISA dibanned — dari jalur mana pun (manual, deteksi,
  // pola perilaku). Menolak di sini supaya auto-ban pun gagal aman.
  if (lit === 'user' && await isCerpenAdminUser(env, targetId)) {
    return { ok: false, error: 'Target ini admin Cerpen (god-mode) — tidak bisa dibanned.' };
  }
  if (lit === 'fingerprint') {
    const adm = await env.DB.prepare(`SELECT user_id FROM cerpen_admins WHERE fingerprint_hash = ?`).bind(targetId).first().catch(() => null);
    if (adm) return { ok: false, error: 'Fingerprint ini terikat ke admin Cerpen (god-mode) — tidak bisa dibanned.' };
  }
  if (lit === 'device') {
    const t = await env.DB.prepare(`SELECT user_id FROM cerpen_track_users WHERE device_id = ?`).bind(targetId).first().catch(() => null);
    if (t && t.user_id && await isCerpenAdminUser(env, t.user_id)) {
      return { ok: false, error: 'Perangkat ini milik admin Cerpen (god-mode) — tidak bisa dibanned.' };
    }
  }
  try {
    await env.DB.prepare(`INSERT INTO cerpen_bans (id, target_type, target_id, reason, banned_by, created_at, expires_at, active) VALUES (?, '${lit}', ?, ?, ?, ?, ?, 1)`).bind(id, targetId, reason, by, now, expiresAtSec).run();
  } catch (e) {
    return { ok: false, error: 'Target ini sudah dibanned (cabut dulu bila mau ban lagi).' };
  }
  // Cabut kunci: pemilik langsung + semua kunci dengan fingerprint sama.
  if (lit === 'user') await revokeKeysForOwner(env, 'user:' + targetId, 'ban:' + id);
  if (lit === 'device') {
    await revokeKeysForOwner(env, 'device:' + targetId, 'ban:' + id);
    if (fingerprintHash && !isEmulator) {
      await revokeKeysForFingerprint(env, fingerprintHash, 'ban:' + id);
      try {
        await env.DB.prepare(`INSERT INTO cerpen_bans (id, target_type, target_id, reason, banned_by, created_at, expires_at, active) VALUES (?, 'fingerprint', ?, ?, ?, ?, ?, 1)`).bind('ban-' + randomHex(6), fingerprintHash, 'fingerprint dari ' + lit + ' yang dibanned: ' + reason, by, now, expiresAtSec).run();
      } catch (e) { /* fingerprint sudah dibanned -> bukan error */ }
    }
  }
  if (lit === 'fingerprint') await revokeKeysForFingerprint(env, targetId, 'ban:' + id);
  await logDetection(env, 'ban_create', { ownerKey: lit === 'user' ? 'user:' + targetId : lit === 'device' ? 'device:' + targetId : '', deviceId: lit === 'device' ? targetId : '', userId: lit === 'user' ? targetId : null, detail: 'ban ' + lit + ':' + String(targetId).slice(0, 16) + ' — ' + reason + (expiresAtSec ? ' sampai ' + wibText(expiresAtSec * 1000) : ' (permanen)'), score: 0 });
  return { ok: true, id };
}

// ---- Play Integrity (verifikasi token di SISI SERVER) ----
// Secret Worker PLAY_INTEGRITY_SERVICE_ACCOUNT = JSON service account
// Google Cloud {client_email, private_key} dengan peran Service Account
// Token Creator + akses Play Integrity API. Tanpa secret -> status
// 'belum terverifikasi' (BUKAN 'gagal') — sinyal tidak boleh disajikan
// seolah terverifikasi. Nilai secret TIDAK PERNAH ditulis ke log/D1.
const CERPEN_APP_PACKAGE = 'com.hozinking.cerpen';
let playIntegrityTokenCache = { token: '', exp: 0 };
function pemToDer(pem) {
  const b64 = String(pem || '').replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function getPlayIntegrityAccessToken(env) {
  const nowS = nowSec();
  if (playIntegrityTokenCache.token && playIntegrityTokenCache.exp > nowS + 60) return playIntegrityTokenCache.token;
  let sa;
  try { sa = JSON.parse(String(env.PLAY_INTEGRITY_SERVICE_ACCOUNT || '')); } catch (e) { return null; }
  if (!sa || !sa.client_email || !sa.private_key) return null;
  const iat = nowS;
  const exp = nowS + 3600;
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/playintegrity', aud: 'https://oauth2.googleapis.com/token', exp, iat })));
  const unsigned = header + '.' + payload;
  let key;
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (e) { return null; }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64url(new Uint8Array(sig));
  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt) });
  } catch (e) { return null; }
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch (e) { return null; }
  if (!j || !j.access_token) return null;
  playIntegrityTokenCache = { token: j.access_token, exp: nowS + Math.min(3600, Number(j.expires_in) || 3600) };
  return playIntegrityTokenCache.token;
}
// Verifikasi token Play Integrity dari aplikasi. Kembalikan
// {status: 'passed'|'failed'|'unknown', reason, device_verdicts, app_verdict}.
// 'unknown' = belum bisa diverifikasi (secret belum diset / jaringan gagal).
export async function verifyPlayIntegrityToken(env, token) {
  if (!token || typeof token !== 'string' || token.length < 10) return { status: 'unknown', reason: 'token tidak ada' };
  const access = await getPlayIntegrityAccessToken(env);
  if (!access) return { status: 'unknown', reason: 'not_configured' };
  let res;
  try {
    res = await fetch('https://playintegrity.googleapis.com/v1/' + CERPEN_APP_PACKAGE + ':decodeIntegrityToken', { method: 'POST', headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' }, body: JSON.stringify({ integrityToken: token }) });
  } catch (e) { return { status: 'unknown', reason: 'network' }; }
  if (!res.ok) return { status: 'unknown', reason: 'google_' + res.status };
  let j;
  try { j = await res.json(); } catch (e) { return { status: 'unknown', reason: 'bad_json' }; }
  const deviceVerdicts = Array.isArray(j && j.deviceIntegrity && j.deviceIntegrity.deviceRecognitionVerdict) ? j.deviceIntegrity.deviceRecognitionVerdict : [];
  const appVerdict = String((j && j.appIntegrity && j.appIntegrity.appRecognitionVerdict) || '');
  if (deviceVerdicts.includes('MEETS_STRONG_INTEGRITY') || deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY')) {
    return { status: 'passed', reason: '', device_verdicts: deviceVerdicts, app_verdict: appVerdict };
  }
  if (deviceVerdicts.includes('MEETS_BASIC_INTEGRITY')) {
    return { status: 'failed', reason: 'basic_only', device_verdicts: deviceVerdicts, app_verdict: appVerdict };
  }
  return { status: 'failed', reason: 'no_device_integrity', device_verdicts: deviceVerdicts, app_verdict: appVerdict };
}

// ---- Profil perilaku (untuk pencocokan pola) ----
// Fitur: 5 series teratas (kind:target -> jumlah sesi), histogram jam WIB
// (24 bucket), rata-rata durasi sesi, total sesi. Disimpan sebagai JSON.
function emptyProfile() { return { series: {}, hours: new Array(24).fill(0), avgSessionSeconds: 0, totalSessions: 0 }; }
function parseProfile(row) {
  if (!row) return emptyProfile();
  let series = {};
  let hours = new Array(24).fill(0);
  try { series = JSON.parse(row.series_json || '{}') || {}; } catch (e) { series = {}; }
  try { const h = JSON.parse(row.hours_json || '[]'); if (Array.isArray(h) && h.length === 24) hours = h.map(n => Number(n) || 0); } catch (e) { /* pakai default */ }
  return { series, hours, avgSessionSeconds: Number(row.avg_session_seconds) || 0, totalSessions: Number(row.total_sessions) || 0 };
}
function topSeriesList(series) {
  return Object.entries(series).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
}
// Skor kemiripan 0–100 antara dua profil. Butuh data minimal (≥3 sesi
// DAN ≥2 series berbeda di kedua profil) — tanpa itu skor 0, supaya satu
// kebetulan (mis. sama-sama baca cerpen-01 jam 7 malam) tidak menuduh.
export function behaviorSimilarity(a, b) {
  const aTop = topSeriesList(a.series);
  const bTop = topSeriesList(b.series);
  if (a.totalSessions < 3 || b.totalSessions < 3) return { score: 0, reasons: ['data terlalu sedikit'] };
  if (aTop.length < 2 || bTop.length < 2) return { score: 0, reasons: ['series terlalu sedikit'] };
  const aSet = new Set(aTop);
  const bSet = new Set(bTop);
  let inter = 0;
  for (const k of aSet) if (bSet.has(k)) inter++;
  const union = new Set([...aSet, ...bSet]).size || 1;
  const jaccard = inter / union;
  const aHoursTotal = a.hours.reduce((t, n) => t + n, 0) || 1;
  const bHoursTotal = b.hours.reduce((t, n) => t + n, 0) || 1;
  let hourOverlap = 0;
  for (let i = 0; i < 24; i++) hourOverlap += Math.min(a.hours[i] / aHoursTotal, b.hours[i] / bHoursTotal);
  const lenA = Math.max(1, a.avgSessionSeconds);
  const lenB = Math.max(1, b.avgSessionSeconds);
  const lenClose = 1 - Math.min(Math.abs(lenA - lenB) / Math.max(lenA, lenB), 1);
  const score = Math.round(jaccard * 50 + hourOverlap * 30 + lenClose * 20);
  const reasons = [];
  if (inter) reasons.push(inter + ' series sama (' + [...aSet].filter(k => bSet.has(k)).slice(0, 3).join(', ') + ')');
  if (hourOverlap > 0.5) reasons.push('jam baca mirip (' + Math.round(hourOverlap * 100) + '%)');
  if (lenClose > 0.7) reasons.push('durasi sesi mirip');
  return { score, reasons };
}
async function loadProfile(env, ownerKey) {
  const row = await env.DB.prepare(`SELECT owner_key, fingerprint_hash, series_json, hours_json, avg_session_seconds, total_sessions, redeem_attempts, redeem_failed, updated_at FROM cerpen_behavior_profiles WHERE owner_key = ?`).bind(ownerKey).first();
  return { row, profile: parseProfile(row) };
}
async function saveProfile(env, ownerKey, fingerprintHash, profile) {
  const seriesJson = JSON.stringify(profile.series);
  const hoursJson = JSON.stringify(profile.hours);
  await env.DB.prepare(`INSERT OR REPLACE INTO cerpen_behavior_profiles (owner_key, fingerprint_hash, series_json, hours_json, avg_session_seconds, total_sessions, redeem_attempts, redeem_failed, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`).bind(ownerKey, fingerprintHash || '', seriesJson, hoursJson, Math.round(profile.avgSessionSeconds), profile.totalSessions, Date.now()).run();
}

// ---- Perintah tertunda (kick / crash) ----
async function pendingCommandsFor(env, ownerKeys) {
  if (!ownerKeys.length) return [];
  const placeholders = ownerKeys.map(() => '?').join(', ');
  const rows = await env.DB.prepare(`SELECT id, owner_key, kind, payload, created_at FROM cerpen_commands WHERE owner_key IN (${placeholders}) AND status = 'pending' ORDER BY created_at ASC`).bind(...ownerKeys).all();
  return rows.results || [];
}
async function markCommandsDelivered(env, ids) {
  if (!ids.length) return;
  const now = Date.now();
  await env.DB.batch(ids.map(id => env.DB.prepare(`UPDATE cerpen_commands SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'`).bind(now, id)));
}
async function markCommandsExecuted(env, ids) {
  if (!ids.length) return 0;
  const now = Date.now();
  let n = 0;
  for (const id of ids) {
    const r = await env.DB.prepare(`UPDATE cerpen_commands SET status = 'executed', executed_at = ? WHERE id = ? AND status IN ('pending', 'delivered')`).bind(now, id).run();
    if (r && r.meta && Number(r.meta.changes) === 1) n++;
  }
  return n;
}

// ---- Sesi baca (presence + riwayat per pengguna) ----
// Sesi "terbuka" = ended_at IS NULL. updated_at = aktivitas terakhir;
// seconds diakumulasi per heartbeat tanpa menutup sesi.
async function openSession(env, ownerKey) {
  return await env.DB.prepare(`SELECT id, owner_key, user_id, device_id, kind, target_id, season, no, started_at, ended_at, seconds, app_version FROM cerpen_read_sessions WHERE owner_key = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).bind(ownerKey).first();
}
async function addSessionSeconds(env, sessionId, seconds) {
  if (!sessionId || !(seconds > 0)) return;
  await env.DB.prepare(`UPDATE cerpen_read_sessions SET seconds = seconds + ?, updated_at = ? WHERE id = ?`).bind(seconds, Date.now(), sessionId).run();
}
async function closeSession(env, sessionId) {
  if (!sessionId) return;
  const now = Date.now();
  await env.DB.prepare(`UPDATE cerpen_read_sessions SET ended_at = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL`).bind(now, now, sessionId).run();
}

// ---- Evaluasi deteksi (dijalankan di heartbeat, maks 1x/60 detik per pemilik) ----
// Skor per sinyal (ambang di cms_settings):
//  - redeem_failed >= 5 dalam 1 jam -> +40
//  - >= 8 episode berbeda dibuka dalam 10 menit -> +40
//  - >= 3 perangkat bersamaan membaca (akun login) -> +30
//  - signer_mismatch >= 3 dalam 1 jam (jejak gerbang versi) -> +40
//  - emulator + ada sinyal abuse lain -> +10
//  - integritas gagal + ada sinyal abuse lain -> +10
//  - root SENDIRIAN -> +0 (aturan keras; root hanya dicatat sebagai flag)
// Skor per jenis dibatasi 1x/jam supaya tidak lari. Skor >= watch ->
// watchlist; skor >= auto-ban -> ban otomatis + cabut kunci.
async function evaluateDetection(env, user, settings) {
  if (!settings.enabled) return { evaluated: false };
  const now = Date.now();
  const ownerKey = user.owner_key;
  const deviceId = user.device_id || '';
  const userId = user.user_id || '';
  const signals = [];
  // 1. Brute force redeem (jejak cerpen_coin_events yang sudah ada).
  const since1h = now - 3600 * 1000;
  let redeemFail = 0;
  try {
    const byDevice = deviceId ? await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_coin_events WHERE kind = 'redeem_failed' AND device_id = ? AND created_at >= ?`).bind(deviceId, since1h).first() : null;
    const byUser = userId ? await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_coin_events WHERE kind = 'redeem_failed' AND user_id = ? AND created_at >= ?`).bind(userId, since1h).first() : null;
    redeemFail = Math.max(Number(byDevice?.c) || 0, Number(byUser?.c) || 0);
  } catch (e) { /* sinyal gagal dibaca -> lewati */ }
  if (redeemFail >= 5) signals.push({ kind: 'redeem_bruteforce', score: 40, detail: redeemFail + ' gagal redeem dalam 1 jam' });
  // 2. Baca super cepat: banyak episode berbeda dalam 10 menit.
  try {
    const rows = await env.DB.prepare(`SELECT target_id FROM cerpen_read_sessions WHERE owner_key = ? AND started_at >= ?`).bind(ownerKey, now - 10 * 60 * 1000).all();
    const distinct = new Set((rows.results || []).map(r => r.target_id)).size;
    if (distinct >= 8) signals.push({ kind: 'reading_too_fast', score: 40, detail: distinct + ' episode berbeda dibuka dalam 10 menit' });
  } catch (e) { /* lewati */ }
  // 3. Banyak sesi bersamaan (hanya akun login — guest = 1 perangkat).
  if (userId) {
    try {
      const rows = await env.DB.prepare(`SELECT device_id FROM cerpen_read_sessions WHERE user_id = ? AND ended_at IS NULL`).bind(userId).all();
      const devs = new Set((rows.results || []).map(r => r.device_id)).size;
      if (devs >= 3) signals.push({ kind: 'multi_session', score: 30, detail: devs + ' perangkat membaca bersamaan' });
    } catch (e) { /* lewati */ }
  }
  // 4. Signer mismatch berulang (jejak gerbang versi di BACKUP_DB).
  if (deviceId && env.BACKUP_DB) {
    try {
      const row = await env.BACKUP_DB.prepare(`SELECT COUNT(*) AS n FROM cerpen_lock_attempts WHERE subject_key = ? AND reason IN ('signer_mismatch', 'signer_missing') AND created_at > ?`).bind('dev:' + deviceId, since1h).first();
      if ((Number(row?.n) || 0) >= 3) signals.push({ kind: 'signer_mismatch', score: 40, detail: (Number(row.n) || 0) + ' percobaan signer tak dikenal dalam 1 jam' });
    } catch (e) { /* BACKUP_DB tidak tersedia -> lewati */ }
  }
  // 5-6. Emulator / integritas gagal HANYA menambah skor bila ada abuse lain.
  const abuseScore = signals.reduce((t, s) => t + s.score, 0);
  if (abuseScore > 0) {
    if (Number(user.is_emulator) === 1) signals.push({ kind: 'emulator_with_abuse', score: 10, detail: 'perangkat emulator + pola abuse' });
    if (user.integrity_status === 'failed') signals.push({ kind: 'integrity_failed_with_abuse', score: 10, detail: 'integritas perangkat gagal + pola abuse' });
  }
  // Integritas gagal SENDIRIAN (tanpa abuse lain): JANGAN tambah skor
  // (aturan keras — HP root user sendiri bisa gagal Play Integrity), tapi
  // catat jejaknya 1x/jam supaya lonjakan bisa diaudit admin.
  if (user.integrity_status === 'failed') {
    try {
      const prior = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_detection_events WHERE kind = ? AND owner_key = ? AND created_at >= ?`).bind('integrity_failed', ownerKey, since1h).first();
      if ((Number(prior?.c) || 0) === 0) await logDetection(env, 'integrity_failed', { ownerKey, deviceId, userId: userId || null, detail: 'verifikasi Play Integrity gagal', score: 0 });
    } catch (e) { /* jejak tidak boleh menggagalkan deteksi */ }
  }
  if (!signals.length) return { evaluated: true, score: 0, signals: [] };
  // Dedup per jenis 1 jam: jenis yang sudah tercatat tidak menambah skor lagi.
  let total = 0;
  const fresh = [];
  for (const s of signals) {
    let prior = null;
    try {
      prior = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_detection_events WHERE kind = ? AND owner_key = ? AND created_at >= ?`).bind(s.kind, ownerKey, since1h).first();
    } catch (e) { prior = null; }
    if ((Number(prior?.c) || 0) === 0) { total += s.score; fresh.push(s); }
  }
  for (const s of fresh) {
    await logDetection(env, s.kind, { ownerKey, deviceId, userId: userId || null, detail: s.detail, score: s.score });
  }
  if (total <= 0) return { evaluated: true, score: 0, signals: fresh };
  if (total >= settings.watchScore) {
    const subjectType = userId ? 'user' : 'device';
    const subjectId = userId || deviceId;
    const wl = await upsertWatchlist(env, {
      subjectType, subjectId, ownerKey,
      reason: 'deteksi otomatis: ' + fresh.map(s => s.kind).join(', '),
      evidence: fresh.map(s => s.kind + ' (+' + s.score + '): ' + s.detail).join(' | '),
      score: total,
    });
    if (total >= settings.autoBanScore) {
      const ban = await applyCerpenBan(env, { targetType: subjectType, targetId: subjectId, reason: 'auto-ban deteksi (skor ' + total + '): ' + fresh.map(s => s.kind).join(', '), by: 'auto-detect', fingerprintHash: user.fingerprint_hash || '', isEmulator: Number(user.is_emulator) === 1 });
      if (ban.ok) {
        await env.DB.prepare(`UPDATE cerpen_watchlist SET status = 'banned', updated_at = ? WHERE id = ?`).bind(Date.now(), wl.id).run();
        await logDetection(env, 'auto_ban', { ownerKey, deviceId, userId: userId || null, detail: 'auto-ban ' + subjectType + ':' + String(subjectId).slice(0, 16) + ' (skor ' + total + ')', score: total });
      }
      return { evaluated: true, score: total, signals: fresh, autoBanned: !!ban.ok };
    }
    return { evaluated: true, score: total, signals: fresh, watchlisted: true };
  }
  return { evaluated: true, score: total, signals: fresh };
}

// ---- Pencocokan pola perilaku vs profil yang dibanned ----
async function evaluateBehaviorMatch(env, user, profile, settings) {
  if (!settings.enabled) return { evaluated: false };
  if (profile.totalSessions < 3) return { evaluated: false, reason: 'profil terlalu tipis' };
  const subjectType = user.user_id ? 'user' : 'device';
  const subjectId = user.user_id || user.device_id || '';
  if (!subjectId) return { evaluated: false };
  // Admin sudah menyatakan "bukan orang yang sama" -> jangan cocokkan lagi.
  try {
    const cleared = await env.DB.prepare(`SELECT id FROM cerpen_watchlist WHERE subject_type = ? AND subject_id = ? AND status = 'not_same_person'`).bind(subjectType, subjectId).first();
    if (cleared) return { evaluated: false, reason: 'sudah dinyatakan bukan orang yang sama oleh admin' };
  } catch (e) { /* lanjut */ }
  let bannedRows = [];
  try {
    const rows = await env.DB.prepare(`SELECT target_type, target_id FROM cerpen_bans WHERE active = 1`).all();
    bannedRows = rows.results || [];
  } catch (e) { return { evaluated: false, reason: 'daftar ban tidak terbaca' }; }
  const bannedOwners = new Set();
  for (const b of bannedRows) {
    if (b.target_type === 'user') bannedOwners.add('user:' + b.target_id);
    if (b.target_type === 'device') bannedOwners.add('device:' + b.target_id);
  }
  if (!bannedOwners.size) return { evaluated: false, reason: 'tidak ada ban aktif untuk dibandingkan' };
  let profiles = [];
  try {
    const rows = await env.DB.prepare(`SELECT owner_key, fingerprint_hash, series_json, hours_json, avg_session_seconds, total_sessions, redeem_attempts, redeem_failed, updated_at FROM cerpen_behavior_profiles ORDER BY updated_at DESC LIMIT 200`).all();
    profiles = rows.results || [];
  } catch (e) { return { evaluated: false, reason: 'profil tidak terbaca' }; }
  let best = null;
  for (const p of profiles) {
    if (!bannedOwners.has(p.owner_key) || p.owner_key === user.owner_key) continue;
    const other = parseProfile(p);
    const sim = behaviorSimilarity(profile, other);
    if (sim.score > 0 && (!best || sim.score > best.score)) best = { score: sim.score, reasons: sim.reasons, matched_owner: p.owner_key };
  }
  if (!best || best.score < settings.behaviorMatch) return { evaluated: true, score: best ? best.score : 0, matched: false };
  const wl = await upsertWatchlist(env, {
    subjectType, subjectId, ownerKey: user.owner_key,
    reason: 'pola perilaku mirip pengguna dibanned',
    evidence: 'kemiripan ' + best.score + '% dengan ' + String(best.matched_owner).slice(0, 20) + ' — ' + best.reasons.join('; '),
    score: best.score,
  });
  // Skor terus naik melewati ambang ban -> terkonfirmasi orang yang sama.
  if (best.score >= settings.behaviorBan) {
    const ban = await applyCerpenBan(env, { targetType: subjectType, targetId: subjectId, reason: 'pola perilaku terkonfirmasi sama dengan pengguna dibanned (' + best.score + '% mirip ' + String(best.matched_owner).slice(0, 20) + ')', by: 'auto-behavior', fingerprintHash: user.fingerprint_hash || '', isEmulator: Number(user.is_emulator) === 1 });
    if (ban.ok) {
      await env.DB.prepare(`UPDATE cerpen_watchlist SET status = 'banned', updated_at = ? WHERE id = ?`).bind(Date.now(), wl.id).run();
      await logDetection(env, 'behavior_ban', { ownerKey: user.owner_key, deviceId: user.device_id || '', userId: user.user_id || null, detail: 'auto-ban pola perilaku ' + best.score + '% (cocok ' + String(best.matched_owner).slice(0, 20) + ')', score: best.score });
      return { evaluated: true, score: best.score, matched: true, autoBanned: true };
    }
  }
  return { evaluated: true, score: best.score, matched: true, watchlisted: true };
}

// ---- Baris pengguna pelacak (upsert presence + sinyal) ----
function signalFields(body) {
  const arr = v => Array.isArray(v) ? v.map(x => String(x).slice(0, 40)).filter(Boolean).slice(0, 8) : [];
  return {
    is_rooted: body.is_rooted === true || body.is_rooted === 1 ? 1 : 0,
    root_methods: arr(body.root_methods).join(','),
    is_emulator: body.is_emulator === true || body.is_emulator === 1 ? 1 : 0,
    emulator_signals: arr(body.emulator_signals).join(','),
    bootloader_locked: body.bootloader_locked === true ? 1 : body.bootloader_locked === false ? 0 : null,
    verified_boot: String(body.verified_boot || '').slice(0, 40),
    custom_rom: body.custom_rom === true || body.custom_rom === 1 ? 1 : 0,
  };
}
async function upsertTrackUser(env, { ownerKey, userId, deviceId, androidId, deviceModel, androidVersion, appVersion, fingerprintHash, signals, integrity }) {
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT owner_key, user_id, device_id, android_id, device_model, android_version, app_version, first_seen, last_seen, current_kind, current_target, current_season, current_no, reading_since, fingerprint_hash, is_rooted, root_methods, is_emulator, emulator_signals, bootloader_locked, verified_boot, custom_rom, integrity_status, integrity_verified, integrity_checked_at, last_eval_at FROM cerpen_track_users WHERE owner_key = ?`).bind(ownerKey).first();
  if (!existing) {
    await env.DB.prepare(`INSERT INTO cerpen_track_users (owner_key, user_id, device_id, android_id, device_model, android_version, app_version, first_seen, last_seen, fingerprint_hash, is_rooted, root_methods, is_emulator, emulator_signals, bootloader_locked, verified_boot, custom_rom, integrity_status, integrity_verified, integrity_checked_at, last_eval_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).bind(
      ownerKey, userId || null, deviceId || '', androidId || '', deviceModel || '', androidVersion || '', appVersion || '', now, now,
      fingerprintHash || '', signals.is_rooted, signals.root_methods, signals.is_emulator, signals.emulator_signals,
      signals.bootloader_locked, signals.verified_boot, signals.custom_rom,
      // Baris baru + tidak ada token: 'keep' berarti 'unknown' (belum ada
      // status lama yang bisa dipertahankan).
      integrity.status === 'keep' ? 'unknown' : integrity.status, integrity.verified ? 1 : 0, integrity.checked_at || 0).run();
    return { row: null, created: true };
  }
  // Integritas: bila tidak ada token baru, pertahankan status lama.
  const integStatus = integrity.status === 'keep' ? existing.integrity_status : integrity.status;
  const integVerified = integrity.status === 'keep' ? existing.integrity_verified : (integrity.verified ? 1 : 0);
  const integChecked = integrity.status === 'keep' ? existing.integrity_checked_at : (integrity.checked_at || 0);
  await env.DB.prepare(`UPDATE cerpen_track_users SET last_seen = ?, device_model = ?, android_version = ?, app_version = ?, fingerprint_hash = ?, is_rooted = ?, root_methods = ?, is_emulator = ?, emulator_signals = ?, bootloader_locked = ?, verified_boot = ?, custom_rom = ?, integrity_status = ?, integrity_verified = ?, integrity_checked_at = ? WHERE owner_key = ?`).bind(
    now, deviceModel || existing.device_model || '', androidVersion || existing.android_version || '', appVersion || existing.app_version || '',
    fingerprintHash || existing.fingerprint_hash || '', signals.is_rooted, signals.root_methods, signals.is_emulator, signals.emulator_signals,
    signals.bootloader_locked, signals.verified_boot, signals.custom_rom,
    integStatus, integVerified, integChecked, ownerKey).run();
  return { row: existing, created: false };
}

// ===================== Endpoint aplikasi =====================
// Semua di bawah gerbang versi (worker.js) + wajib API key (kecuali
// register yang MENERBITKAN kunci). Kunci dikirim lewat header
// x-cerpen-api-key (atau body.api_key untuk heartbeat/status).
async function resolveTrackKey(request, env, body) {
  const plain = String(request.headers.get('x-cerpen-api-key') || (body && body.api_key) || '').trim();
  if (!plain) return { err: aj({ ok: false, error: 'api_key_wajib' }, 401) };
  const key = await lookupApiKey(env, plain);
  if (!key) return { err: aj({ ok: false, error: 'api_key_tidak_valid' }, 401) };
  if (key.status !== 'active') return { err: aj({ ok: false, error: 'banned', target: 'api_key', reason: 'Kunci API dicabut.', expires_at: null }, 403) };
  return { key };
}
async function loadTrackUserByKey(env, key) {
  return await env.DB.prepare(`SELECT owner_key, user_id, device_id, android_id, device_model, android_version, app_version, first_seen, last_seen, current_kind, current_target, current_season, current_no, reading_since, fingerprint_hash, is_rooted, root_methods, is_emulator, emulator_signals, bootloader_locked, verified_boot, custom_rom, integrity_status, integrity_verified, integrity_checked_at, last_eval_at FROM cerpen_track_users WHERE owner_key = ?`).bind(key.owner_key).first();
}
async function deliverPending(env, ownerKey, deviceId) {
  const keys = [ownerKey];
  if (deviceId && 'device:' + deviceId !== ownerKey) keys.push('device:' + deviceId);
  const cmds = await pendingCommandsFor(env, keys);
  if (cmds.length) await markCommandsDelivered(env, cmds.map(c => c.id));
  return cmds.map(c => ({ id: c.id, kind: c.kind, payload: c.payload || '', created_at: c.created_at }));
}

export async function handleCerpenTrackApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if (!path.startsWith('/api/cerpen-track/')) return null;
  const ip = clientIp(request);

  // ---- POST /api/cerpen-track/register — kenali instalasi, terbitkan kunci ----
  if (method === 'POST' && path === '/api/cerpen-track/register') {
    if (!(await checkRateLimit(env, 'track-reg:' + ip, 10, 15 * 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' }, 429);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const deviceId = String(body.device_id || '').trim();
    const androidId = String(body.android_id || '').trim();
    const fingerprint = String(body.fingerprint || '').trim();
    if (!isUuid(deviceId)) return aj({ ok: false, error: 'device_id tidak valid' }, 400);
    if (!fingerprint || fingerprint.length < 8 || fingerprint.length > 512) return aj({ ok: false, error: 'fingerprint wajib diisi' }, 400);
    if (androidId && !isAndroidId(androidId)) return aj({ ok: false, error: 'android_id tidak valid' }, 400);
    const fingerprintHash = await sha256Hex(fingerprint);
    if (!(await checkRateLimit(env, 'track-reg-fp:' + fingerprintHash.slice(0, 16), 5, 60 * 60 * 1000))) return aj({ ok: false, error: 'Terlalu banyak pendaftaran dari perangkat ini.' }, 429);
    const user = await getCommenter(request, env);
    const ownerKey = user ? 'user:' + user.id : 'device:' + deviceId;
    const userId = user ? user.id : null;
    // God-mode admin: lewati cek ban perangkat/fingerprint.
    const adminPre = user ? await isCerpenAdmin(env, user.id, fingerprintHash) : false;
    if (!adminPre) {
      // Fingerprint / perangkat yang dibanned -> tolak SEBELUM kunci diterbitkan.
      const ban = await cerpenTrackBanCheck(env, { deviceId, fingerprintHash });
      if (ban) return bannedResponse(ban);
    }
    const signals = signalFields(body);
    // Integritas: verifikasi hanya bila token dikirim (token baru).
    let integrity = { status: 'keep', verified: false, checked_at: 0 };
    const token = String(body.integrity_token || '').trim();
    if (token) {
      const v = await verifyPlayIntegrityToken(env, token);
      integrity = { status: v.status, verified: v.status === 'passed', checked_at: Date.now() };
    }
    const up = await upsertTrackUser(env, {
      ownerKey, userId, deviceId, androidId,
      deviceModel: String(body.device_model || '').slice(0, 80),
      androidVersion: String(body.android_version || '').slice(0, 40),
      appVersion: String(body.app_version || '').slice(0, 40),
      fingerprintHash, signals, integrity,
    });
    // Ikat perangkat ke akun (bila login) — pola yang sama seperti koin.
    if (user && isUuid(deviceId)) {
      const link = await env.DB.prepare(`SELECT user_id FROM cerpen_devices WHERE device_id = ?`).bind(deviceId).first();
      const now = Date.now();
      if (!link) {
        await env.DB.prepare(`INSERT INTO cerpen_devices (device_id, user_id, android_id, label, first_seen, last_seen) VALUES (?, ?, ?, '', ?, ?)`).bind(deviceId, user.id, androidId || '', now, now).run();
      } else if (link.user_id === user.id) {
        await env.DB.prepare(`UPDATE cerpen_devices SET last_seen = ?, android_id = ? WHERE device_id = ?`).bind(now, androidId || '', deviceId).run();
      }
    }
    // Kunci aktif yang sudah ada -> JANGAN terbitkan plaintext lagi.
    const existingKey = await env.DB.prepare(`SELECT key_id, key_hash, owner_key, device_id, fingerprint_hash, status, created_at, revoked_at, revoke_reason, last_used_at FROM cerpen_track_api_keys WHERE owner_key = ? AND status = 'active'`).bind(ownerKey).first();
    const cmds = await deliverPending(env, ownerKey, deviceId);
    // God-mode admin: ikat fingerprint pertama + status admin.
    const adminSt = user ? await resolveCerpenAdmin(env, user.id, fingerprintHash) : { admin: false, admin_expires_at: 0 };
    if (existingKey) {
      return aj({ ok: true, user_id: ownerKey, type: user ? 'user' : 'guest', key_exists: true, key_id: existingKey.key_id, banned: false, commands: cmds, ...adminFields(adminSt) });
    }
    const issued = await issueApiKey(env, { ownerKey, deviceId, fingerprintHash });
    return aj({ ok: true, user_id: ownerKey, type: user ? 'user' : 'guest', api_key: issued.api_key, key_id: issued.key_id, banned: false, commands: cmds, ...adminFields(adminSt) }, 201);
  }

  // ---- POST /api/cerpen-track/heartbeat — presence + sesi + perintah + deteksi ----
  if (method === 'POST' && path === '/api/cerpen-track/heartbeat') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const resolved = await resolveTrackKey(request, env, body);
    if (resolved.err) return resolved.err;
    const key = resolved.key;
    const user = await loadTrackUserByKey(env, key);
    if (!user) return aj({ ok: false, error: 'api_key_tidak_valid' }, 401);
    const ownerKey = user.owner_key;
    const deviceId = user.device_id || '';
    const userId = user.user_id || '';
    // God-mode admin: status admin (ikat fingerprint bila belum terikat).
    const adminSt = userId ? await resolveCerpenAdmin(env, userId, user.fingerprint_hash || '') : { admin: false, admin_expires_at: 0 };
    // Ban dicek di TIAP heartbeat — ban real-time (admin dilewati).
    if (!adminSt.admin) {
      const ban = await cerpenTrackBanCheck(env, { userId, deviceId, fingerprintHash: user.fingerprint_hash || '' });
      if (ban) return bannedResponse(ban);
    }
    // Rate limit heartbeat: aplikasi normal kirim tiap ~30 detik (10x/5 mnt).
    // Melewati 12x/5 mnt = banjir -> 429 + jejak deteksi.
    if (!(await checkRateLimit(env, 'track-hb:' + ownerKey, 12, 5 * 60 * 1000))) {
      await logDetection(env, 'heartbeat_flood', { ownerKey, deviceId, userId: userId || null, detail: 'heartbeat melebihi 12x/5 menit', score: 20 });
      return aj({ ok: false, error: 'terlalu sering' }, 429);
    }
    await touchApiKey(env, key.key_hash);
    const signals = signalFields(body);
    // Integritas: verifikasi hanya bila token BARU (hash berbeda dari yang tersimpan).
    let integrity = { status: 'keep', verified: false, checked_at: 0 };
    const token = String(body.integrity_token || '').trim();
    if (token) {
      const tokenHash = await sha256Hex(token);
      if (tokenHash !== String(user.integrity_token_hash || '')) {
        const v = await verifyPlayIntegrityToken(env, token);
        integrity = { status: v.status, verified: v.status === 'passed', checked_at: Date.now() };
        try {
          await env.DB.prepare(`UPDATE cerpen_track_users SET integrity_token_hash = ? WHERE owner_key = ?`).bind(tokenHash, ownerKey).run();
        } catch (e) { /* kolom opsional */ }
      }
    }
    const reading = body.reading && typeof body.reading === 'object' ? body.reading : null;
    const readingSeconds = clampInt(body.reading_seconds, 0, 0, 120);
    const kind = reading ? String(reading.kind || '') : '';
    const targetId = reading ? String(reading.target_id || '') : '';
    const season = reading ? (Number(reading.season) || 1) : 0;
    const no = reading ? (Number(reading.no) || 0) : 0;
    const readingOk = reading && ['cerpen', 'komik'].includes(kind) && isTargetId(targetId) && season >= 1 && season <= 99 && Number.isInteger(no) && no >= 1 && no <= 9999;
    // Ack perintah yang sudah dieksekusi aplikasi.
    const acked = Array.isArray(body.acked) ? body.acked.filter(x => typeof x === 'string' && x.length <= 64) : [];
    if (acked.length) await markCommandsExecuted(env, acked);
    // Sesi: tutup bila target berubah / berhenti membaca; buka bila ada bacaan.
    const now = Date.now();
    const open = await openSession(env, ownerKey);
    const openKey = open ? open.kind + ':' + open.target_id + ':' + open.season + ':' + open.no : null;
    const newKey = readingOk ? kind + ':' + targetId + ':' + season + ':' + no : null;
    let closedSeconds = 0;
    if (open && openKey !== newKey) {
      closedSeconds = Number(open.seconds) || 0;
      await closeSession(env, open.id);
    }
    let sessionId = open && openKey === newKey ? open.id : null;
    if (readingOk && !sessionId) {
      sessionId = 'rs-' + randomHex(8);
      await env.DB.prepare(`INSERT INTO cerpen_read_sessions (id, owner_key, user_id, device_id, kind, target_id, season, no, started_at, ended_at, seconds, app_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`).bind(sessionId, ownerKey, userId || null, deviceId, kind, targetId, season, no, now, String(body.app_version || user.app_version || '').slice(0, 40), now).run();
    }
    if (sessionId && readingSeconds > 0) await addSessionSeconds(env, sessionId, readingSeconds);
    // Presence + sinyal terbaru di baris pengguna.
    const curKind = readingOk ? kind : '';
    const curTarget = readingOk ? targetId : '';
    const curSeason = readingOk ? season : 0;
    const curNo = readingOk ? no : 0;
    const readingSince = readingOk ? (open && openKey === newKey && user.reading_since ? Number(user.reading_since) : now) : 0;
    await env.DB.prepare(`UPDATE cerpen_track_users SET last_seen = ?, app_version = ?, current_kind = ?, current_target = ?, current_season = ?, current_no = ?, reading_since = ?, is_rooted = ?, root_methods = ?, is_emulator = ?, emulator_signals = ?, bootloader_locked = ?, verified_boot = ?, custom_rom = ?, integrity_status = ?, integrity_verified = ?, integrity_checked_at = ? WHERE owner_key = ?`).bind(
      now, String(body.app_version || user.app_version || '').slice(0, 40), curKind, curTarget, curSeason, curNo, readingSince,
      signals.is_rooted, signals.root_methods, signals.is_emulator, signals.emulator_signals,
      signals.bootloader_locked, signals.verified_boot, signals.custom_rom,
      integrity.status === 'keep' ? user.integrity_status : integrity.status,
      integrity.status === 'keep' ? user.integrity_verified : (integrity.verified ? 1 : 0),
      integrity.status === 'keep' ? user.integrity_checked_at : integrity.checked_at,
      ownerKey).run();
    // Profil perilaku: series + jam (WIB) diperbarui tiap heartbeat membaca.
    const { row: profRow, profile } = await loadProfile(env, ownerKey);
    if (readingOk) {
      const sKey = kind + ':' + targetId;
      profile.series[sKey] = (Number(profile.series[sKey]) || 0) + 1;
      const entries = Object.entries(profile.series).sort((a, b) => b[1] - a[1]);
      if (entries.length > 20) {
        profile.series = Object.fromEntries(entries.slice(0, 20));
      }
      profile.hours[wibHour(now)] = (Number(profile.hours[wibHour(now)]) || 0) + 1;
    }
    if (closedSeconds > 0 || (open && openKey !== newKey)) {
      // Sesi baru saja ditutup -> perbarui rata-rata durasi.
      const total = profile.totalSessions;
      profile.avgSessionSeconds = total > 0 ? (profile.avgSessionSeconds * total + closedSeconds) / (total + 1) : closedSeconds;
      profile.totalSessions = total + 1;
    }
    await saveProfile(env, ownerKey, user.fingerprint_hash || '', profile);
    // Deteksi + pencocokan perilaku: maks 1x/60 detik per pemilik.
    // God-mode admin: dilewati sepenuhnya (tidak ada skor/watchlist/ban).
    const settings = await getDetectSettings(env);
    if (settings.enabled && !adminSt.admin && (!user.last_eval_at || now - Number(user.last_eval_at) >= 60 * 1000)) {
      const freshUser = { ...user, is_emulator: signals.is_emulator, integrity_status: integrity.status === 'keep' ? user.integrity_status : integrity.status };
      await evaluateDetection(env, freshUser, settings);
      await evaluateBehaviorMatch(env, freshUser, profile, settings);
      await env.DB.prepare(`UPDATE cerpen_track_users SET last_eval_at = ? WHERE owner_key = ?`).bind(now, ownerKey).run();
      // Deteksi bisa menghasilkan ban seketika -> cek ulang sebelum balas.
      const banAfter = await cerpenTrackBanCheck(env, { userId, deviceId, fingerprintHash: user.fingerprint_hash || '' });
      if (banAfter) return bannedResponse(banAfter);
    }
    const cmds = await deliverPending(env, ownerKey, deviceId);
    return aj({ ok: true, user_id: ownerKey, banned: false, commands: cmds, ...adminFields(adminSt) });
  }

  // ---- GET /api/cerpen-track/status — cek banned + perintah (saat buka aplikasi) ----
  if (method === 'GET' && path === '/api/cerpen-track/status') {
    const plain = String(request.headers.get('x-cerpen-api-key') || url.searchParams.get('api_key') || '').trim();
    if (!plain) return aj({ ok: false, error: 'api_key_wajib' }, 401);
    const key = await lookupApiKey(env, plain);
    if (!key) return aj({ ok: false, error: 'api_key_tidak_valid' }, 401);
    if (key.status !== 'active') return aj({ ok: false, error: 'banned', target: 'api_key', reason: 'Kunci API dicabut.', expires_at: null }, 403);
    const user = await loadTrackUserByKey(env, key);
    if (!user) return aj({ ok: false, error: 'api_key_tidak_valid' }, 401);
    const adminSt = user.user_id ? await resolveCerpenAdmin(env, user.user_id, user.fingerprint_hash || '') : { admin: false, admin_expires_at: 0 };
    if (!adminSt.admin) {
      const ban = await cerpenTrackBanCheck(env, { userId: user.user_id || '', deviceId: user.device_id || '', fingerprintHash: user.fingerprint_hash || '' });
      if (ban) return bannedResponse(ban);
    }
    await touchApiKey(env, key.key_hash);
    const cmds = await deliverPending(env, user.owner_key, user.device_id || '');
    return aj({ ok: true, user_id: user.owner_key, banned: false, commands: cmds, ...adminFields(adminSt) });
  }

  // ---- POST /api/cerpen-track/session/end — tutup sesi baca secara eksplisit ----
  if (method === 'POST' && path === '/api/cerpen-track/session/end') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const resolved = await resolveTrackKey(request, env, body);
    if (resolved.err) return resolved.err;
    const key = resolved.key;
    const user = await loadTrackUserByKey(env, key);
    if (!user) return aj({ ok: false, error: 'api_key_tidak_valid' }, 401);
    const adminEnd = user.user_id ? await isCerpenAdmin(env, user.user_id, user.fingerprint_hash || '') : false;
    if (!adminEnd) {
      const ban = await cerpenTrackBanCheck(env, { userId: user.user_id || '', deviceId: user.device_id || '', fingerprintHash: user.fingerprint_hash || '' });
      if (ban) return bannedResponse(ban);
    }
    const readingSeconds = clampInt(body.reading_seconds, 0, 0, 120);
    const open = await openSession(env, user.owner_key);
    if (!open) return aj({ ok: true, closed: false, seconds: 0 });
    const totalSeconds = (Number(open.seconds) || 0) + readingSeconds;
    if (readingSeconds > 0) await addSessionSeconds(env, open.id, readingSeconds);
    await closeSession(env, open.id);
    const { profile } = await loadProfile(env, user.owner_key);
    const total = profile.totalSessions;
    profile.avgSessionSeconds = total > 0 ? (profile.avgSessionSeconds * total + totalSeconds) / (total + 1) : totalSeconds;
    profile.totalSessions = total + 1;
    await saveProfile(env, user.owner_key, user.fingerprint_hash || '', profile);
    await env.DB.prepare(`UPDATE cerpen_track_users SET current_kind = '', current_target = '', current_season = 0, current_no = 0, reading_since = 0 WHERE owner_key = ?`).bind(user.owner_key).run();
    return aj({ ok: true, closed: true, seconds: totalSeconds });
  }

  // ---- POST /api/cerpen-track/key/rotate — ganti kunci (kunci lama / sidik cocok) ----
  if (method === 'POST' && path === '/api/cerpen-track/key/rotate') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const oldPlain = String(request.headers.get('x-cerpen-api-key') || '').trim();
    let ownerKey = '';
    let deviceId = '';
    let fingerprintHash = '';
    if (oldPlain) {
      const old = await lookupApiKey(env, oldPlain);
      if (!old || old.status !== 'active') return aj({ ok: false, error: 'api_key_tidak_valid' }, 401);
      ownerKey = old.owner_key;
      deviceId = old.device_id || '';
      fingerprintHash = old.fingerprint_hash || '';
      await env.DB.prepare(`UPDATE cerpen_track_api_keys SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE key_id = ? AND status = 'active'`).bind(Date.now(), 'rotated', old.key_id).run();
    } else {
      // Tanpa kunci lama: device_id + fingerprint harus cocok dengan baris tersimpan.
      const did = String(body.device_id || '').trim();
      const fp = String(body.fingerprint || '').trim();
      if (!isUuid(did) || !fp) return aj({ ok: false, error: 'device_id + fingerprint wajib (atau kirim kunci lama)' }, 400);
      const fpHash = await sha256Hex(fp);
      const row = await env.DB.prepare(`SELECT owner_key, user_id, device_id, android_id, device_model, android_version, app_version, first_seen, last_seen, current_kind, current_target, current_season, current_no, reading_since, fingerprint_hash, is_rooted, root_methods, is_emulator, emulator_signals, bootloader_locked, verified_boot, custom_rom, integrity_status, integrity_verified, integrity_checked_at, last_eval_at FROM cerpen_track_users WHERE device_id = ?`).bind(did).first();
      if (!row || String(row.fingerprint_hash || '') !== fpHash) return aj({ ok: false, error: 'fingerprint tidak cocok' }, 401);
      ownerKey = row.owner_key;
      deviceId = row.device_id || '';
      fingerprintHash = fpHash;
      const adminRot = row.user_id ? await isCerpenAdmin(env, row.user_id, fpHash) : false;
      if (!adminRot) {
        const ban = await cerpenTrackBanCheck(env, { userId: row.user_id || '', deviceId, fingerprintHash });
        if (ban) return bannedResponse(ban);
      }
      await revokeKeysForOwner(env, ownerKey, 'rotated');
    }
    const issued = await issueApiKey(env, { ownerKey, deviceId, fingerprintHash });
    return aj({ ok: true, user_id: ownerKey, api_key: issued.api_key, key_id: issued.key_id });
  }

  return aj({ ok: false, error: 'endpoint tidak dikenal' }, 404);
}

// ===================== Endpoint admin =====================
export async function handleCerpenTrackAdmin(request, env, url, admin) {
  const path = url.pathname;
  const method = request.method;
  if (!path.startsWith('/api/admin/cerpen-track')) return null;
  if (!admin) return aj({ ok: false, error: 'unauthorized' }, 401);
  if (!safeEqualHex(String(request.headers.get('x-csrf') || ''), await csrfToken(env))) return aj({ ok: false, error: 'csrf tidak valid' }, 403);
  if (!(await checkRateLimit(env, 'track-admin:' + clientIp(request), 60, 10 * 60 * 1000))) return aj({ ok: false, error: 'terlalu banyak permintaan' }, 429);
  const q = (name) => url.searchParams.get(name) || '';
  const limitQ = (dflt, max) => Math.min(Math.max(parseInt(q('limit') || String(dflt), 10) || dflt, 1), max);

  // GET /api/admin/cerpen-track/overview
  if (path === '/api/admin/cerpen-track/overview' && method === 'GET') {
    const users = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_track_users`).first();
    const online = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_track_users WHERE last_seen >= ?`).bind(Date.now() - 5 * 60 * 1000).first();
    const bans = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_bans WHERE active = 1`).first();
    const watching = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_watchlist WHERE status = 'watching'`).first();
    const pendingCmds = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_commands WHERE status = 'pending'`).first();
    const revoked = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_track_api_keys WHERE status = 'revoked'`).first();
    const det24 = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_detection_events WHERE created_at >= ?`).bind(Date.now() - 24 * 3600 * 1000).first();
    const read7 = await env.DB.prepare(`SELECT COALESCE(SUM(seconds), 0) AS s FROM cerpen_read_sessions WHERE started_at >= ?`).bind(Date.now() - 7 * 24 * 3600 * 1000).first();
    return aj({
      ok: true,
      users: Number(users?.c) || 0, online: Number(online?.c) || 0,
      active_bans: Number(bans?.c) || 0, watching: Number(watching?.c) || 0,
      pending_commands: Number(pendingCmds?.c) || 0, revoked_keys: Number(revoked?.c) || 0,
      detections_24h: Number(det24?.c) || 0, read_seconds_7d: Number(read7?.s) || 0,
    });
  }

  // GET /api/admin/cerpen-track/live — siapa online + baca apa + berapa menit
  if (path === '/api/admin/cerpen-track/live' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT owner_key, user_id, device_id, device_model, last_seen, current_kind, current_target, current_season, current_no, reading_since FROM cerpen_track_users WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT ?`).bind(Date.now() - 5 * 60 * 1000, limitQ(50, 100)).all();
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
    return aj({
      ok: true,
      live: (rows.results || []).map(r => ({
        owner_key: r.owner_key, username: r.user_id ? (nameMap.get(r.user_id) || '') : '',
        device_model: r.device_model || '', last_seen: r.last_seen,
        reading: r.current_target ? { kind: r.current_kind, target_id: r.current_target, season: r.current_season, no: r.current_no, minutes: r.reading_since ? Math.max(0, Math.floor((Date.now() - Number(r.reading_since)) / 60000)) : 0 } : null,
      })),
    });
  }

  // GET /api/admin/cerpen-track/users — daftar pengguna + flag
  if (path === '/api/admin/cerpen-track/users' && method === 'GET') {
    const term = q('q').trim();
    const limit = limitQ(20, 50);
    let rows;
    if (term) {
      const like = '%' + escapeLikeTerm(term) + '%';
      rows = await env.DB.prepare(`SELECT owner_key, user_id, device_id, device_model, app_version, first_seen, last_seen, current_kind, current_target, current_season, current_no, reading_since, is_rooted, is_emulator, integrity_status FROM cerpen_track_users WHERE owner_key LIKE ? ESCAPE '!' OR device_id LIKE ? ESCAPE '!' OR user_id LIKE ? ESCAPE '!' ORDER BY last_seen DESC LIMIT ?`).bind(like, like, like, limit).all();
    } else {
      rows = await env.DB.prepare(`SELECT owner_key, user_id, device_id, device_model, app_version, first_seen, last_seen, current_kind, current_target, current_season, current_no, reading_since, is_rooted, is_emulator, integrity_status FROM cerpen_track_users ORDER BY last_seen DESC LIMIT ?`).bind(limit).all();
    }
    const list = rows.results || [];
    const bans = await env.DB.prepare(`SELECT target_type, target_id FROM cerpen_bans WHERE active = 1`).all();
    const banSet = new Set((bans.results || []).map(b => b.target_type + ':' + b.target_id));
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
    return aj({
      ok: true,
      users: list.map(r => ({
        owner_key: r.owner_key, username: r.user_id ? (nameMap.get(r.user_id) || '') : '',
        device_id: r.device_id, device_model: r.device_model || '', app_version: r.app_version || '',
        first_seen: r.first_seen, last_seen: r.last_seen,
        reading: r.current_target ? { kind: r.current_kind, target_id: r.current_target, season: r.current_season, no: r.current_no } : null,
        is_rooted: Number(r.is_rooted) || 0, is_emulator: Number(r.is_emulator) || 0, integrity_status: r.integrity_status || 'unknown',
        banned: banSet.has('user:' + (r.user_id || '')) || banSet.has('device:' + (r.device_id || '')),
      })),
    });
  }

  // GET /api/admin/cerpen-track/users/:owner_key — detail lengkap
  const userDetail = path.match(/^\/api\/admin\/cerpen-track\/users\/(.+)$/);
  if (userDetail && method === 'GET' && !path.includes('/sessions')) {
    const ownerKey = decodeURIComponent(userDetail[1]);
    if (!isOwnerKey(ownerKey)) return aj({ ok: false, error: 'owner_key tidak valid' }, 400);
    const user = await env.DB.prepare(`SELECT owner_key, user_id, device_id, android_id, device_model, android_version, app_version, first_seen, last_seen, current_kind, current_target, current_season, current_no, reading_since, fingerprint_hash, is_rooted, root_methods, is_emulator, emulator_signals, bootloader_locked, verified_boot, custom_rom, integrity_status, integrity_verified, integrity_checked_at, last_eval_at FROM cerpen_track_users WHERE owner_key = ?`).bind(ownerKey).first();
    if (!user) return aj({ ok: false, error: 'pengguna tidak ditemukan' }, 404);
    const sessions = await env.DB.prepare(`SELECT id, kind, target_id, season, no, started_at, ended_at, seconds FROM cerpen_read_sessions WHERE owner_key = ? ORDER BY started_at DESC LIMIT 50`).bind(ownerKey).all();
    const cmds = await env.DB.prepare(`SELECT id, owner_key, user_id, device_id, kind, payload, status, created_at, created_by, delivered_at, executed_at, note FROM cerpen_commands WHERE owner_key = ? ORDER BY created_at DESC LIMIT 20`).bind(ownerKey).all();
    const bans = await env.DB.prepare(`SELECT id, target_type, target_id, reason, banned_by, created_at, expires_at, active, unbanned_at, unban_note FROM cerpen_bans WHERE (target_type = 'user' AND target_id = ?) OR (target_type = 'device' AND target_id = ?) ORDER BY created_at DESC LIMIT 10`).bind(user.user_id || '', user.device_id || '').all();
    const watch = await env.DB.prepare(`SELECT id, subject_type, subject_id, owner_key, reason, evidence, score, status, created_at, updated_at FROM cerpen_watchlist WHERE owner_key = ? ORDER BY updated_at DESC LIMIT 10`).bind(ownerKey).all();
    const detections = await env.DB.prepare(`SELECT id, kind, detail, score, created_at FROM cerpen_detection_events WHERE owner_key = ? ORDER BY created_at DESC LIMIT 20`).bind(ownerKey).all();
    const profile = await loadProfile(env, ownerKey);
    const redemptions = await env.DB.prepare(`SELECT id, code_hash, owner_key, device_id, user_id, created_at FROM cerpen_voucher_redemptions WHERE owner_key = ? ORDER BY created_at DESC LIMIT 20`).bind(ownerKey).all();
    const vouchers = await env.DB.prepare(`SELECT code_hash, batch_id FROM cerpen_vouchers`).all();
    const batchMap = new Map((vouchers.results || []).map(v => [v.code_hash, v.batch_id]));
    const keys = await env.DB.prepare(`SELECT key_id, owner_key, device_id, fingerprint_hash, status, created_at, revoked_at, revoke_reason FROM cerpen_track_api_keys WHERE owner_key = ? ORDER BY created_at DESC LIMIT 10`).bind(ownerKey).all();
    const username = user.user_id ? (await env.DB.prepare(`SELECT username FROM cms_users WHERE id = ?`).bind(user.user_id).first())?.username || '' : '';
    return aj({
      ok: true,
      user: {
        ...user,
        fingerprint_hash: user.fingerprint_hash || '',
        fingerprint_prefix: String(user.fingerprint_hash || '').slice(0, 12),
        username,
        is_rooted: Number(user.is_rooted) || 0, is_emulator: Number(user.is_emulator) || 0,
        custom_rom: Number(user.custom_rom) || 0, integrity_verified: Number(user.integrity_verified) || 0,
      },
      sessions: sessions.results || [], commands: cmds.results || [], bans: bans.results || [],
      watchlist: watch.results || [], detections: detections.results || [],
      profile: { series_top: topSeriesList(profile.profile.series), hours: profile.profile.hours, avg_session_seconds: Math.round(profile.profile.avgSessionSeconds), total_sessions: profile.profile.totalSessions },
      redemptions: (redemptions.results || []).map(r => ({ ...r, batch_id: batchMap.get(r.code_hash) || '', code_prefix: String(r.code_hash || '').slice(0, 8) })),
      api_keys: (keys.results || []).map(k => ({ ...k, key_hash_prefix: '', fingerprint_prefix: String(k.fingerprint_hash || '').slice(0, 8) })),
    });
  }

  // GET /api/admin/cerpen-track/summary — seri terpopuler + total jam + pembaca teratas
  if (path === '/api/admin/cerpen-track/summary' && method === 'GET') {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const top = await env.DB.prepare(`SELECT target_id, SUM(seconds) AS total FROM cerpen_read_sessions WHERE kind = 'cerpen' AND started_at >= ? GROUP BY target_id ORDER BY total DESC LIMIT 10`).bind(since).all();
    const total = await env.DB.prepare(`SELECT COALESCE(SUM(seconds), 0) AS s FROM cerpen_read_sessions WHERE started_at >= ?`).bind(since).first();
    const readers = await env.DB.prepare(`SELECT owner_key, SUM(seconds) AS total FROM cerpen_read_sessions WHERE started_at >= ? GROUP BY owner_key ORDER BY total DESC LIMIT 10`).bind(since).all();
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
    const readerNames = new Map();
    for (const r of (readers.results || [])) {
      const m = String(r.owner_key || '').match(/^user:(u-[0-9a-z]+)$/);
      readerNames.set(r.owner_key, m ? (nameMap.get(m[1]) || '') : '');
    }
    return aj({
      ok: true,
      top_series: (top.results || []).map(r => ({ target_id: r.target_id, seconds: Number(r.total) || 0 })),
      total_seconds_7d: Number(total?.s) || 0,
      top_readers: (readers.results || []).map(r => ({ owner_key: r.owner_key, username: readerNames.get(r.owner_key) || '', seconds: Number(r.total) || 0 })),
    });
  }

  // GET /api/admin/cerpen-track/watchlist
  if (path === '/api/admin/cerpen-track/watchlist' && method === 'GET') {
    const status = q('status') || '';
    const limit = limitQ(20, 50);
    let rows;
    if (status && ['watching', 'cleared', 'banned', 'not_same_person'].includes(status)) {
      rows = await env.DB.prepare(`SELECT id, subject_type, subject_id, owner_key, reason, evidence, score, status, created_at, updated_at FROM cerpen_watchlist WHERE status = ? ORDER BY updated_at DESC LIMIT ?`).bind(status, limit).all();
    } else {
      rows = await env.DB.prepare(`SELECT id, subject_type, subject_id, owner_key, reason, evidence, score, status, created_at, updated_at FROM cerpen_watchlist ORDER BY updated_at DESC LIMIT ?`).bind(limit).all();
    }
    return aj({ ok: true, watchlist: rows.results || [] });
  }

  // POST /api/admin/cerpen-track/watchlist/:id/review
  const wlReview = path.match(/^\/api\/admin\/cerpen-track\/watchlist\/([^/]+)\/review$/);
  if (wlReview && method === 'POST') {
    const id = wlReview[1];
    if (!/^wl-[0-9a-f]+$/.test(id)) return aj({ ok: false, error: 'id tidak valid' }, 400);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const status = String(body.status || '');
    const note = String(body.note || '').trim().slice(0, 500);
    if (!['cleared', 'not_same_person', 'banned'].includes(status)) return aj({ ok: false, error: 'status harus cleared | not_same_person | banned' }, 400);
    const row = await env.DB.prepare(`SELECT id, subject_type, subject_id, owner_key, reason, evidence, score, status, created_at, updated_at FROM cerpen_watchlist WHERE id = ?`).bind(id).first();
    if (!row) return aj({ ok: false, error: 'entri watchlist tidak ditemukan' }, 404);
    if (row.status !== 'watching') return aj({ ok: false, error: 'entri ini sudah ditinjau (' + row.status + ')' }, 409);
    if (status === 'banned') {
      const ban = await applyCerpenBan(env, { targetType: row.subject_type, targetId: row.subject_id, reason: 'ban manual dari watchlist: ' + (row.reason || '') + (note ? ' — ' + note : ''), by: 'admin' });
      if (!ban.ok) return aj({ ok: false, error: ban.error }, 409);
      await env.DB.prepare(`UPDATE cerpen_watchlist SET status = 'banned', reviewed_by = 'admin', reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?`).bind(Date.now(), note, Date.now(), id).run();
      return aj({ ok: true, id, status: 'banned', ban_id: ban.id });
    }
    await env.DB.prepare(`UPDATE cerpen_watchlist SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ? WHERE id = ?`).bind(status, 'admin', Date.now(), note, Date.now(), id).run();
    return aj({ ok: true, id, status });
  }

  // GET /api/admin/cerpen-track/bans
  if (path === '/api/admin/cerpen-track/bans' && method === 'GET') {
    const activeOnly = q('active') !== '0';
    const limit = limitQ(50, 100);
    let rows;
    if (activeOnly) {
      rows = await env.DB.prepare(`SELECT id, target_type, target_id, reason, banned_by, created_at, expires_at, active FROM cerpen_bans WHERE active = 1 ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    } else {
      rows = await env.DB.prepare(`SELECT id, target_type, target_id, reason, banned_by, created_at, expires_at, active, unbanned_at, unban_note FROM cerpen_bans ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    }
    const list = rows.results || [];
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
    return aj({ ok: true, bans: list.map(b => ({ ...b, username: b.target_type === 'user' ? (nameMap.get(b.target_id) || '') : '', active: Number(b.active) || 0 })) });
  }

  // POST /api/admin/cerpen-track/bans — ban user / device / fingerprint
  if (path === '/api/admin/cerpen-track/bans' && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const targetType = String(body.target_type || 'user');
    const targetId = String(body.target_id || '').trim();
    const reason = String(body.reason || '').trim();
    const expiresAt = body.expires_at == null || body.expires_at === '' ? null : Number(body.expires_at);
    if (!['user', 'device', 'fingerprint'].includes(targetType)) return aj({ ok: false, error: 'target_type harus user | device | fingerprint' }, 400);
    if (targetType === 'user' && !isUserId(targetId)) return aj({ ok: false, error: 'target_id user tidak valid' }, 400);
    if (targetType === 'device' && !isUuid(targetId)) return aj({ ok: false, error: 'target_id device tidak valid' }, 400);
    if (targetType === 'fingerprint' && !isHash64(targetId)) return aj({ ok: false, error: 'target_id fingerprint harus hash 64 hex' }, 400);
    if (!reason || reason.length > 500) return aj({ ok: false, error: 'reason wajib 1–500 karakter' }, 400);
    if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= nowSec() || expiresAt > nowSec() + 2 * 365 * 86400)) return aj({ ok: false, error: 'expires_at harus unix detik di masa depan (maks 2 tahun)' }, 400);
    let fp = '';
    let isEmu = false;
    if (targetType === 'device') {
      const u = await env.DB.prepare(`SELECT fingerprint_hash, is_emulator FROM cerpen_track_users WHERE device_id = ?`).bind(targetId).first();
      if (u) { fp = u.fingerprint_hash || ''; isEmu = Number(u.is_emulator) === 1; }
    }
    const ban = await applyCerpenBan(env, { targetType, targetId, reason, expiresAtSec: expiresAt, by: 'admin', fingerprintHash: fp, isEmulator: isEmu });
    if (!ban.ok) return aj({ ok: false, error: ban.error }, 409);
    return aj({ ok: true, id: ban.id, target_type: targetType, target_id: targetId, reason, expires_at: expiresAt }, 201);
  }

  // POST /api/admin/cerpen-track/bans/:id/unban
  const banUnban = path.match(/^\/api\/admin\/cerpen-track\/bans\/([^/]+)\/unban$/);
  if (banUnban && method === 'POST') {
    const banId = banUnban[1];
    if (!/^ban-[0-9a-f]+$/.test(banId)) return aj({ ok: false, error: 'ban_id tidak valid' }, 400);
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const note = String(body.note || '').trim().slice(0, 500);
    const upd = await env.DB.prepare(`UPDATE cerpen_bans SET active = 0, unbanned_at = ?, unbanned_by = 'admin', unban_note = ? WHERE id = ? AND active = 1`).bind(Date.now(), note, banId).run();
    if (!upd || !upd.meta || Number(upd.meta.changes) !== 1) return aj({ ok: false, error: 'ban tidak ditemukan atau sudah dicabut' }, 404);
    // Kunci yang dicabut OLEH ban ini dipulihkan (revoke_reason = 'ban:<id>').
    await env.DB.prepare(`UPDATE cerpen_track_api_keys SET status = 'active', revoked_at = NULL, revoke_reason = '' WHERE revoke_reason = ? AND status = 'revoked'`).bind('ban:' + banId).run();
    await logDetection(env, 'ban_unban', { detail: 'unban ' + banId + (note ? ' — ' + note : ''), score: 0 });
    return aj({ ok: true, id: banId });
  }

  // GET /api/admin/cerpen-track/redeems — log penukaran kode
  if (path === '/api/admin/cerpen-track/redeems' && method === 'GET') {
    const limit = limitQ(50, 100);
    const rows = await env.DB.prepare(`SELECT id, code_hash, owner_key, device_id, user_id, created_at FROM cerpen_voucher_redemptions ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    const vouchers = await env.DB.prepare(`SELECT code_hash, batch_id FROM cerpen_vouchers`).all();
    const batchMap = new Map((vouchers.results || []).map(v => [v.code_hash, v.batch_id]));
    const batches = await env.DB.prepare(`SELECT batch_id, reward_type, reward_coins, reward_value, reward_target_kind, reward_target_id, reward_season, reward_no FROM cerpen_voucher_batches`).all();
    const batchInfo = new Map((batches.results || []).map(b => [b.batch_id, b]));
    const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
    const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
    return aj({
      ok: true,
      redeems: (rows.results || []).map(r => {
        const batchId = batchMap.get(r.code_hash) || '';
        const b = batchInfo.get(batchId) || null;
        return {
          ...r, batch_id: batchId, code_prefix: String(r.code_hash || '').slice(0, 8),
          username: r.user_id ? (nameMap.get(r.user_id) || '') : '',
          reward: b ? (b.reward_type === 'coins' ? (Number(b.reward_coins ?? b.reward_value) || 0) + ' koin' : b.reward_type === 'vip' ? 'VIP ' + (Number(b.reward_value) || 0) + ' hari' : b.reward_type + ' ' + (b.reward_target_kind || '') + ':' + (b.reward_target_id || '')) : '',
        };
      }),
    });
  }

  // GET /api/admin/cerpen-track/commands
  if (path === '/api/admin/cerpen-track/commands' && method === 'GET') {
    const status = q('status') || '';
    const limit = limitQ(50, 100);
    let rows;
    if (status && ['pending', 'delivered', 'executed', 'expired'].includes(status)) {
      rows = await env.DB.prepare(`SELECT id, owner_key, user_id, device_id, kind, payload, status, created_at, created_by, delivered_at, executed_at, note FROM cerpen_commands WHERE status = ? ORDER BY created_at DESC LIMIT ?`).bind(status, limit).all();
    } else {
      rows = await env.DB.prepare(`SELECT id, owner_key, user_id, device_id, kind, payload, status, created_at, created_by, delivered_at, executed_at, note FROM cerpen_commands ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    }
    return aj({ ok: true, commands: rows.results || [] });
  }

  // POST /api/admin/cerpen-track/commands — antre perintah kick / crash
  if (path === '/api/admin/cerpen-track/commands' && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const kind = String(body.kind || '');
    const note = String(body.note || '').trim().slice(0, 500);
    let ownerKey = String(body.owner_key || '').trim();
    if (!ownerKey) {
      if (body.user_id && isUserId(String(body.user_id))) ownerKey = 'user:' + String(body.user_id);
      else if (body.device_id && isUuid(String(body.device_id))) ownerKey = 'device:' + String(body.device_id);
    }
    if (!['kick', 'crash'].includes(kind)) return aj({ ok: false, error: 'kind harus kick | crash' }, 400);
    if (!isOwnerKey(ownerKey)) return aj({ ok: false, error: 'owner_key / user_id / device_id tidak valid' }, 400);
    const user = await env.DB.prepare(`SELECT owner_key, user_id, device_id FROM cerpen_track_users WHERE owner_key = ?`).bind(ownerKey).first();
    if (!user) return aj({ ok: false, error: 'pengguna tidak ditemukan (belum pernah register tracking)' }, 404);
    const id = 'cmd-' + randomHex(6);
    await env.DB.prepare(`INSERT INTO cerpen_commands (id, owner_key, user_id, device_id, kind, payload, status, created_at, created_by, note) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'admin', ?)`).bind(id, ownerKey, user.user_id || null, user.device_id || '', kind, kind, Date.now(), note).run();
    await logDetection(env, 'command_create', { ownerKey, deviceId: user.device_id || '', userId: user.user_id || null, detail: 'perintah ' + kind + ' untuk ' + ownerKey + (note ? ' — ' + note : ''), score: 0 });
    return aj({ ok: true, id, owner_key: ownerKey, kind }, 201);
  }

  // POST /api/admin/cerpen-track/commands/:id/cancel
  const cmdCancel = path.match(/^\/api\/admin\/cerpen-track\/commands\/([^/]+)\/cancel$/);
  if (cmdCancel && method === 'POST') {
    const id = cmdCancel[1];
    if (!/^cmd-[0-9a-f]+$/.test(id)) return aj({ ok: false, error: 'id tidak valid' }, 400);
    const upd = await env.DB.prepare(`UPDATE cerpen_commands SET status = 'expired' WHERE id = ? AND status = 'pending'`).bind(id).run();
    if (!upd || !upd.meta || Number(upd.meta.changes) !== 1) return aj({ ok: false, error: 'perintah tidak ditemukan atau sudah tidak pending' }, 404);
    return aj({ ok: true, id });
  }

  // GET /api/admin/cerpen-track/keys — daftar kunci dicabut
  if (path === '/api/admin/cerpen-track/keys' && method === 'GET') {
    const limit = limitQ(50, 100);
    const rows = await env.DB.prepare(`SELECT key_id, owner_key, device_id, fingerprint_hash, status, created_at, revoked_at, revoke_reason FROM cerpen_track_api_keys WHERE status = 'revoked' ORDER BY revoked_at DESC LIMIT ?`).bind(limit).all();
    return aj({ ok: true, keys: (rows.results || []).map(k => ({ ...k, fingerprint_prefix: String(k.fingerprint_hash || '').slice(0, 8) })) });
  }

  // GET /api/admin/cerpen-track/detections — log deteksi
  if (path === '/api/admin/cerpen-track/detections' && method === 'GET') {
    const kind = q('kind') || '';
    const limit = limitQ(50, 100);
    let rows;
    if (kind) {
      rows = await env.DB.prepare(`SELECT id, kind, owner_key, device_id, user_id, detail, score, created_at FROM cerpen_detection_events WHERE kind = ? ORDER BY created_at DESC LIMIT ?`).bind(kind, limit).all();
    } else {
      rows = await env.DB.prepare(`SELECT id, kind, owner_key, device_id, user_id, detail, score, created_at FROM cerpen_detection_events ORDER BY created_at DESC LIMIT ?`).bind(limit).all();
    }
    return aj({ ok: true, detections: rows.results || [] });
  }

  // GET /api/admin/cerpen-track/settings — ambang deteksi
  if (path === '/api/admin/cerpen-track/settings' && method === 'GET') {
    const s = await getDetectSettings(env);
    return aj({ ok: true, settings: s, integrity_configured: !!env.PLAY_INTEGRITY_SERVICE_ACCOUNT });
  }

  // POST /api/admin/cerpen-track/settings — ubah ambang deteksi
  if (path === '/api/admin/cerpen-track/settings' && method === 'POST') {
    const { body, err } = await readJsonBody(request);
    if (err) return aj({ ok: false, error: err }, 400);
    const updates = [];
    const map = {
      enabled: 'cerpen_detect_enabled',
      watch_score: 'cerpen_detect_watch_score',
      auto_ban_score: 'cerpen_detect_auto_ban_score',
      behavior_match: 'cerpen_detect_behavior_match',
      behavior_ban: 'cerpen_detect_behavior_ban',
    };
    for (const [field, key] of Object.entries(map)) {
      if (body[field] === undefined) continue;
      const v = Number(body[field]);
      if (field === 'enabled') {
        if (v !== 0 && v !== 1) return aj({ ok: false, error: 'enabled harus 0 atau 1' }, 400);
      } else if (!Number.isInteger(v) || v < 0 || v > 100) {
        return aj({ ok: false, error: field + ' harus 0–100' }, 400);
      }
      updates.push({ key, value: String(v) });
    }
    if (!updates.length) return aj({ ok: false, error: 'tidak ada pengaturan yang diubah' }, 400);
    for (const u of updates) {
      await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('${u.key}', ?)`).bind(u.value).run();
    }
    const s = await getDetectSettings(env);
    return aj({ ok: true, settings: s });
  }

  return aj({ ok: false, error: 'endpoint tidak dikenal' }, 404);
}

// ===================== Panel admin /kendali/cerpen-pantau =====================
// Dipanggil worker.js dari cabang GET /kendali (admin sudah terverifikasi).
// Semua aksi lewat fetch ke /api/admin/cerpen-track/* dengan header x-csrf.
export async function renderCerpenTrackPanel(env, csrf, nav, notice) {
  const wib = v => { const n = Number(v || 0); const ms = (n > 0 && n < 1e12) ? n * 1000 : n; return new Date(ms + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16); };
  const ov = await (async () => {
    try {
      const users = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_track_users`).first();
      const online = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_track_users WHERE last_seen >= ?`).bind(Date.now() - 5 * 60 * 1000).first();
      const bans = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_bans WHERE active = 1`).first();
      const watching = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_watchlist WHERE status = 'watching'`).first();
      const pendingCmds = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_commands WHERE status = 'pending'`).first();
      const revoked = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_track_api_keys WHERE status = 'revoked'`).first();
      const det24 = await env.DB.prepare(`SELECT COUNT(*) AS c FROM cerpen_detection_events WHERE created_at >= ?`).bind(Date.now() - 24 * 3600 * 1000).first();
      const read7 = await env.DB.prepare(`SELECT COALESCE(SUM(seconds), 0) AS s FROM cerpen_read_sessions WHERE started_at >= ?`).bind(Date.now() - 7 * 24 * 3600 * 1000).first();
      return { users: Number(users?.c) || 0, online: Number(online?.c) || 0, bans: Number(bans?.c) || 0, watching: Number(watching?.c) || 0, pending: Number(pendingCmds?.c) || 0, revoked: Number(revoked?.c) || 0, det24: Number(det24?.c) || 0, hours7: Math.floor((Number(read7?.s) || 0) / 3600) };
    } catch (e) { return { users: 0, online: 0, bans: 0, watching: 0, pending: 0, revoked: 0, det24: 0, hours7: 0 }; }
  })();
  const settings = await getDetectSettings(env);
  const liveRows = await env.DB.prepare(`SELECT owner_key, user_id, device_id, device_model, last_seen, current_kind, current_target, current_season, current_no, reading_since FROM cerpen_track_users WHERE last_seen >= ? ORDER BY last_seen DESC LIMIT 20`).bind(Date.now() - 5 * 60 * 1000).all();
  const users = await env.DB.prepare(`SELECT id, username FROM cms_users`).all();
  const nameMap = new Map((users.results || []).map(u => [u.id, u.username]));
  const liveHtml = (liveRows.results || []).map(r => {
    const mins = r.reading_since ? Math.max(0, Math.floor((Date.now() - Number(r.reading_since)) / 60000)) : 0;
    return `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(r.user_id ? (nameMap.get(r.user_id) || r.user_id) : 'guest')}</span><div class="adm-row-meta">${esc(r.device_model || '')} · ${r.current_target ? esc(r.current_kind + ':' + r.current_target + ' S' + r.current_season + 'E' + r.current_no) + ' · ' + mins + ' menit' : 'tidak sedang membaca'}</div></div><button type="button" data-track-user="${esc(r.owner_key)}">Detail</button></div>`;
  }).join('') || '<p>Tidak ada yang online.</p>';
  const watchRows = await env.DB.prepare(`SELECT id, subject_type, subject_id, owner_key, reason, evidence, score, status, created_at, updated_at FROM cerpen_watchlist WHERE status = 'watching' ORDER BY updated_at DESC LIMIT 20`).all();
  const watchHtml = (watchRows.results || []).map(w => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">⚠ ${esc(w.subject_type)}:${esc(String(w.subject_id).slice(0, 20))} · skor ${w.score}</span><div class="adm-row-meta">${esc(w.reason)}${w.evidence ? ' · ' + esc(String(w.evidence).slice(0, 160)) : ''} · ${wib(w.updated_at)}</div></div><button type="button" data-track-wl="${esc(w.id)}" data-act="cleared">Bersihkan</button> <button type="button" data-track-wl="${esc(w.id)}" data-act="not_same_person">Bukan orang yang sama</button> <button type="button" data-track-wl="${esc(w.id)}" data-act="banned" style="background:#dc2626">Ban</button></div>`).join('') || '<p>Tidak ada yang dipantau.</p>';
  const banRows = await env.DB.prepare(`SELECT id, target_type, target_id, reason, banned_by, created_at, expires_at, active FROM cerpen_bans WHERE active = 1 ORDER BY created_at DESC LIMIT 20`).all();
  const banHtml = (banRows.results || []).map(b => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">🚫 ${esc(b.target_type)}:${esc(b.target_type === 'user' ? (nameMap.get(b.target_id) || b.target_id) : String(b.target_id).slice(0, 20))}</span><div class="adm-row-meta">${esc(b.reason)} · sejak ${wib(b.created_at)} · ${b.expires_at ? 'sampai ' + wib(Number(b.expires_at) * 1000) : 'PERMANEN'}${b.banned_by && b.banned_by !== 'admin' ? ' · oleh ' + esc(b.banned_by) : ''}</div></div><button type="button" data-track-unban="${esc(b.id)}">Unban</button></div>`).join('') || '<p>Tidak ada ban aktif.</p>';
  const detRows = await env.DB.prepare(`SELECT id, kind, owner_key, device_id, user_id, detail, score, created_at FROM cerpen_detection_events ORDER BY created_at DESC LIMIT 20`).all();
  const detHtml = (detRows.results || []).map(d => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(d.kind)} (+${d.score})</span><div class="adm-row-meta">${esc(d.owner_key || d.device_id || '')} · ${esc(d.detail || '')} · ${wib(d.created_at)}</div></div></div>`).join('') || '<p>Belum ada kejadian deteksi.</p>';
  return `<h2>Pantau Cerpen</h2>${nav}${notice}<div id="track-msg"></div>
<div class="card"><h3>Ringkasan</h3><div class="adm-stats">
<div class="adm-stat"><span class="adm-stat-num">${ov.users}</span><span class="adm-stat-label">Pengguna terlacak</span></div>
<div class="adm-stat"><span class="adm-stat-num">${ov.online}</span><span class="adm-stat-label">Online (5 mnt)</span></div>
<div class="adm-stat"><span class="adm-stat-num">${ov.bans}</span><span class="adm-stat-label">Ban aktif</span></div>
<div class="adm-stat"><span class="adm-stat-num">${ov.watching}</span><span class="adm-stat-label">Dipantau</span></div>
<div class="adm-stat"><span class="adm-stat-num">${ov.pending}</span><span class="adm-stat-label">Perintah pending</span></div>
<div class="adm-stat"><span class="adm-stat-num">${ov.revoked}</span><span class="adm-stat-label">Kunci dicabut</span></div>
<div class="adm-stat"><span class="adm-stat-num">${ov.det24}</span><span class="adm-stat-label">Deteksi 24 jam</span></div>
<div class="adm-stat"><span class="adm-stat-num">${ov.hours7}</span><span class="adm-stat-label">Jam baca 7 hari</span></div>
</div></div>
<div class="card"><h3>Live — siapa online</h3><div id="track-live">${liveHtml}</div></div>
<div class="card"><h3>Pengguna</h3><form id="track-user-search" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><label style="margin:0">Cari<input name="q" maxlength="64" placeholder="owner_key / device_id / user_id"></label><button type="submit">Cari</button></form><div id="track-users"><p>Gunakan pencarian di atas, atau buka Detail dari daftar Live.</p></div></div>
<div class="card" id="track-user-detail" hidden><h3>Detail pengguna</h3><div id="track-user-detail-body"><p>Pilih tombol Detail pada salah satu pengguna.</p></div></div>
<div class="card"><h3>Watchlist (dipantau)</h3><p style="font-size:13px;opacity:.7">Entri dibuat otomatis oleh deteksi (skor ≥ ${settings.watchScore}) atau pencocokan pola perilaku (≥ ${settings.behaviorMatch}%). "Bukan orang yang sama" menghentikan pencocokan perilaku untuk subjek itu.</p><div id="track-watchlist">${watchHtml}</div></div>
<div class="card"><h3>Ban</h3><p style="font-size:13px;opacity:.7">Ban berlaku di semua endpoint + kunci API dicabut otomatis. Ban perangkat juga membanned fingerprint-nya (kecuali emulator). Unban memulihkan kunci yang dicabut oleh ban itu.</p><form id="track-ban-form"><label>Target<select name="target_type"><option value="user">Akun (user)</option><option value="device">Perangkat (device_id)</option><option value="fingerprint">Fingerprint (hash 64 hex)</option></select></label><label>ID target<input name="target_id" required maxlength="64" placeholder="u-... / device UUID / hash fingerprint"></label><label>Alasan (wajib)<input name="reason" required maxlength="500"></label><label>Sampai (kosong = permanen)<input name="expires_at" type="datetime-local"></label><p><button type="submit" style="background:#dc2626">Ban</button></p></form><h4>Ban aktif</h4><div id="track-bans">${banHtml}</div></div>
<div class="card"><h3>Perintah paksa</h3><p style="font-size:13px;opacity:.7">Kick = aplikasi menutup bacaan + tampil layar banned. Crash = aplikasi menghentikan prosesnya sendiri. Dieksekusi saat heartbeat berikutnya dari perangkat target.</p><form id="track-cmd-form"><label>Target (owner_key)<input name="owner_key" required maxlength="64" placeholder="user:u-... / device:uuid"></label><label>Perintah<select name="kind"><option value="kick">Kick paksa</option><option value="crash">Crash paksa</option></select></label><label>Catatan<input name="note" maxlength="500"></label><p><button type="submit" style="background:#dc2626">Kirim Perintah</button></p></form><div id="track-commands"></div></div>
<div class="card"><h3>Redeem — log penukaran kode</h3><div id="track-redeems"><p>Memuat…</p></div></div>
<div class="card"><h3>Log deteksi</h3>${detHtml}</div>
<div class="card"><h3>Ambang deteksi</h3><form id="track-settings-form"><label>Deteksi aktif<select name="enabled"><option value="1"${settings.enabled ? ' selected' : ''}>Aktif</option><option value="0"${settings.enabled ? '' : ' selected'}>Mati</option></select></label><label>Skor masuk watchlist (0–100)<input name="watch_score" type="number" min="0" max="100" value="${settings.watchScore}" required></label><label>Skor auto-ban (0–100)<input name="auto_ban_score" type="number" min="0" max="100" value="${settings.autoBanScore}" required></label><label>Kemiripan perilaku masuk pantau (%)<input name="behavior_match" type="number" min="0" max="100" value="${settings.behaviorMatch}" required></label><label>Kemiripan perilaku auto-ban (%)<input name="behavior_ban" type="number" min="0" max="100" value="${settings.behaviorBan}" required></label><p><button type="submit">Simpan Ambang</button></p><p style="font-size:13px;opacity:.7">Root sendirian dan integritas gagal sendirian TIDAK PERNAH menaikkan skor atau memicu auto-ban — aturan keras. Play Integrity server: <b>${env.PLAY_INTEGRITY_SERVICE_ACCOUNT ? 'secret sudah diset' : 'belum diset — sinyal integritas tercatat "belum terverifikasi"'}</b>.</p></form></div>
<div style="height:110px" aria-hidden="true"></div>
<script>
const TRACK_CSRF = "${csrf}";
const trackMsg = document.getElementById('track-msg');
function trackEsc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function trackSay(t) { trackMsg.innerHTML = '<div class="card"><p>' + trackEsc(t) + '</p></div>'; trackMsg.scrollIntoView(); }
async function trackFetch(url, method, body) {
  const res = await fetch(url, { method: method, headers: { 'x-csrf': TRACK_CSRF, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (!res.ok || j.ok === false) throw new Error(j.error || ('gagal (' + res.status + ')'));
  return j;
}
function trackDtLocal(v) { if (!v) return null; const t = Date.parse(v); return Number.isNaN(t) ? null : Math.floor(t / 1000); }
document.getElementById('track-user-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = new FormData(e.target).get('q') || '';
  try {
    const j = await trackFetch('/api/admin/cerpen-track/users?q=' + encodeURIComponent(q) + '&limit=20', 'GET');
    document.getElementById('track-users').innerHTML = j.users.map(u => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + (trackEsc(u.username) || 'guest') + '</span><div class="adm-row-meta">' + trackEsc(u.owner_key) + ' · ' + (trackEsc(u.device_model) || '') + ' · ' + (trackEsc(u.app_version) || '') + (u.banned ? ' · 🚫 dibanned' : '') + (u.is_rooted ? ' · ROOT' : '') + (u.is_emulator ? ' · EMULATOR' : '') + (u.integrity_status && u.integrity_status !== 'unknown' ? ' · integritas: ' + trackEsc(u.integrity_status) : '') + '</div></div><button type="button" data-track-user="' + trackEsc(u.owner_key) + '">Detail</button></div>').join('') || '<p>Tidak ada pengguna.</p>';
  } catch (err) { trackSay(err.message); }
});
document.getElementById('track-ban-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const j = await trackFetch('/api/admin/cerpen-track/bans', 'POST', { target_type: String(f.get('target_type') || 'user'), target_id: String(f.get('target_id') || '').trim(), reason: String(f.get('reason') || '').trim(), expires_at: trackDtLocal(f.get('expires_at')) });
    trackSay('Ban dibuat: ' + j.target_type + ':' + j.target_id + '. Muat ulang halaman untuk melihat daftar.', true);
  } catch (err) { trackSay(err.message); }
});
document.getElementById('track-cmd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const j = await trackFetch('/api/admin/cerpen-track/commands', 'POST', { owner_key: String(f.get('owner_key') || '').trim(), kind: String(f.get('kind') || 'kick'), note: String(f.get('note') || '') });
    trackSay('Perintah ' + j.kind + ' diantrekan untuk ' + j.owner_key + ' — dieksekusi saat heartbeat berikutnya.', true);
  } catch (err) { trackSay(err.message); }
});
document.getElementById('track-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await trackFetch('/api/admin/cerpen-track/settings', 'POST', { enabled: parseInt(f.get('enabled'), 10), watch_score: parseInt(f.get('watch_score'), 10), auto_ban_score: parseInt(f.get('auto_ban_score'), 10), behavior_match: parseInt(f.get('behavior_match'), 10), behavior_ban: parseInt(f.get('behavior_ban'), 10) });
    trackSay('Ambang deteksi disimpan.', true);
  } catch (err) { trackSay(err.message); }
});
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-track-user],[data-track-unban],[data-track-wl]');
  if (!t) return;
  try {
    if (t.hasAttribute('data-track-user')) {
      const j = await trackFetch('/api/admin/cerpen-track/users/' + encodeURIComponent(t.getAttribute('data-track-user')), 'GET');
      const u = j.user;
      const flags = [];
      if (u.is_rooted) flags.push('ROOT' + (u.root_methods ? ' (' + trackEsc(u.root_methods) + ')' : ''));
      if (u.is_emulator) flags.push('EMULATOR' + (u.emulator_signals ? ' (' + trackEsc(u.emulator_signals) + ')' : ''));
      if (u.bootloader_locked === 0) flags.push('bootloader tidak terkunci');
      if (u.custom_rom) flags.push('custom ROM');
      flags.push('integritas: ' + trackEsc(u.integrity_status || 'unknown') + (u.integrity_verified ? ' (terverifikasi server)' : ''));
      document.getElementById('track-user-detail-body').innerHTML = '<p><b>' + (trackEsc(u.username) || 'guest') + '</b> · ' + trackEsc(u.owner_key) + ' · ' + trackEsc(u.device_model || '') + ' · app ' + trackEsc(u.app_version || '') + '</p>'
        + '<p>Flag: ' + (flags.join(' · ') || 'tidak ada') + ' · fingerprint: <code>' + trackEsc(u.fingerprint_prefix || '') + '…</code></p>'
        + '<p>Profil perilaku: ' + j.profile.total_sessions + ' sesi · rata-rata ' + Math.round(j.profile.avg_session_seconds) + ' detik · series teratas: ' + trackEsc(j.profile.series_top.join(', ') || '-') + '</p>'
        + '<h4>Sesi baca terakhir</h4>' + (j.sessions.map(s => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + trackEsc(s.kind) + ':' + trackEsc(s.target_id) + ' S' + s.season + 'E' + s.no + '</span><div class="adm-row-meta">' + Math.floor((s.seconds || 0) / 60) + ' menit · ' + new Date(s.started_at).toLocaleString('id-ID') + '</div></div></div>').join('') || '<p>Belum ada sesi.</p>')
        + '<h4>Perintah</h4>' + (j.commands.map(c => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + trackEsc(c.kind) + ' · ' + trackEsc(c.status) + '</span><div class="adm-row-meta">' + trackEsc(c.note || '') + '</div></div></div>').join('') || '<p>Belum ada perintah.</p>')
        + '<h4>Ban</h4>' + (j.bans.map(b => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + trackEsc(b.target_type) + ': ' + trackEsc(b.reason) + '</span><div class="adm-row-meta">' + (b.active ? 'AKTIF' : 'dicabut') + '</div></div></div>').join('') || '<p>Belum pernah dibanned.</p>')
        + '<h4>Penukaran kode</h4>' + (j.redemptions.map(r => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + trackEsc(r.batch_id) + ' · ' + trackEsc(r.code_prefix) + '…</span><div class="adm-row-meta">' + new Date(r.created_at).toLocaleString('id-ID') + '</div></div></div>').join('') || '<p>Belum ada penukaran.</p>')
        + '<h4>Kunci API</h4>' + (j.api_keys.map(k => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + trackEsc(k.key_id) + ' · ' + trackEsc(k.status) + '</span><div class="adm-row-meta">' + trackEsc(k.revoke_reason || '') + '</div></div></div>').join('') || '<p>Belum ada kunci.</p>');
      document.getElementById('track-user-detail').hidden = false;
      document.getElementById('track-user-detail').scrollIntoView({ block: 'start' });
    }
    if (t.hasAttribute('data-track-unban')) {
      const note = prompt('Catatan unban (opsional):') || '';
      await trackFetch('/api/admin/cerpen-track/bans/' + encodeURIComponent(t.getAttribute('data-track-unban')) + '/unban', 'POST', { note });
      trackSay('Ban dicabut (kunci yang dicabut oleh ban itu dipulihkan). Muat ulang halaman.', true);
    }
    if (t.hasAttribute('data-track-wl')) {
      const act = t.getAttribute('data-act');
      const note = act === 'banned' ? (prompt('Alasan ban (wajib bila ban dari watchlist):') || '') : (prompt('Catatan tinjauan (opsional):') || '');
      if (act === 'banned' && !note) return;
      await trackFetch('/api/admin/cerpen-track/watchlist/' + encodeURIComponent(t.getAttribute('data-track-wl')) + '/review', 'POST', { status: act, note });
      trackSay('Watchlist ditinjau: ' + act + '. Muat ulang halaman.', true);
    }
  } catch (err) { trackSay(err.message); }
});
(async () => {
  try {
    const j = await trackFetch('/api/admin/cerpen-track/redeems?limit=20', 'GET');
    document.getElementById('track-redeems').innerHTML = j.redeems.map(r => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + (trackEsc(r.username) || 'guest') + ' · ' + trackEsc(r.code_prefix) + '…</span><div class="adm-row-meta">' + trackEsc(r.reward || '') + ' · batch ' + trackEsc(r.batch_id) + ' · ' + new Date(r.created_at).toLocaleString('id-ID') + '</div></div></div>').join('') || '<p>Belum ada penukaran.</p>';
  } catch (err) { document.getElementById('track-redeems').innerHTML = '<p>Gagal memuat log redeem.</p>'; }
  try {
    const j = await trackFetch('/api/admin/cerpen-track/commands?status=pending&limit=10', 'GET');
    document.getElementById('track-commands').innerHTML = '<h4>Pending</h4>' + j.commands.map(c => '<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">' + trackEsc(c.kind) + ' → ' + trackEsc(c.owner_key) + '</span><div class="adm-row-meta">' + trackEsc(c.note || '') + '</div></div><button type="button" data-track-cmd-cancel="' + trackEsc(c.id) + '">Batalkan</button></div>').join('') || '<p>Tidak ada perintah pending.</p>';
    document.querySelectorAll('[data-track-cmd-cancel]').forEach(btn => btn.addEventListener('click', async () => {
      try { await trackFetch('/api/admin/cerpen-track/commands/' + encodeURIComponent(btn.getAttribute('data-track-cmd-cancel')) + '/cancel', 'POST', {}); trackSay('Perintah dibatalkan.', true); } catch (err) { trackSay(err.message); }
    }));
  } catch (err) { /* daftar perintah gagal dimuat — panel tetap jalan */ }
})();
</script>`;
}
