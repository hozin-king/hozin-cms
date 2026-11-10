// Auth WorkerCMS — sesi admin (akses HMAC 1 jam + refresh rotasi),
// akun komentator, kunci post, dan password PBKDF2.
import { hmacHex, parseCookies, b64url, sha256Hex, randomHex, clientIp } from './util.js';

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 24 * 3600 * 1000;
const REFRESH_REMEMBER_TTL_MS = 30 * 24 * 3600 * 1000;

export async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const cookie = parseCookies(request).cms_access || '';
  const [exp, sig] = cookie.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmacHex(env.ADMIN_TOKEN, 'access:' + exp);
}
export function sessionExp(request) {
  const cookie = parseCookies(request).cms_access || '';
  const [exp] = cookie.split('.');
  return exp || '';
}

// CSRF sengaja TIDAK diikat ke masa berlaku token akses: token akses diputar
// tiap jam, dan form dashboard yang sudah dimuat harus tetap sah setelah
// rotasi. Karena hanya ada satu admin, token CSRF tetap yang hanya diketahui
// admin yang login sudah cukup melawan pemalsuan lintas situs.
export async function csrfToken(env) {
  return env.ADMIN_TOKEN ? await hmacHex(env.ADMIN_TOKEN, 'csrf') : '';
}

export function accessCookie(env, exp) {
  return hmacHex(env.ADMIN_TOKEN, 'access:' + exp).then(sig =>
    `cms_access=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ACCESS_TTL_MS / 1000)}`);
}
export async function issueTokens(env, request, remember) {
  const now = Date.now();
  const exp = String(now + ACCESS_TTL_MS);
  const access = await accessCookie(env, exp);
  const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(raw);
  const id = randomHex(12);
  const ttl = remember ? REFRESH_REMEMBER_TTL_MS : REFRESH_TTL_MS;
  const iso = new Date(now).toISOString();
  const expires = new Date(now + ttl).toISOString();
  // device (User-Agent) dan ip HANYA disimpan untuk ditampilkan di halaman
  // Sesi (/kendali/sessions) — keduanya sinyal tampilan saja, TIDAK PERNAH
  // dipakai sebagai bukti identitas perangkat dalam keputusan auth apa pun
  // (keduanya mudah dipalsukan / berubah di tengah jalan).
  const device = (request.headers.get('user-agent') || '').slice(0, 80);
  await env.DB.prepare(`INSERT INTO cms_refresh_tokens (id, token_hash, device, ip, created_at, last_used_at, expires_at, revoked, replaced_by, remember) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?)`).bind(id, hash, device, clientIp(request), iso, iso, expires, remember ? 1 : 0).run();
  const refresh = `cms_refresh=${raw}; Path=/kendali; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}`;
  return [access, refresh];
}
export async function getRefreshRow(request, env) {
  const raw = parseCookies(request).cms_refresh || '';
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  return await env.DB.prepare(`SELECT * FROM cms_refresh_tokens WHERE token_hash = ?`).bind(hash).first();
}
export async function revokeAllRefresh(env) {
  await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1 WHERE revoked = 0`).run();
}
export function setCookieInHeader(header, name, value) {
  const parts = (header || '').split(';').map(p => p.trim()).filter(p => p && !p.startsWith(name + '='));
  parts.push(`${name}=${value}`);
  return parts.join('; ');
}
// Jeda tenggang pemakaian ulang refresh (10 detik): dua request yang
// datang bersamaan dengan token akses kedaluwarsa bisa sama-sama membaca
// token refresh lama sebelum salah satunya memutarnya. Tanpa jeda ini,
// request kedua dianggap pencurian dan mencabut SEMUA sesi (logout massal
// palsu). Dalam jeda ini, token lama yang sudah diputar masih boleh
// dipakai SEKALI untuk memutar token penggantinya (rantai maks 5 lompatan).
// Trade-off: jendela 10 detik melemahkan deteksi reuse di dalam jendela
// itu; di luar jendela, pemakaian ulang tetap dianggap pencurian dan
// mencabut semua sesi seperti sebelumnya.
const REFRESH_REUSE_GRACE_MS = 10 * 1000;

// Putar refresh token. Kembalikan {request, cookies} bila berhasil, null bila
// refresh tidak sah/kedaluwarsa/dicabut. Error D1 dilempar ke fallback 503,
// bukan ditelan, supaya kegagalan database terlihat jelas, bukan login palsu.
export async function tryRefresh(request, env) {
  const raw = parseCookies(request).cms_refresh || '';
  if (!raw || !env.ADMIN_TOKEN) return null;
  let row = await getRefreshRow(request, env);
  if (!row) return null;
  // Ikuti rantai pengganti selama setiap lompatan masih segar (dibuat
  // dalam jeda tenggang) dan belum kedaluwarsa — maks 5 lompatan, supaya
  // tiga request bersamaan pun bisa memutar berurutan tanpa memicu
  // pencabutan massal palsu. Rantai yang putus (pengganti basi /
  // kedaluwarsa / tidak ada) berhenti di token revoked -> pencurian.
  let hops = 0;
  while (row.revoked && row.replaced_by && hops < 5) {
    const next = await env.DB.prepare(`SELECT * FROM cms_refresh_tokens WHERE id = ?`).bind(row.replaced_by).first();
    if (!next) break;
    if (String(next.expires_at) <= new Date().toISOString()) break;
    const age = Date.now() - new Date(String(next.created_at || '')).getTime();
    if (!Number.isFinite(age) || age > REFRESH_REUSE_GRACE_MS) break;
    row = next;
    hops++;
  }
  if (row.revoked) {
    // Refresh yang sudah diputar lalu dipakai lagi = token dicuri (kasus di
    // video: token bocor dipakai penyerang). Cabut semua sesi, paksa login ulang.
    if (row.replaced_by) await revokeAllRefresh(env);
    return null;
  }
  if (String(row.expires_at) <= new Date().toISOString()) {
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
  await env.DB.prepare(`INSERT INTO cms_refresh_tokens (id, token_hash, device, ip, created_at, last_used_at, expires_at, revoked, replaced_by, remember) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?)`).bind(newId, newHash, row.device || '', row.ip || '', iso, iso, expires, row.remember ? 1 : 0).run();
  const access = await accessCookie(env, String(now + ACCESS_TTL_MS));
  const refresh = `cms_refresh=${newRaw}; Path=/kendali; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}`;
  const headers = new Headers(request.headers);
  let cookieHeader = request.headers.get('cookie') || '';
  cookieHeader = setCookieInHeader(cookieHeader, 'cms_access', access.split(';')[0].split('=')[1]);
  cookieHeader = setCookieInHeader(cookieHeader, 'cms_refresh', newRaw);
  headers.set('cookie', cookieHeader);
  return { request: new Request(request, { headers }), cookies: [access, refresh] };
}
export function redirectWithCookies(location, cookies) {
  const headers = new Headers({ location });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 303, headers });
}
export function clearAuthCookies() {
  return [
    'cms_access=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    'cms_refresh=; Path=/kendali; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    'cms_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
  ];
}

// Batas panjang password AKUN KOMENTATOR (bukan admin, bukan password post):
// terlalu pendek gampang ditebak, terlalu panjang membebani PBKDF2 dan
// bisa dipakai membanjiri CPU Worker. Diterapkan di rute daftar/login
// komentator di worker.js, SETELAH cabang admin — login admin memakai
// ADMIN_TOKEN yang panjangnya tidak dibatasi aturan ini.
// Password TIDAK di-trim: spasi di awal/akhir adalah bagian password.
export const COMMENTER_PASSWORD_MIN = 8;
export const COMMENTER_PASSWORD_MAX = 128;
export function isValidCommenterPassword(pw) {
  return typeof pw === 'string' && pw.length >= COMMENTER_PASSWORD_MIN && pw.length <= COMMENTER_PASSWORD_MAX;
}

export async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function verifyPassword(password, saltHex, hashHex) {
  const h = await hashPassword(password, saltHex);
  if (h.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
export async function userCsrf(env, userId) {
  return env.ADMIN_TOKEN ? await hmacHex(env.ADMIN_TOKEN, 'user-csrf:' + userId) : '';
}
export async function getCommenter(request, env) {
  if (!env.ADMIN_TOKEN) return null;
  const cookie = parseCookies(request).cms_user || '';
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  if (!userId || !exp || !sig || Number(exp) < Date.now()) return null;
  if (sig !== await hmacHex(env.ADMIN_TOKEN, 'user:' + userId + ':' + exp)) return null;
  const row = await env.DB.prepare(`SELECT * FROM cms_users WHERE id = ?`).bind(userId).first();
  return row || null;
}
export async function userSessionCookie(env, userId) {
  const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
  const sig = await hmacHex(env.ADMIN_TOKEN, 'user:' + userId + ':' + exp);
  return `cms_user=${userId}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
}
export function unlockCookieName(postId) {
  return 'cms_unlock_' + String(postId).replace(/[^A-Za-z0-9_-]/g, '_');
}
export async function isPostUnlocked(request, env, postId) {
  if (!env.ADMIN_TOKEN) return false;
  const cookie = parseCookies(request)[unlockCookieName(postId)] || '';
  const parts = cookie.split('.');
  if (parts.length !== 2) return false;
  const [exp, sig] = parts;
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === await hmacHex(env.ADMIN_TOKEN, 'post-unlock:' + postId + ':' + exp);
}
export async function postUnlockCookie(env, postId) {
  const exp = String(Date.now() + 24 * 3600 * 1000);
  const sig = await hmacHex(env.ADMIN_TOKEN, 'post-unlock:' + postId + ':' + exp);
  return `${unlockCookieName(postId)}=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${24 * 3600}`;
}
