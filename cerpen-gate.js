// ---- Gerbang versi + anti-bypass aplikasi Cerpen Hozin (v1.1.38) ----
// Dipindah dari worker.js (16 Nov 2026) supaya SATU sumber kebenaran ini
// bisa dipakai worker.js DAN modul coins.js / social.js (gerbang jalan
// SETELAH auth di endpoint berakun, SEBELUM logika bisnis).
// Aturan yang ditegakkan di sini (perintah user 13 + 16 Nov 2026):
//  - versi di bawah CERPEN_MIN_VERSION -> 426 (blokir total, tanpa tenggang);
//  - signer tidak dikenal / hilang -> 426;
//  - percobaan bypass berulang -> beku total 24 jam (perangkat + IP).
// Batas jujur: header versi/signer BISA dipalsu siapa pun yang membaca
// SHA signer dari APK publik — gerbang ini menghentikan versi lama +
// peretas kasual, BUKAN pengekstrak kunci konten yang tekun (itu urusan
// key lease + Play Integrity di desain v88, belum dibangun).
import { clientIp } from './util.js';

// ---- Rilis Cerpen Hozin (v87.4, 14 Nov 2026) ----
// AKAR BASI: /api/cerpen-version dulu HANYA membaca baris key='latest'
// tabel cerpen_version di stopwatch-db, yang di-seed SEKALI oleh
// migrate_cerpen_images.py (v1.1.28, 13 Nov 09:11) dan tak pernah
// diperbarui — rilis v1.1.29..v1.1.31 tak pernah sampai ke endpoint,
// aplikasi 1.1.30.3 pun menyimpulkan "sudah versi terbaru".
// PERBAIKAN: sumber utama = GitHub Releases API repo PUBLIK (tanpa
// token — JANGAN andalkan GITHUB_PAT_READ, diketahui tak valid sejak
// v84). Cache in-memory 5 menit supaya tidak menghantam rate limit
// GitHub (60/jam tanpa auth, per IP egress). Bila GitHub gagal,
// fallback ke baris D1 'latest' — DAN baris itu diperbarui setiap kali
// fetch live berhasil menemukan rilis lebih baru, supaya fallback
// tidak pernah basi lagi.
export const CERPEN_GH_REPO = 'hozin-king/cerpen-hozin';
const CERPEN_RELEASES_CACHE_MS = 5 * 60 * 1000;
// SHA-256 sidik jari sertifikat penandatangan APK resmi Cerpen
// (dibuktikan dari APK v1.1.31: 75ba028f…a01c1d; sama di semua rilis
// sejak v1.1.29 — keystore debug persisten di repo). Hanya berubah
// bila keystore ganti (saat itu perbarui daftar ini + deploy).
export const CERPEN_KNOWN_SIGNER_SHAS = ['75ba028f4f9b401b3f414a2b9e63617fa35b503c692c5f6c188e3724a7a01c1d'];
let cerpenReleaseCache = { at: 0, data: null };

function cerpenPickApkAsset(assets) {
  if (!Array.isArray(assets)) return null;
  let fallback = null;
  let fallbackSize = -1;
  for (const a of assets) {
    if (!a || typeof a.name !== 'string' || !a.name.toLowerCase().endsWith('.apk')) continue;
    if (typeof a.browser_download_url !== 'string' || !a.browser_download_url) continue;
    if (a.name.includes('CerpenHozin')) return a;
    if (typeof a.size === 'number' && a.size > fallbackSize) { fallbackSize = a.size; fallback = a; }
  }
  return fallback;
}

