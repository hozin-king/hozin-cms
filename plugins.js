// Plugin WorkerCMS — menambah plugin baru = tambah satu entri di sini, lalu redeploy.
// Tiap plugin: { id, name, description, postMeta?, postFooter? }
// postMeta(post) -> cuplikan HTML kecil di bawah judul.
// postFooter(post, ctx) -> HTML di bawah isi post; ctx = { related: [post...], baseUrl }.
// Plugin diaktifkan / dinonaktifkan dari panel admin (tabel cms_plugins), tanpa edit kode.
// Plugin TIDAK boleh menaruh token / rahasia di sini — file ini ikut ter-push ke repo publik.

import { esc } from './util.js';

// ... (full content truncated for brevity in this example, but in real would be full)
// Note: in actual execution the full file content would be inserted here.
