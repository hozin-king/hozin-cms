// Security WorkerCMS — rate limit POST di D1 (anti-spam / brute-force).

// Rate limit atomik di D1 (anti-spam / anti-brute-force lapis aplikasi).
// Dipakai HANYA untuk POST (komentar, daftar, login akun, buka kunci post,
// vote) — bukan untuk GET, supaya tidak membakar kuota D1 di tiap kunjungan.
// Serangan DDoS volumetrik sendiri ditangani jaringan Cloudflare (selalu
// aktif, tanpa kuota), bukan oleh kode ini; lapis ini menghentikan spam
// dan brute-force dari satu IP / satu akun.
// Kenaikan counter dan pengecekan batas terjadi dalam SATU statement
// UPSERT: bila counter sudah mencapai batas, statement tidak mengubah
// apa pun (meta.changes = 0) sehingga request yang ditolak TIDAK menambah
// counter. Dua request yang datang bersamaan tidak bisa sama-sama lolos
// di atas batas, karena keputusan dibuat oleh statement itu sendiri.
// Catatan: ini atomik per statement di SQLite/D1. Mock di test.mjs hanya
// meniru semantik changes, bukan race condition D1 nyata.
export async function checkRateLimit(env, key, limit, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const k = key + ':' + bucket;
  const res = await env.DB.prepare(
    `INSERT INTO cms_rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE cms_rate_limits.count < ?`
  ).bind(k, new Date().toISOString(), limit).run();
  return Boolean(res && res.meta && Number(res.meta.changes) === 1);
}