// Banding semver numerik per segmen ('1.1.30.3' vs '1.1.31'): -1/0/1.
export function cmpSemver(a, b) {
  const pa = String(a).split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Ambil versi dari string bebas ('v1.1.31', '1.1.31 (code 36)'): null bila tak ada angka.
export function parseAppVersion(v) {
  const m = String(v || '').match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

// Ambil info rilis dari GitHub (cache 5 menit). {data, source} atau {error}.
// Jalur 1: Releases API (data lengkap). Jalur 2 (bila API gagal —
// terbukti kena rate limit dari IP egress Worker): git refs + halaman
// tag. Keduanya menyegarkan baris fallback D1.
async function fetchCerpenReleases(env) {
  const now = Date.now();
  if (cerpenReleaseCache.data && now - cerpenReleaseCache.at < CERPEN_RELEASES_CACHE_MS) {
    return { data: cerpenReleaseCache.data, source: cerpenReleaseCache.source || 'github' };
  }
  let list = null;
  try {
    const res = await fetch('https://api.github.com/repos/' + CERPEN_GH_REPO + '/releases?per_page=10', { headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'hozin-cms-cerpen-version/1.0' }, cf: { cacheTtl: 0 } });
    if (res.ok) list = await res.json();
  } catch (e) { /* jatuh ke jalur refs */ }
  if (Array.isArray(list)) {
    const pub = list.filter(r => r && !r.draft && !r.prerelease && typeof r.tag_name === 'string' && r.tag_name);
    if (pub.length) {
      const latest = pub[0];
      const apk = cerpenPickApkAsset(latest.assets);
      const version = String(latest.tag_name).replace(/^v/i, '');
      if (parseAppVersion(version)) {
        const data = {
          tag: latest.tag_name,
          version,
          apk_url: apk ? apk.browser_download_url : null,
          apk_name: apk ? apk.name : null,
          published_at: typeof latest.published_at === 'string' ? latest.published_at : null,
          tags: pub.map(r => r.tag_name),
        };
        cerpenReleaseCache = { at: now, data, source: 'github' };
        await refreshCerpenVersionRow(env, data);
        return { data, source: 'github' };
      }
    }
  }
  const refs = await fetchCerpenReleasesViaRefs(env);
  if (refs.data) {
    cerpenReleaseCache = { at: now, data: refs.data, source: 'github-refs' };
    await refreshCerpenVersionRow(env, refs.data);
    return { data: refs.data, source: 'github-refs' };
  }
  const jd = await fetchCerpenReleasesViaJsdelivr(env);
  if (jd.data) {
    cerpenReleaseCache = { at: now, data: jd.data, source: 'jsdelivr' };
    await refreshCerpenVersionRow(env, jd.data);
    return { data: jd.data, source: 'jsdelivr' };
  }
  return { error: 'github' };
}

// Segarkan baris fallback D1 (bila berubah): published_at dipertahankan
// dari baris lama bila sumber live tak memberikannya untuk tag yang sama;
// bila tag baru tanpa tanggal, simpan '' (jujur "tak diketahui").
async function refreshCerpenVersionRow(env, data) {
  try {
    if (!env.BACKUP_DB) return;
    const cur = await env.BACKUP_DB.prepare(`SELECT tag, version, apk_url, published_at FROM cerpen_version WHERE key = ?`).bind('latest').first();
    if (cur && cur.tag === data.tag && cur.version === data.version && cur.apk_url === data.apk_url) return; // sudah segar
    const pub = data.published_at || (cur && cur.tag === data.tag ? cur.published_at : '') || '';
    const upd = await env.BACKUP_DB.prepare(`UPDATE cerpen_version SET tag = ?, version = ?, apk_url = ?, published_at = ? WHERE key = ?`).bind(data.tag, data.version, data.apk_url || '', pub, 'latest').run();
    if (!upd || !upd.meta || Number(upd.meta.changes) !== 1) {
      await env.BACKUP_DB.prepare(`INSERT INTO cerpen_version (key, tag, version, apk_url, published_at) VALUES (?, ?, ?, ?, ?)`).bind('latest', data.tag, data.version, data.apk_url || '', pub).run();
    }
  } catch (e) { /* gagal tulis D1: live tetap jalan, fallback tetap basi — dicoba lagi di fetch berikut */ }
}

// Jalur live KEDUA (14 Nov 2026, setelah api.github.com terbukti kena
// rate limit dari IP egress Worker — 5× berturut-turut source d1):
// git smart-HTTP info/refs (github.com, BUKAN api.github.com — tanpa
// kuota API) untuk daftar tag + tag terbaru, lalu halaman rilis tag
// untuk published_at (datetime pertama). apk_url dirangkai dari pola
// nama aset yang konsisten di semua rilis (CerpenHozin-<tag>.apk,
// terverifikasi sampai v1.1.31.1). Hanya tag versi numerik murni yang
// dihitung (bukan tag beta/draf). published_at null bila halaman tag
// tak terbaca — versi + apk_url + tags tetap benar.
async function fetchCerpenReleasesViaRefs(env) {
  let refsText;
  try {
    const res = await fetch('https://github.com/' + CERPEN_GH_REPO + '.git/info/refs?service=git-upload-pack', { headers: { 'user-agent': 'hozin-cms-cerpen-version/1.0' }, cf: { cacheTtl: 0 } });
    if (!res.ok) return { error: 'github' };
    refsText = await res.text();
  } catch (e) {
    return { error: 'github' };
  }
  const tags = [...new Set([...String(refsText || '').matchAll(/refs\/tags\/(v[0-9][0-9A-Za-z.\-]*)/g)].map(m => m[1]))]
    .filter(t => /^v\d+(\.\d+)*$/.test(t) && parseAppVersion(t))
    .sort((a, b) => cmpSemver(parseAppVersion(b), parseAppVersion(a)));
  if (!tags.length) return { error: 'github' };
  const tag = tags[0];
  const version = parseAppVersion(tag);
  let publishedAt = null;
  try {
    const res = await fetch('https://github.com/' + CERPEN_GH_REPO + '/releases/tag/' + tag, { headers: { 'user-agent': 'Mozilla/5.0' }, cf: { cacheTtl: 0 } });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/datetime="([^"]+)"/);
      if (m) publishedAt = m[1];
    }
  } catch (e) { /* published_at tetap null */ }
  return {
    data: {
      tag,
      version,
      apk_url: 'https://github.com/' + CERPEN_GH_REPO + '/releases/download/' + tag + '/CerpenHozin-' + tag + '.apk',
      apk_name: 'CerpenHozin-' + tag + '.apk',
      published_at: publishedAt,
      tags,
    },
  };
}

