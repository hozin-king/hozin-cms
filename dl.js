// Link Download + analitik (21 Nov 2026) — subdomain link-dl.hozinking.my.id
// + domain bawaan Cloudflare hozin-cms.muchammadhozin.workers.dev.
// Modul mandiri: redirect /<code> -> target (302) + pencatatan klik di D1,
// dan panel /kendali/dl. Satu-satunya otoritas kode adalah tabel dl_links
// di D1 cms-db (env.DB).
// Batas jujur: "siapa" = alamat IP + user-agent/perangkat, BUKAN nama orang
// — kecuali pengunjung sedang login (user_id terisi). IP hanya tampil di
// panel admin, tidak pernah di halaman publik. Retensi klik 90 hari.
import { esc, clientIp } from './util.js';
import { getCommenter } from './auth.js';
import { ensureSchema } from './store.js';

export const DL_HOST = 'link-dl.hozinking.my.id';
export const DL_WORKERS_DEV_HOST = 'hozin-cms.muchammadhozin.workers.dev';
export const DL_CLICK_RETENTION_DAYS = 90;
export const DL_PRUNE_BATCH = 500;

// Header keamanan untuk semua respons link-dl (koreksi audit 24 Nov 2026:
// sebelumnya hanya content-type + cache-control). CSP disamakan dengan
// halaman utama (util.html) supaya skrip tantangan Cloudflare tetap jalan;
// halaman dl sendiri tidak punya skrip, hanya <style> inline.
export const DL_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// ID acak 7 karakter base62 (huruf+angka) untuk link baru tanpa kode
// kustom (aturan 20:20 — default, bukan slug judul).
export function randomDlCode() {
  const b = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(b, x => B62[x % 62]).join('');
}
const wib = v => { const n = Number(v || 0); const ms = (n > 0 && n < 1e12) ? n * 1000 : n; return new Date(ms + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16); };

export function dlShortUrl(code) { return 'https://' + DL_HOST + '/' + code; }
export function dlShortUrlFor(host, code) { return 'https://' + host + '/' + code; }
export function validDlCode(code) { return CODE_RE.test(code || ''); }

// ---- Status domain link (21 Nov 2026): panel /kendali/dl menampilkan
// AKTIF/NONAKTIF kedua host + link baru otomatis memakai host yang aktif.
// Pengecekan: GET ringan ke root tiap host, timeout 5 dtk; HTTP 2xx =
// aktif, selain itu / timeout / error jaringan = nonaktif. Hasil di-cache
// 60 dtk di memori (per isolate) supaya panel tidak melambat tiap dibuka.
// Bila fetch tidak tersedia sama sekali -> 'unknown' (jangan mengarang
// status). ok bernilai true | false | 'unknown'.
export const DL_HOST_STATUS_CACHE_MS = 60_000;
export const DL_HOST_CHECK_TIMEOUT_MS = 5000;
let dlHostStatusCache = null;
export function resetDlHostStatusCache() { dlHostStatusCache = null; }

async function probeDlHost(host, fetchFn) {
  try {
    const res = await fetchFn('https://' + host + '/', { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(DL_HOST_CHECK_TIMEOUT_MS) });
    return { host, ok: res.status >= 200 && res.status < 300, checkedAt: Date.now() };
  } catch (e) {
    return { host, ok: false, checkedAt: Date.now() };
  }
}

export async function checkDlHostStatus(fetchFn) {
  const fn = fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const now = Date.now();
  if (dlHostStatusCache && now - dlHostStatusCache.at < DL_HOST_STATUS_CACHE_MS) return dlHostStatusCache.status;
  let status;
  if (!fn) {
    status = {
      primary: { host: DL_HOST, ok: 'unknown', checkedAt: now },
      backup: { host: DL_WORKERS_DEV_HOST, ok: 'unknown', checkedAt: now },
    };
  } else {
    const [primary, backup] = await Promise.all([probeDlHost(DL_HOST, fn), probeDlHost(DL_WORKERS_DEV_HOST, fn)]);
    status = { primary, backup };
  }
  dlHostStatusCache = { at: now, status };
  return status;
}

