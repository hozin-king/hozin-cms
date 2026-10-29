# CMS Hozin — web root ala WordPress, di Cloudflare Workers + D1

Web posting + komentar + tema + plugin, tanpa PHP/MySQL. Dibuat untuk
`hozinking.my.id` sebagai alternatif WordPress asli: plugin/tema WordPress
PHP **tidak** bisa dipakai di sini, plugin/tema di sini adalah modul JS
khusus CMS ini (lihat `plugins.js` dan `themes.js`).

## Fitur v1 (teruji lokal, `node test.mjs` 18 cek OK)

- **Post:** buat dari panel admin, tampil di beranda dan halaman `/p/<slug>`.
- **Komentar:** pengunjung kirim komentar -> status `pending`, admin setujui
  di panel admin baru tampil. Komentar di-escape (tag `<script>` tidak jalan).
- **Tema:** Terang dan Gelap, ganti dari panel admin (pengaturan tersimpan
  di D1, bukan di kode). **Anti AI slop:** kedua tema memakai identitas
  situs lama hozinking.my.id (latar malam #05070d, gradasi biru-ungu
  #3b82f6 -> #8b5cf6, mark “H” di header), bukan palet slate/sky default
  template — ganti tema tidak terasa seperti ganti situs lain.
- **Plugin:** Waktu Baca, Bagikan (WhatsApp/X), Post Terkait. Aktif/nonaktif
  dari panel admin. Tambah plugin = tambah entri di `plugins.js`, redeploy.
- **Backup ke stopwatch:** panel admin super-super-admin punya tombol
  “Buat Backup Sekarang” + riwayat 10 backup terakhir (BERHASIL/GAGAL,
  jumlah post & komentar, pesan error bila gagal). Backup menyalin post,
  komentar (termasuk yang masih pending), pengaturan, dan plugin dari DB
  utama ke tabel `cms_backup_*` di database stopwatch. Stopwatch khusus
  jadi tempat backup, bukan database live kedua — salinan tidak pernah
  ditulis dari jalur lain. Bila binding `BACKUP_DB` belum dipasang, tombol
  backup mencatat GAGAL dengan pesan jelas, bukan crash.
  Sesi cookie HMAC 7 hari. Admin bisa: ubah judul situs & tema, buat/hapus
  post, setujui/hapus komentar, aktif/nonaktifkan plugin.
- **Footer dipertahankan dari situs lama:** copyright `© 2024–tahun berjalan`
  HozinKing dan uptime server sejak `2024-01-01 WIB` (klik untuk ganti mode
  rincian / total jam, update tiap detik) — ada di semua halaman CMS.

## Proteksi super-super-admin (29 Okt 2026)

- **Satu admin saja:** hanya pemilik dengan `ADMIN_TOKEN`. Tidak ada akun
  editor, penulis, atau pendaftar publik. Tidak ada endpoint publik untuk
  membuat post — post hanya lewat `/admin/*` dengan sesi + CSRF.
- **Rate-limit login:** 5x gagal dari satu IP dalam 15 menit -> 429.
- **CSRF:** semua aksi admin POST wajib token CSRF terikat sesi (HMAC).
  Aksi tanpa CSRF ditolak 403 (diuji).
- **Header keamanan:** `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, CSP di semua respons HTML.
- **Token:** `ADMIN_TOKEN` harus acak >=32 karakter, hanya di secret Worker,
  jangan di repo, jangan dibagikan, ganti segera bila bocor. Bila token
  bocor, semua sesi lama tidak otomatis mati — ganti token dan sesi lama
  jadi tidak valid karena HMAC memakai token baru.

## File

- `worker.js` — Worker utama (routing, admin, rendering)
- `themes.js` — tema (tambah tema = tambah entri)
- `plugins.js` — plugin (tambah plugin = tambah entri)
- `schema.sql` — tabel D1 (juga dibuat otomatis oleh Worker saat pertama jalan)
- `test.mjs` — uji lokal dengan mock D1

## Deploy (BELUM dilakukan — butuh keputusan root vs subdomain)

Worker ini bila di-route ke root `hozinking.my.id` akan **menggantikan**
situs Tools yang sekarang ada di root. Tools harus dipindah ke subdomain
(mis. `tools.hozinking.my.id`) dulu, atau CMS ini diuji dulu di subdomain
(mis. `cms.hozinking.my.id` / `blog.hozinking.my.id`).

Langkah deploy setelah diputuskan:
1. Buat / pakai database D1, terapkan `schema.sql`.
2. Build: `npx esbuild worker.js --bundle --format=esm --outfile=dist/worker.js`
3. Upload Worker dengan binding D1 bernama `DB` dan secret `ADMIN_TOKEN`
   (jangan taruh token di repo — repo ini publik, kode tidak berisi secret).
4. Route Worker ke domain/subdomain yang diputuskan di Cloudflare.

## Batasan jujur v1

- Bukan WordPress: tidak bisa install plugin/tema WordPress asli.
- Tema/plugin baru masih lewat edit kode + redeploy, belum lewat upload
  file dari panel admin (itu bisa ditambah di v2, dengan peringatan keamanan
  yang sama seperti plugin gateway: kode yang di-upload jalan dengan hak penuh).
- Komentar tanpa login pengunjung, moderasi admin adalah pertahanan utama
  dari spam — pertimbangkan CAPTCHA / rate limit di v2 bila spam muncul.