// Jalur live KETIGA (14 Nov 2026): api.github.com DAN github.com
// sama-sama gagal dari egress Worker (source tetap d1 setelah deploy
// refs) — jsDelivr adalah CDN publik tanpa kuota API. data.jsdelivr
// mengembalikan daftar versi tag (tanpa awalan 'v', terbaru dulu).
// published_at dicoba dari halaman tag GitHub (bila ikut gagal, null —
// refreshCerpenVersionRow mempertahankan tanggal lama untuk tag yang
// sama, '' untuk tag baru).
async function fetchCerpenReleasesViaJsdelivr(env) {
  let list;
  try {
    const res = await fetch('https://data.jsdelivr.com/v1/package/gh/' + CERPEN_GH_REPO, { headers: { 'user-agent': 'hozin-cms-cerpen-version/1.0' }, cf: { cacheTtl: 0 } });
    if (!res.ok) return { error: 'github' };
    list = await res.json();
  } catch (e) {
    return { error: 'github' };
  }
  const versions = Array.isArray(list && list.versions) ? list.versions : [];
  const tags = [...new Set(versions.map(v => 'v' + String(v)))]
    .filter(t => /^v\d+(\.\d+)*$/.test(t) && parseAppVersion(t))
    .sort((a, b) => cmpSemver(parseAppVersion(b), parseAppVersion(a)));
  if (!tags.length) return { error: 'github' };
  const tag = tags[0];
  const version = parseAppVersion(tag);
  let publishedAt = null;
  try {
    const res = await fetch('https://github.com/' + CERPEN_GH_REPO + '/releases/tag/' + tag, { headers: { 'user-agent': 'Mozilla/5.0' }, cf: { cacheTtl: 0 } });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/datetime="([^"]+)"/);
      if (m) publishedAt = m[1];
    }
  } catch (e) { /* published_at tetap null */ }
  return {
    data: {
      tag,
      version,
      apk_url: 'https://github.com/' + CERPEN_GH_REPO + '/releases/download/' + tag + '/CerpenHozin-' + tag + '.apk',
      apk_name: 'CerpenHozin-' + tag + '.apk',
      published_at: publishedAt,
      tags,
    },
  };
}

