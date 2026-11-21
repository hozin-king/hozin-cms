# Restore Backup — Hozin CMS

Prosedur memulihkan database CMS dari backup. Ditulis saat audit keamanan
21 Nov 2026 — sebelumnya TIDAK ADA prosedur restore tertulis sama sekali.

## Yang di-backup (tombol "Buat Backup Sekarang" di /kendali/backup)

`doBackup()` (store.js) menyalin 12 tabel CMS dari `DB` (cms-db) ke tabel
`cms_backup_*` di `BACKUP_DB` (stopwatch-db). Backup terbaru MENIMPA backup
sebelumnya (DELETE + INSERT ulang) — hanya ada SATU generasi backup.

| Tabel live (cms-db) | Tabel backup (stopwatch-db) |
|---|---|
| cms_posts | cms_backup_posts |
| cms_comments | cms_backup_comments |
| cms_settings | cms_backup_settings |
| cms_plugins | cms_backup_plugins |
| cms_users | cms_backup_users |
| cms_comment_votes | cms_backup_votes |
| cms_loadtest_runs | cms_backup_loadtest_runs |
| dracin_api_keys | cms_backup_dracin_api_keys |
| dracin_catalog | cms_backup_dracin_catalog |
| dracin_episodes | cms_backup_dracin_episodes |
| dracin_seeds | cms_backup_dracin_seeds |
| dracin_api_usage | cms_backup_dracin_api_usage |

### Yang SENGAJA tidak ikut ter-backup

- Kunci ImgBB (`imgbb_api_keys` / `imgbb_api_key`) dan `csrf_secret` di
  `cms_settings` — dikecualikan dari backup.
- Hash/salt password post (`post_password_hash`, `post_password_salt`) dan
  hash/salt password komentator — dikosongkan di backup.
- Hash kunci API Dracin IKUT ter-backup (hanya hash, bukan plaintext).

### Yang TIDAK PERNAH di-backup tombol ini

- Semua tabel Cerpen / Tap Tap Tycoon / Dompet di stopwatch-db (koin, ban,
  voucher, redeem, deteksi, backup dompet). Backup ini HANYA untuk CMS.
- Sesi login / refresh token, rate-limit, dan log keamanan.

## Yang belum ada: tombol restore

Tidak ada endpoint restore untuk backup CMS (yang ada hanya restore versi
`.md` di POST /api/admin/md-backups/:id/restore — itu untuk file .md, bukan
tabel CMS). Restore CMS dilakukan manual lewat wrangler, langkah di bawah.

## Prosedur restore manual

> Lakukan di jam sepi. Backup TIDAK menimpa apa pun sebelum langkah 3 —
> baca dulu, pahami dulu, baru jalankan.

### 0. Hentikan tulisan baru (opsional tapi disarankan)

Nonaktifkan Worker sementara dari dashboard Cloudflare (Workers & Pages →
hozin-cms → Settings → pause) supaya tidak ada tulisan baru yang tertimpa
oleh restore. Nyalakan lagi setelah langkah 4 selesai.

### 1. Lihat isi backup yang tersedia

```sh
wrangler d1 execute stopwatch-db --remote --command \
  "SELECT backup_at, COUNT(*) AS n FROM cms_backup_posts GROUP BY backup_at"
wrangler d1 execute stopwatch-db --remote --command \
  "SELECT COUNT(*) AS posts FROM cms_backup_posts"
wrangler d1 execute stopwatch-db --remote --command \
  "SELECT COUNT(*) AS comments FROM cms_backup_comments"
```

Catat `backup_at` (waktu backup dibuat) dan jumlah baris. Bila backup kosong
(0 baris), JANGAN lanjut — backup terakhir gagal / belum pernah dibuat.

### 2. Ekspor tabel backup ke file SQL

Untuk tiap tabel backup, dump isinya dari stopwatch-db. Cara paling aman:
`wrangler d1 export` tidak ada — pakai query + konversi ke INSERT. Contoh
untuk posts (ulangi untuk 12 tabel di atas, sesuaikan kolom):

```sh
wrangler d1 execute stopwatch-db --remote --json --command \
  "SELECT * FROM cms_backup_posts" > /tmp/restore_posts.json
```

Lalu ubah JSON menjadi file `restore.sql` berisi `INSERT OR REPLACE` ke tabel
live (tanpa kolom `backup_at`). Skrip konversi harus meng-quote string
dengan benar (kutip tunggal digandakan: `'` → `''`).

### 3. Pulihkan ke cms-db

```sh
# Satu tabel dulu sebagai uji (posts), cek hasilnya, baru lanjutkan sisanya.
wrangler d1 execute cms-db --remote --file /tmp/restore_posts.sql
wrangler d1 execute cms-db --remote --command \
  "SELECT COUNT(*) AS posts FROM cms_posts"
```

Bila jumlah cocok dengan langkah 1, lanjutkan 11 tabel lainnya dengan cara
yang sama. `INSERT OR REPLACE` menimpa baris dengan id yang sama dan
menambah baris yang belum ada; baris live yang TIDAK ADA di backup (dibuat
setelah backup) tetap ada — hapus manual bila memang harus kembali persis
ke kondisi backup.

### 4. Setelah restore — isi ulang yang dikosongkan

- **Kunci ImgBB:** isi ulang di /kendali/settings (kunci lama tidak ada di
  backup — bila hilang total, buat kunci baru di ImgBB).
- **csrf_secret:** dibuat ulang otomatis saat login berikut — tidak perlu
  tindakan.
- **Password post:** post ber-password kehilangan hash-nya — atur ulang
  password tiap post dari /kendali/posts/edit.
- **Password komentator:** komentator yang lupa password harus reset lewat
  admin (hapus akun → daftar ulang).
- **Kunci API Dracin:** hash ikut ter-backup, jadi kunci lama tetap jalan.

### 5. Verifikasi + nyalakan lagi

- Buka beranda + 1 post + /kendali/backup (riwayat backup tampil).
- Bila Worker di-pause di langkah 0, nyalakan lagi.
- Buat backup BARU segera setelah restore berhasil (supaya generasi backup
  mengikuti kondisi live yang baru).

## Batasan jujur (temuan audit 21 Nov 2026)

- Backup hanya 1 generasi (backup baru menimpa yang lama) — tidak ada
  riwayat per tanggal.
- Backup TIDAK mencakup Cerpen / TTT / Dompet — data itu hanya hidup di
  stopwatch-db tanpa salinan kedua.
- Backup tinggal di database yang SAMA dengan data live Cerpen/TTT/Dompet
  (stopwatch-db) — bukan salinan offsite. Bila stopwatch-db rusak, backup
  CMS ikut hilang.
- Tidak ada cron backup otomatis — backup hanya jalan bila admin menekan
  tombol di /kendali/backup.
- Perbaikan yang disarankan (butuh keputusan admin): cron backup berkala +
  salinan offsite + cakupan Cerpen/TTT/Dompet — lihat laporan audit
  `~/workspace/your_files/Audit-Keamanan-HozinCMS-2026-11-21.md`.
