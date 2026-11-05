// Security WorkerCMS — rate limit POST di D1 (anti-spam / brute-force).
import { pruneRateTables } from './store.js';

// Rate limit ringan di D1 (anti-spam / anti-brute-force lapis aplikasi).
// Dipakai HANYA untuk POST (komentar, daftar, login akun, buka kunci post,
// vote) — plus SATU pengecualian GET: penulisan view post (H1 audit 31 Okt
// 2026), justru untuk menghemat tulis D1 dari spam penghapus cookie.
// Selain itu bukan untuk GET, supaya tidak membakar kuota D1 di tiap kunjungan.
// Serangan DDoS volumetrik sendiri ditangani jaringan Cloudflare (selalu
// aktif, tanpa kuota), bukan oleh kode ini; lapis ini menghentikan spam
// dan brute-force dari satu IP / satu akun.
let lastPruneMs = 0;
export async function checkRateLimit(env, key, limit, windowMs) {
  // H6: prune berkala tabel rate-limit, paling sering 1x/jam per isolate;
  // gagal prune tidak boleh menggagalkan rate-limit (fail-silent).
  if (Date.now() - lastPruneMs > 3600 * 1000) {
    lastPruneMs = Date.now();
    try { await pruneRateTables(env); } catch (e) {}
  }
  const bucket = Math.floor(Date.now() / windowMs);
  const k = key + ':' + bucket;
  const row = await env.DB.prepare(`SELECT count FROM cms_rate_limits WHERE key = ?`).bind(k).first();
  const n = row ? Number(row.count) : 0;
  if (n >= limit) return false;
  await env.DB.prepare(`INSERT INTO cms_rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1`).bind(k, new Date().toISOString()).run();
  return true;
}