// Info rilis efektif: live (API GitHub, lalu git refs, lalu jsDelivr),
// fallback baris D1, null bila semuanya gagal. Bentuk: {tag, version,
// apk_url, published_at, tags, source: 'github'|'github-refs'|
// 'jsdelivr'|'d1'}.
export async function resolveCerpenRelease(env) {
  const live = await fetchCerpenReleases(env);
  if (live.data) {
    const data = { ...live.data, source: live.source || 'github' };
    // Jalur live tanpa published_at (jsDelivr + halaman tag GitHub ikut
    // gagal): isi dari baris D1 BILA tag-nya sama (tanggal sudah
    // terverifikasi saat backfill) — jangan pakai tanggal tag lain.
    if (!data.published_at && env.BACKUP_DB) {
      try {
        const row = await env.BACKUP_DB.prepare(`SELECT published_at FROM cerpen_version WHERE key = ? AND tag = ?`).bind('latest', data.tag).first();
        if (row && row.published_at) data.published_at = row.published_at;
      } catch (e) { /* published_at tetap null */ }
    }
    return data;
  }
  try {
    if (env.BACKUP_DB) {
      const row = await env.BACKUP_DB.prepare(`SELECT tag, version, apk_url, published_at FROM cerpen_version WHERE key = ?`).bind('latest').first();
      if (row && row.tag) {
        return { tag: row.tag, version: String(row.version || String(row.tag).replace(/^v/i, '')), apk_url: row.apk_url || null, published_at: row.published_at || null, tags: [row.tag], source: 'd1' };
      }
    }
  } catch (e) { /* abaikan, kembalikan null di bawah */ }
  return null;
}

