# WorkerCMS — web posting ala WordPress, di Cloudflare Workers + D1

![CI](https://github.com/hozin-king/hozin-cms/actions/workflows/ci.yml/badge.svg)

Web posting + komentar + tema + plugin, tanpa PHP/MySQL. Alternatif
WordPress asli untuk satu Worker Cloudflare + satu database D1:
plugin/tema WordPress PHP **tidak** bisa dipakai di sini, plugin/tema di
sini adalah modul JS khusus WorkerCMS (lihat `plugins.js` dan
`themes.js`).

> Nama kerja: **WorkerCMS**. Judul situs yang tampil ke pengunjung
> bukan dari kode ini, melainkan dari pengaturan `site_title` di
> database — jadi instalasi sendiri bisa memakai nama apa pun tanpa
> mengubah kode.

## Fitur v2.2 (edge cache + UI lebih bersih)

- **Load kilat:** halaman publik (beranda + post) di-cache di edge Cloudflare (60s + stale-while-revalidate). Cache hit target <50ms TTFB.
- Tema lebih bersih (aksen solid, responsif mobile/tablet/desktop), meta description + Open Graph dasar.
- Related posts sudah di-escape dengan benar.

## Fitur v2 (teruji lokal, `node test.mjs`)

- **Post:** buat dari panel admin, tampil di beranda dan halaman `/p/<slug>`.
- **Editor 3 mode:** Teks Biasa, Blok Mudah (paragraf/judul/daftar/
  kutipan/gambar/video/audio; drag & drop pakai mouse di PC, tombol
  Naik/Turun di HP), dan HTML (sanitasi daftar putih server-side:
  script/iframe/onclick/`javascript:` dibuang, video/audio diizinkan).
- **Visibilitas post:** Publik, Private (hanya admin, pengunjung 404),
  Link saja (tidak di beranda, bisa dibuka lewat link), Password
  (PBKDF2, metadata dulu — judul/isi/komentar/terkait **tidak dimuat
  sama sekali** sebelum password benar), Terjadwal (publish_at, tanpa
  cron — tiap request membandingkan waktu, jadi post terbit otomatis).
- **Komentar:** wajib akun komentator (bukan akun admin — hanya
  komentar/vote, tidak bisa buka `/admin`); balasan bertingkat
  (indent maks 3), like/dislike per akun (klik lagi membatalkan,
  klik lawan mengganti), moderasi pending tetap (admin auto-setujui
  untuk komentarnya sendiri). Komentar di-escape.
- **View post:** hanya ikon mata + angka (👁 N), sekali per perangkat
  per hari (cookie), admin tidak dihitung.
- **Tema (4, data-driven):** Terang, Gelap, Majalah (serif, lebar 780),
  Minimal (radius 8, aksen solid). Ganti dari `/admin` Pengaturan.
  Responsif HP/tablet/PC: viewport, breakpoint 600px, tombol 44px,
  input 16px anti-zoom iOS, gambar/video tidak luber.
- **Plugin:** Waktu Baca, Bagikan (WhatsApp/X), Post Terkait.
  Aktif/nonaktif dari panel admin. Tambah plugin = tambah entri di
  `plugins.js`, redeploy.
- **Backup ke database kedua:** panel admin punya tombol
  “Buat Backup Sekarang” + riwayat 10 backup terakhir
  (BERHASIL/GAGAL, jumlah post & komentar, pesan error bila gagal).
  Backup menyalin post, komentar (termasuk pending), pengaturan,
  plugin, akun komentator, dan vote ke tabel `cms_backup_*` di
  database backup. Database backup khusus jadi tempat backup, bukan
  database live kedua. Bila binding `BACKUP_DB` belum dipasang,
  tombol backup mencatat GAGAL dengan pesan jelas, bukan crash.
- **Footer:** copyright `© 2024–tahun berjalan` + uptime sejak
  `2024-01-01` (klik untuk ganti mode rincian / total jam, update
  tiap detik) — ada di semua halaman. Nama brand di footer dan mark
  di header berasal dari judul situs, bukan hardcoded.
- **Failsafe pemeliharaan:** bila database hilang atau error tak
  terduga apa pun, seluruh situs beralih ke halaman “Under
  Maintenance” berbahasa Inggris (503), tanpa bocor detail internal.
  Pulih otomatis tanpa redeploy begitu database bisa diakses lagi.

## Keamanan (satu admin saja)

- **Satu admin saja:** hanya pemilik dengan `ADMIN_TOKEN`. Tidak ada
  akun editor, penulis, atau pendaftar publik. Tidak ada endpoint
  publik untuk membuat post — post hanya lewat `/admin/*` dengan
  sesi + CSRF.
- **Sistem token login:** token akses HMAC 1 jam (stateless) +
  token refresh opaque di D1 (hanya hash SHA-256 yang disimpan,
  diputar tiap dipakai). Tanpa “ingat saya”: refresh 1 hari; dengan
  “ingat saya”: 30 hari. Refresh lama yang sudah diputar lalu
  dipakai lagi = tanda pencurian → semua sesi dicabut. Dashboard
  punya daftar Sesi & Perangkat + Cabut per sesi + Keluar dari
  Semua Perangkat. Batasan jujur: token akses yang masih hidup
  (maks 1 jam) tetap sah sampai kedaluwarsa meski refresh dicabut;
  yang dicabut seketika adalah kemampuan memperpanjang sesi.
- **Rate-limit login:** 5x gagal dari satu IP dalam 15 menit → 429.
  Rate-limit POST lain (komentar, akun, unlock, vote) di D1, tidak
  untuk GET supaya tidak membakar kuota.
- **CSRF:** semua aksi admin POST wajib token CSRF. Aksi tanpa CSRF
  ditolak 403 (diuji). Token CSRF admin sengaja stabil (HMAC),
  supaya form tidak basi setelah rotasi akses.
- **Header keamanan:** `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, CSP (object-src none, frame-ancestors none,
  form-action self, img/media https), permissions-policy,
  `cache-control: no-store` untuk `/admin*` dan `/akun*`.
- **Batas lain:** body POST maks 200 KB (lebih → 413), honeypot
  komentar, semua input dibatasi panjangnya, password PBKDF2-SHA256
  100k iterasi.
- **Anti-DDoS, jujur:** banjir volumetrik ditangani jaringan
  Cloudflare (selalu aktif); kode Worker hanya menghentikan
  spam/brute-force lapis aplikasi + failsafe pemeliharaan bila D1
  mati. Bila diserang sungguhan, aktifkan Under Attack Mode / WAF
  rate-limit di dashboard Cloudflare (keputusan pemilik, bukan kode).
- **`ADMIN_TOKEN`** harus acak ≥32 karakter, hanya di secret
  Worker, jangan di repo, jangan dibagikan, ganti segera bila bocor.

## Struktur modul

- `worker.js` — routing + fetch wrapper + `handleFetch` (ramping,
  impor modul di bawah; bukan lagi satu file raksasa)
- `util.js` — escape, sanitasi HTML, cookie, hash, helper HTTP
- `auth.js` — sesi admin (akses + refresh), akun komentator,
  kunci post, password PBKDF2
- `security.js` — rate limit POST di D1
- `content.js` — visibilitas post, kartu post, pohon komentar
- `store.js` — skema D1, pengaturan, plugin aktif, backup, render
- `editor.js` — kartu Post Baru (editor 3 mode)
- `themes.js` — tema data-driven (tambah tema = tambah entri)
- `plugins.js` — plugin (tambah plugin = tambah entri)
- `schema.sql` — tabel D1 v2 (juga dibuat otomatis oleh Worker)
- `test.mjs` — uji lokal dengan mock D1

## Build, uji, deploy

```sh
# Uji lokal (mock D1, tanpa Cloudflare)
node test.mjs

# Build bundle untuk deploy (output ke dist/, di-gitignore — jangan
# edit hasil build langsung, edit sumbernya lalu build ulang)
npx esbuild worker.js --bundle --format=esm --outfile=dist/worker.js
```

Deploy:
1. Buat / pakai database D1, terapkan `schema.sql` (opsional —
   Worker membuat skema otomatis saat pertama jalan).
2. Build seperti di atas.
3. Upload Worker dengan binding D1 bernama `DB`, binding database
   backup bernama `BACKUP_DB` (opsional, untuk tombol backup), dan
   secret `ADMIN_TOKEN`. **Binding D1 harus selalu dicantumkan di
   metadata upload — binding yang tidak dicantumkan akan ter-strip
   dari versi baru.**
4. Route Worker ke domain/subdomain di Cloudflare.

## Batasan jujur

- Bukan WordPress: tidak bisa install plugin/tema WordPress asli.
- Tema/plugin baru masih lewat edit kode + redeploy, belum lewat
  upload file dari panel admin.
- Penyimpanan media belum dibangun di v2: blok gambar/video/audio
  memakai URL langsung (mis. CDN / layanan image hosting). Player
  memakai player native HTML5 (controls, seek, fullscreen video).
- Akun komentator tidak punya reset password mandiri (tidak ada
  email yang dikumpulkan); pemulihan = admin menghapus akun dari
  dashboard, lalu pengguna daftar ulang.