// Host short URL untuk link baru: primer bila aktif, cadangan bila primer
// mati, primer lagi bila keduanya mati (link tetap dibuat + peringatan).
export function pickDlHost(status) {
  if (status && status.primary && status.primary.ok === true) return DL_HOST;
  if (status && status.backup && status.backup.ok === true) return DL_WORKERS_DEV_HOST;
  return DL_HOST;
}

// Catat satu klik. TIDAK PERNAH melempar — gagal catat tidak boleh
// menggagalkan redirect.
export async function logDlClick(env, request, code) {
  try {
    const cf = request.cf || {};
    let userId = '';
    try {
      const c = await getCommenter(request, env);
      if (c && c.id) userId = String(c.id);
    } catch (e) {}
    await env.DB.prepare(
      `INSERT INTO dl_clicks (ts, code, ip, country, city, user_agent, referer, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      Date.now(), code,
      clientIp(request),
      String(cf.country || ''), String(cf.city || ''),
      String(request.headers.get('user-agent') || '').slice(0, 500),
      String(request.headers.get('referer') || '').slice(0, 500),
      userId
    ).run();
    return true;
  } catch (e) { return false; }
}

function dlHtml(title, body) {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6;color:#111}a{color:#2563eb}</style></head><body>${body}</body></html>`;
}

// Handler khusus host link-dl.hozinking.my.id: hanya melayani GET /<code>.
// Pencatatan jalan lewat ctx.waitUntil supaya tidak menghambat redirect;
// tanpa ctx (tes lokal), pencatatan di-await supaya teruji.
export async function handleDlRedirect(request, env, ctx, url) {
  try {
    if (request.method !== 'GET') return new Response('Method tidak diizinkan', { status: 405, headers: { ...DL_SECURITY_HEADERS } });
    await ensureSchema(env);
    const code = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
    if (!code) {
      return new Response(dlHtml('Link Download', `<h1>Link Download</h1><p>Layanan short link unduhan <a href="https://hozinking.my.id/">hozinking.my.id</a>. Buka tautan unduhan dari postingan untuk diarahkan ke file aslinya.</p>`), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...DL_SECURITY_HEADERS } });
    }
    if (!validDlCode(code)) return new Response(dlHtml('Tidak ditemukan', `<h1>Link tidak ditemukan</h1><p>Kode tautan tidak dikenal. <a href="https://hozinking.my.id/">Kembali ke hozinking.my.id</a></p>`), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...DL_SECURITY_HEADERS } });
    const link = await env.DB.prepare(`SELECT target_url FROM dl_links WHERE code = ? AND active = 1`).bind(code).first();
    if (!link || !link.target_url) return new Response(dlHtml('Tidak ditemukan', `<h1>Link tidak ditemukan</h1><p>Kode tautan tidak dikenal atau sudah nonaktif. <a href="https://hozinking.my.id/">Kembali ke hozinking.my.id</a></p>`), { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...DL_SECURITY_HEADERS } });
    const p = logDlClick(env, request, code);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    else await p;
    return new Response(null, { status: 302, headers: { location: link.target_url, 'cache-control': 'no-store', ...DL_SECURITY_HEADERS } });
  } catch (e) {
    return new Response('Layanan sedang bermasalah, coba lagi sebentar lagi.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...DL_SECURITY_HEADERS } });
  }
}

// ---- Host backup workers.dev: HANYA layani kode dl yang dikenal + aktif.
// Yang lain (root, /s/<token>, /api/..., halaman biasa, kode tak dikenal)
// mengembalikan null supaya handleFetch lanjut ke handler normal — host ini
// sudah dipakai sebagai host backup fitur share + halaman biasa (tes
// test.mjs "share: create/landing via workers.dev"), jadi TIDAK BOLEH
// membajak semua path seperti host link-dl.
export async function tryDlRedirect(request, env, ctx, url) {
  if (request.method !== 'GET') return null;
  const code = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
  if (!code || code.includes('/') || !validDlCode(code)) return null;
  try {
    await ensureSchema(env);
    const link = await env.DB.prepare(`SELECT target_url FROM dl_links WHERE code = ? AND active = 1`).bind(code).first();
    if (!link || !link.target_url) return null;
    const p = logDlClick(env, request, code);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    else await p;
    return new Response(null, { status: 302, headers: { location: link.target_url, 'cache-control': 'no-store', ...DL_SECURITY_HEADERS } });
  } catch (e) { return null; }
}