// Penegakan update di jalur sync (v87.4): kembalikan null bila boleh,
// atau {latest, reason} bila HARUS ditolak 426.
// - signer dikirim & tidak cocok daftar dikenal -> tolak (signer_mismatch).
// - versi < latest DAN ada >=3 rilis lebih baru di daftar tags -> tolak
//   (locked_3_behind). Daftar tags lengkap hanya dari sumber live (API
//   GitHub / git refs / jsDelivr); bila sumbernya D1 (semua live gagal,
//   tags=[latest]) jumlah tak bisa dihitung -> izinkan sementara
//   (fail-open, dicoba lagi saat live pulih).
// - versi tak bisa diparse padahal header dikirim -> tolak (version_unknown).
// - versi >= latest -> izinkan. Tanpa header versi+signer SAMA SEKALI ->
//   tolak (version_unknown): sejak v1.1.32 klien resmi SELALU mengirim
//   keduanya, jadi permintaan tanpa identitas tak bisa dibedakan dari
//   percobaan bypass — dan perintah user 16 Nov 2026 menuntut versi di
//   bawah v1.1.39 diblokir TOTAL, bukan lolos lewat ketiadaan header.
// - versi di bawah CERPEN_MIN_VERSION -> tolak (below_minimum), TANPA
//   tenggang, bahkan bila rilis terbaru tak bisa di-resolve (lantai ini
//   tidak bergantung pada jaringan/GitHub).
export const CERPEN_MIN_VERSION = '1.1.39';
// Kode versi minimum yang bersesuaian (dipakai panel/admin; perbandingan
// di gerbang memakai nama versi, bukan kode — klien lama tak mengirim kode).
export const CERPEN_MIN_VERSION_CODE = 45;
export async function checkCerpenAppLock(env, appVersion, appSigner) {
  const rel = await resolveCerpenRelease(env);
  const latest = rel ? rel.tag : null;
  if (!appVersion && !appSigner) return { latest, reason: 'version_unknown' };
  if (appSigner) {
    const norm = String(appSigner).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (norm && !CERPEN_KNOWN_SIGNER_SHAS.includes(norm)) {
      return { latest, reason: 'signer_mismatch' };
    }
  } else if (appVersion) {
    // Versi dikirim tapi signer hilang: klien resmi selalu mengirim
    // keduanya sejak v1.1.32 — ini pola spoof header versi saja.
    return { latest, reason: 'signer_missing' };
  }
  if (!appVersion) return { latest, reason: 'version_unknown' };
  const v = parseAppVersion(appVersion);
  if (!v) return { latest, reason: 'version_unknown' };
  // Lantai minimum (perintah user 16 Nov 2026): di bawah 1.1.39 -> kunci
  // total, tanpa tenggang. Diperiksa SEBELUM rilis terbaru supaya tetap
  // berlaku saat GitHub/jsDelivr/D1 tak bisa dijangkau (fail-open lama
  // dihapus: dulu `!rel -> return null` membuat versi lama lolos).
  if (cmpSemver(v, CERPEN_MIN_VERSION) < 0) return { latest, reason: 'below_minimum' };
  if (!rel) return null; // rilis tak diketahui + versi >= lantai -> fail-open
  if (cmpSemver(v, rel.version) >= 0) return null;
  const newer = (rel.tags || []).filter(t => {
    const tv = parseAppVersion(t);
    return tv && cmpSemver(tv, v) > 0;
  }).length;
  // Daftar tags lengkap hanya dari sumber live (API / git refs); bila
  // sumbernya D1 (semua jalur live gagal, tags=[latest]) jumlah tak bisa
  // dihitung -> izinkan sementara (fail-open, dicoba lagi saat live pulih).
  if ((rel.source === 'github' || rel.source === 'github-refs' || rel.source === 'jsdelivr') && newer >= 3) {
    return { latest: rel.tag, reason: 'locked_3_behind' };
  }
  return null;
}

