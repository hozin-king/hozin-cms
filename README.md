# CMS Hozin — web root ala WordPress, di Cloudflare Workers + D1

Web posting + komentar + tema + plugin, tanpa PHP/MySQL. Dibuat untuk
`hozinking.my.id` sebagai alternatif WordPress asli: plugin/tema WordPress
PHP **tidak** bisa dipakai di sini, plugin/tema di sini adalah modul JS
khusus CMS ini (lihat `plugins.js` dan `themes.js`).

## Fitur v1 (teruji lokal, `node test.mjs` 13/13 OK)

- **Post:** buat dari panel admin, tampil di beranda dan halaman `/p/<slug>`.
- **Komentar:** pengunjung kirim komentar -> status `pending`, admin setujui
  di panel admin baru tampil. Komentar di-escape (tag `<script>` tidak jalan).
- **Tema:** Terang dan Gelap, ganti dari panel admin (pengaturan tersimpan
  di D1, bukan di kode).
- **Plugin:** Waktu Baca, Bagikan (WhatsApp/X), Post Terkait. Aktif/nonaktif
  dari panel admin. Tambah plugin = tambah entri di `plugins.js`, redeploy.
- **Admin:** `/admin`, login pakai password = secret `ADMIN_TOKEN` di Worker.
  Sesi cookie HMAC 7 hari. Admin bisa: ubah judul situs & tema, buat/hapus
  post, setujui/hapus komentar, aktif/nonaktifkan plugin.

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