// ---- Admin: buat link baru (dipanggil dari POST /kendali/dl/create) ----
export async function handleDlCreate(env, form) {
  const target = String(form.get('target_url') || '').trim().slice(0, 2000);
  if (!/^https?:\/\/[^\s"'<>]+$/.test(target)) return { ok: false };
  let code = String(form.get('code') || '').trim().toLowerCase().slice(0, 64);
  const autoCode = !code;
  if (autoCode) code = randomDlCode();
  if (!validDlCode(code)) return { ok: false };
  const title = String(form.get('title') || '').trim().slice(0, 200);
  const postId = String(form.get('post_id') || '').trim().slice(0, 40);
  // Bentrok kode: kode kustom tambah -2, -3, ... (maks 9 percobaan);
  // kode acak diganti dengan ID acak baru. Lalu gagal jujur.
  let finalCode = code;
  for (let i = 2; i <= 10; i++) {
    const clash = await env.DB.prepare(`SELECT code FROM dl_links WHERE code = ?`).bind(finalCode).first();
    if (!clash) break;
    if (i === 10) return { ok: false };
    finalCode = autoCode ? randomDlCode() : code + '-' + i;
    if (!validDlCode(finalCode)) return { ok: false };
  }
  await env.DB.prepare(`INSERT INTO dl_links (code, target_url, title, post_id, created_at, active) VALUES (?, ?, ?, ?, ?, 1)`).bind(finalCode, target, title, postId, Date.now()).run();
  return { ok: true, code: finalCode };
}

// ---- Admin: aktif/nonaktif link (dipanggil dari POST /kendali/dl/toggle) ----
export async function handleDlToggle(env, form) {
  const code = String(form.get('code') || '').trim().slice(0, 64);
  if (!validDlCode(code)) return false;
  await env.DB.prepare(`UPDATE dl_links SET active = ? WHERE code = ?`).bind(Number(form.get('active')) ? 1 : 0, code).run();
  return true;
}

// ---- Admin: panel /kendali/dl ----
// Sengaja tanpa <table>: daftar memakai .adm-row/.adm-stats seperti panel
// admin lain, supaya tidak meluber di layar HP (keluhan 20:09).
export async function renderDlPanel(env, csrf, nav, notice, url, deps = {}) {
  const hostStatus = await checkDlHostStatus(deps.fetch);
  const activeHost = pickDlHost(hostStatus);
  const statusBadge = s => s.ok === true ? '<b style="color:#16a34a">AKTIF</b>' : s.ok === false ? '<b style="color:#dc2626">NONAKTIF</b>' : '<b style="color:#6b7280">tidak bisa dicek</b>';
  const hostWarn = hostStatus.primary.ok === true
    ? `Link baru memakai domain primer (${esc(activeHost)}).`
    : hostStatus.backup.ok === true
      ? '<b style="color:#dc2626">Perhatian: link-dl sedang nonaktif — link baru otomatis memakai workers.dev (cadangan).</b>'
      : hostStatus.primary.ok === 'unknown' || hostStatus.backup.ok === 'unknown'
        ? `Status domain tidak bisa dicek saat ini — link baru memakai ${esc(activeHost)}.`
        : '<b style="color:#dc2626">Perhatian: kedua domain tidak merespons — link baru tetap memakai link-dl. Periksa domain sebelum membagikan.</b>';
  const statusCard = `<div class="card"><h3>Status domain</h3>`
    + `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(hostStatus.primary.host)}</span><div class="adm-row-meta">primer · dicek ${esc(wib(hostStatus.primary.checkedAt))} WIB</div></div>${statusBadge(hostStatus.primary)}</div>`
    + `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(hostStatus.backup.host)}</span><div class="adm-row-meta">cadangan · dicek ${esc(wib(hostStatus.backup.checkedAt))} WIB</div></div>${statusBadge(hostStatus.backup)}</div>`
    + `<p style="font-size:13px">${hostWarn}</p></div>`;
  const urlLine = (short, st) => `<div class="adm-row-meta" style="word-break:break-all"><a href="${esc(short)}" target="_blank" rel="noopener">${esc(short)}</a> ${statusBadge(st)} <button type="button" data-dl-copy="${esc(short)}">Salin</button></div>`;
  const copyScript = `<script>(function(){async function copyText(t){try{await navigator.clipboard.writeText(t);return true;}catch(e){try{var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();var ok=document.execCommand('copy');document.body.removeChild(ta);return ok;}catch(e2){return false;}}}document.querySelectorAll('[data-dl-copy]').forEach(function(b){b.addEventListener('click',async function(){var ok=await copyText(b.getAttribute('data-dl-copy')||'');b.textContent=ok?'Tersalin':'Gagal menyalin';setTimeout(function(){b.textContent='Salin';},2000);});});})();</script>`;
  const now = Date.now();
  const day7 = now - 7 * 24 * 3600 * 1000;
  // Prune retensi 90 hari, bertahap (maks 500 baris). Gagal prune tidak
  // merusak panel.
  try {
    await env.DB.prepare(`DELETE FROM dl_clicks WHERE id IN (SELECT id FROM dl_clicks WHERE ts < ? ORDER BY id ASC LIMIT ?)`).bind(now - DL_CLICK_RETENTION_DAYS * 24 * 3600 * 1000, DL_PRUNE_BATCH).run();
  } catch (e) {}
  const [links, perDay, perCountry, recent, totalRow, todayRow] = await Promise.all([
    env.DB.prepare(`SELECT l.code, l.target_url, l.title, l.post_id, l.created_at, l.active, (SELECT COUNT(*) FROM dl_clicks c WHERE c.code = l.code) AS total, (SELECT COUNT(*) FROM dl_clicks c WHERE c.code = l.code AND c.ts >= ?) AS d7 FROM dl_links l ORDER BY l.created_at DESC`).bind(day7).all(),
    env.DB.prepare(`SELECT date((ts + 25200000)/1000, 'unixepoch') AS d, COUNT(*) AS c FROM dl_clicks WHERE ts >= ? GROUP BY d ORDER BY d DESC LIMIT 7`).bind(day7).all(),
    env.DB.prepare(`SELECT country, COUNT(*) AS c FROM dl_clicks WHERE country != '' GROUP BY country ORDER BY c DESC LIMIT 10`).all(),
    env.DB.prepare(`SELECT ts, code, ip, country, city, user_agent, referer, user_id FROM dl_clicks ORDER BY id DESC LIMIT 50`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM dl_clicks`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM dl_clicks WHERE ts >= ?`).bind(now - 24 * 3600 * 1000).first(),
  ]);
  const linkRows = (links.results || []).map(l => {
    const short = dlShortUrl(l.code);
    const backupShort = dlShortUrlFor(DL_WORKERS_DEV_HOST, l.code);
    const active = Number(l.active) === 1;
    return `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(l.code)}${active ? '' : ' <b style="color:#dc2626">(nonaktif)</b>'}</span><div class="adm-row-meta">${esc(l.title || '(tanpa judul)')}${l.post_id ? ` · post ${esc(l.post_id)}` : ''} · ${Number(l.total) || 0} klik total · ${Number(l.d7) || 0} klik 7 hari</div>${urlLine(short, hostStatus.primary)}${urlLine(backupShort, hostStatus.backup)}<div class="adm-row-meta" style="word-break:break-all">→ ${esc(l.target_url)}</div></div><form method="post" action="/kendali/dl/toggle" style="display:inline"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="code" value="${esc(l.code)}"><input type="hidden" name="active" value="${active ? '0' : '1'}"><button type="submit">${active ? 'Nonaktifkan' : 'Aktifkan'}</button></form></div>`;
  }).join('') || '<p>Belum ada link. Buat yang pertama di bawah.</p>';
  const dayRows = (perDay.results || []).map(r => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(r.d)}</span></div><span>${Number(r.c) || 0} klik</span></div>`).join('') || '<p>Belum ada klik 7 hari terakhir.</p>';
  const countryRows = (perCountry.results || []).map(r => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(r.country || '(tidak diketahui)')}</span></div><span>${Number(r.c) || 0} klik</span></div>`).join('') || '<p>Belum ada data negara.</p>';
  const recentRows = (recent.results || []).map(c => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(wib(c.ts))} · <a href="${esc(dlShortUrl(c.code))}" target="_blank" rel="noopener">${esc(c.code)}</a></span><div class="adm-row-meta">${esc(c.country || '—')}${c.city ? `, ${esc(c.city)}` : ''}${c.user_id ? ` · login: ${esc(c.user_id)}` : ' · tamu'} · IP ${esc(c.ip || '—')}</div><div class="adm-row-meta" style="word-break:break-all">${esc(String(c.user_agent || '').slice(0, 120))}${c.referer ? `<br>dari: ${esc(String(c.referer).slice(0, 200))}` : ''}</div></div></div>`).join('') || '<p>Belum ada klik tercatat.</p>';
  const formCode = url.searchParams.get('code') || '';
  const formTarget = url.searchParams.get('target') || '';
  return `<h2>Link Download</h2>${nav}${notice}`
    + `<div class="card"><h3>Ringkasan</h3><div class="adm-stats"><div class="adm-stat"><span class="adm-stat-num">${Number(totalRow && totalRow.c) || 0}</span><span class="adm-stat-label">klik total</span></div><div class="adm-stat"><span class="adm-stat-num">${Number(todayRow && todayRow.c) || 0}</span><span class="adm-stat-label">klik 24 jam terakhir</span></div><div class="adm-stat"><span class="adm-stat-num">${(links.results || []).length}</span><span class="adm-stat-label">link aktif dibuat</span></div></div><p style="font-size:13px;opacity:.7">"Siapa" di bawah = alamat IP + perangkat (user-agent), bukan nama orang — nama hanya muncul bila pengunjung sedang login. IP hanya terlihat di halaman ini (admin), tidak pernah tampil di halaman publik. Klik disimpan 90 hari.</p></div>`
    + statusCard
    + `<div class="card"><h3>Buat link baru</h3><form method="post" action="/kendali/dl/create"><input type="hidden" name="csrf" value="${csrf}"><label>URL target (wajib)<input name="target_url" type="url" required maxlength="2000" placeholder="https://drive.google.com/..." value="${esc(formTarget)}"></label><label>Kode pendek (opsional, kosong = ID acak)<input name="code" maxlength="64" placeholder="mis. ksu-next" value="${esc(formCode)}"></label><label>Judul (opsional)<input name="title" maxlength="200" placeholder="mis. KSU NEXT Modul Safe"></label><label>ID postingan (opsional)<input name="post_id" maxlength="40" placeholder="mis. p-20261117-ksu-next-modul-safe"></label><p><button type="submit">Buat short link</button></p><p style="font-size:13px;opacity:.7">Hasilnya: https://${esc(activeHost)}/&lt;kode&gt; — pengunjung diarahkan ke URL target (302) setelah kliknya dicatat. Versi cadangan: https://${esc(activeHost === DL_HOST ? DL_WORKERS_DEV_HOST : DL_HOST)}/&lt;kode&gt;.</p></form></div>`
    + `<div class="card"><h3>Daftar link</h3>${linkRows}</div>`
    + `<div class="card"><h3>Klik per hari (7 hari terakhir, WIB)</h3>${dayRows}</div>`
    + `<div class="card"><h3>Klik per negara</h3>${countryRows}</div>`
    + `<div class="card"><h3>Klik terbaru (50 terakhir)</h3>${recentRows}</div>`
    + copyScript;
}