// ---- Blokir total percobaan bypass (v1.1.38, 16 Nov 2026) ----
// Dua tabel di stopwatch-db (BACKUP_DB) — DDL di cerpen-app-blocks-ddl.sql:
//  - cerpen_lock_attempts: jejak tiap permintaan yang kena 426 (dedup
//    10 detik per kunci+alasan; di-prune berkala, retensi 7 hari).
//  - cerpen_app_blocks: kunci yang dibekukan (device:<device-id> atau
//    ip:<ip>) + alasan + masa berlaku (24 jam) + jumlah pelanggaran.
// Ambang (desain v88 §18.5, disesuaikan ke gerbang versi — user sudah
// menyetujui pola "ambang anomali + beku" di desain itu):
//  - signer_mismatch / signer_missing >= 3 dalam 1 jam -> beku;
//  - version-hopping: >= 5 versi berbeda dalam 1 jam -> beku;
//  - hammering: >= 30 percobaan terkunci dalam 10 menit -> beku.
// Efek beku: 403 app_blocked (bukan 426) + blocked_until. Blok HANYA
// berlaku untuk permintaan yang GAGAL cek versi — begitu klien update
// dan lolos cek versi, blok diabaikan (self-heal; user tidak perlu
// menghubungi admin). Blok bisa dilepas admin via panel (hapus baris).
// DUA batas jujur: (1) SHA signer itu publik — cek header saja tidak
// membuktikan request dari APK resmi; (2) device-id adalah UUID
// per-install yang bisa dibuat ulang — kunci IP ikut dicatat supaya
// ganti device-id saja tidak cukup. Bypass sempurna hanya ditahan
// key lease + Play Integrity (desain v88, belum dibangun).
const BLOCK_TTL_MS = 24 * 3600 * 1000;
const ATTEMPT_WINDOW_MS = 3600 * 1000;
const HAMMER_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_DEDUP_MS = 10 * 1000;
// Batas tulis per request supaya percobaan bypass tidak membanjiri D1
// (satu baris attempt + satu upsert blok, maks).
function cerpenGateKeys(deviceId, ip) {
  const keys = [];
  if (deviceId) keys.push('dev:' + String(deviceId).slice(0, 64));
  if (ip) keys.push('ip:' + ip);
  return keys;
}
async function cerpenRecordLockAttempt(env, keys, appVersion, reason) {
  if (!env.BACKUP_DB || !keys.length) return;
  const now = Date.now();
  const dedupSince = now - ATTEMPT_DEDUP_MS;
  // Dicatat di SEMUA kunci (perangkat + IP): bila hanya kunci pertama
  // yang dicatat, penyerang yang memutar device-id tidak pernah
  // mengakumulasi apa pun di kunci IP dan lolos dari ambang.
  try {
    for (const key of keys) {
      await env.BACKUP_DB.prepare(
        "INSERT INTO cerpen_lock_attempts (subject_key, app_version, reason, created_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM cerpen_lock_attempts WHERE subject_key = ? AND reason = ? AND created_at > ?)"
      ).bind(key, appVersion || '', reason, now, key, reason, dedupSince).run();
    }
  } catch { /* jejak gagal dicatat -> jangan gagalkan permintaan */ }
}
async function cerpenEvaluateBlock(env, keys, appVersion, reason) {
  // Dipanggil SETELAH percobaan dicatat; mengembalikan true bila salah
  // satu kunci kini memenuhi ambang -> blok harus dibuat.
  if (!env.BACKUP_DB || !keys.length) return false;
  const now = Date.now();
  try {
    for (const key of keys) {
      const row = await env.BACKUP_DB.prepare(
        "SELECT COUNT(*) AS n FROM cerpen_lock_attempts WHERE subject_key = ? AND created_at > ?"
      ).bind(key, now - ATTEMPT_WINDOW_MS).first();
      if ((row?.n || 0) >= 30) return true; // hammering dihitung di jendela 1 jam juga
      if (reason === 'signer_mismatch' || reason === 'signer_missing') {
        const sig = await env.BACKUP_DB.prepare(
          "SELECT COUNT(*) AS n FROM cerpen_lock_attempts WHERE subject_key = ? AND reason IN ('signer_mismatch', 'signer_missing') AND created_at > ?"
        ).bind(key, now - ATTEMPT_WINDOW_MS).first();
        if ((sig?.n || 0) >= 3) return true;
      }
      if (reason === 'version_unknown' || reason === 'below_minimum' || reason === 'locked_3_behind') {
        // Hopping = mencoba BANYAK VERSI yang bisa diparse (1.1.28, lalu
        // 1.1.30, lalu 1.1.31...). Versi kosong / tak-terparse ('', 'abc')
        // TIDAK dihitung — itu satu pola yang sama (identitas rusak),
        // bukan hopping, dan sudah ditangani ambang signer/hammering.
        const vers = await env.BACKUP_DB.prepare(
          "SELECT DISTINCT app_version FROM cerpen_lock_attempts WHERE subject_key = ? AND created_at > ?"
        ).bind(key, now - ATTEMPT_WINDOW_MS).all();
        const parseable = new Set((vers.results || []).map(r => r.app_version).filter(v => v && parseAppVersion(String(v))));
        if (parseable.size >= 5) return true;
      }
      const hammer = await env.BACKUP_DB.prepare(
        "SELECT COUNT(*) AS n FROM cerpen_lock_attempts WHERE subject_key = ? AND created_at > ?"
      ).bind(key, now - HAMMER_WINDOW_MS).first();
      if ((hammer?.n || 0) >= 30) return true;
    }
  } catch { return false; }
  return false;
}
async function cerpenCreateBlock(env, keys, reason) {
  if (!env.BACKUP_DB || !keys.length) return;
  const now = Date.now();
  const until = now + BLOCK_TTL_MS;
  try {
    for (const key of keys) {
      await env.BACKUP_DB.prepare(
        "INSERT INTO cerpen_app_blocks (subject_key, reason, blocked_until, violation_count, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(subject_key) DO UPDATE SET reason = excluded.reason, blocked_until = excluded.blocked_until, violation_count = cerpen_app_blocks.violation_count + 1, updated_at = excluded.updated_at"
      ).bind(key, reason, until, now, now).run();
    }
  } catch { /* blok gagal dibuat -> percobaan tetap kena 426 */ }
}
async function cerpenIsBlocked(env, keys) {
  if (!env.BACKUP_DB || !keys.length) return null;
  const now = Date.now();
  try {
    for (const key of keys) {
      const row = await env.BACKUP_DB.prepare(
        "SELECT subject_key, reason, blocked_until FROM cerpen_app_blocks WHERE subject_key = ? AND blocked_until > ?"
      ).bind(key, now).first();
      if (row) return row;
    }
  } catch { return null; }
  return null;
}
function cerpenLockResponse(lock) {
  return new Response(JSON.stringify({
    ok: false,
    error: 'app_update_required',
    reason: lock.reason,
    latest: lock.latest,
    min_version: CERPEN_MIN_VERSION,
  }), { status: 426, headers: { 'content-type': 'application/json' } });
}
// Gerbang bersama untuk SEMUA endpoint aplikasi Cerpen.
// Mengembalikan Response (426/403) bila permintaan harus ditolak, atau
// null bila boleh lanjut. Urutan: lolos cek versi -> IZINKAN (blok lama
// diabaikan = self-heal saat update); gagal + terblokir -> 403;
// gagal + belum terblokir -> 426 + catat percobaan (+ beku bila ambang).
// deviceId diambil dari header X-Device-Id (UUID per-install, dikirim
// klien sejak v1.1.38) — bila kosong, hanya kunci IP yang dipakai.
export async function enforceCerpenAppGate(request, env) {
  const h = request.headers;
  const appVersion = h.get('x-app-version') || '';
  const appSigner = h.get('x-app-signer-sha') || '';
  const deviceId = h.get('x-device-id') || '';
  const ip = clientIp(request, env);
  const lock = await checkCerpenAppLock(env, appVersion, appSigner);
  if (!lock) return null;
  const keys = cerpenGateKeys(deviceId, ip);
  const blocked = await cerpenIsBlocked(env, keys);
  if (blocked) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'app_blocked',
      reason: 'app_blocked',
      blocked_until: blocked.blocked_until,
      blocked_reason: blocked.reason,
      min_version: CERPEN_MIN_VERSION,
    }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  await cerpenRecordLockAttempt(env, keys, appVersion, lock.reason);
  if (await cerpenEvaluateBlock(env, keys, appVersion, lock.reason)) {
    await cerpenCreateBlock(env, keys, lock.reason);
    return new Response(JSON.stringify({
      ok: false,
      error: 'app_blocked',
      reason: 'app_blocked',
      blocked_until: Date.now() + BLOCK_TTL_MS,
      blocked_reason: lock.reason,
      min_version: CERPEN_MIN_VERSION,
    }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  return cerpenLockResponse(lock);
}

// Hook tes: kosongkan cache rilis (dipakai test.mjs antar skenario).
export function resetCerpenReleaseCacheForTest() { cerpenReleaseCache = { at: 0, data: null }; }
