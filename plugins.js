// Plugin WorkerCMS — menambah plugin baru = tambah satu entri di sini, lalu redeploy.
// Tiap plugin: { id, name, description, postMeta?, postFooter? }
// postMeta(post) -> cuplikan HTML kecil di bawah judul.
// postFooter(post, ctx) -> HTML di bawah isi post; ctx = { related: [post...], baseUrl }.
// Plugin diaktifkan / dinonaktifkan dari panel admin (tabel cms_plugins), tanpa edit kode.
// Plugin TIDAK boleh menaruh token / rahasia di sini — file ini ikut ter-push ke repo publik.

// Plugin keamanan (contoh, semua benar-benar jalan, bukan saklar mati):
// - filter-kotor: sensor kata kotor di komentar yang TAMPIL (***), isi asli
//   di database tidak diubah, admin tetap melihat aslinya di moderasi.
// - tahan-link: komentar berlink selalu ditahan moderasi, bahkan dari admin.
// - tahan-panjang: komentar >1000 karakter ditahan moderasi (anti spam).
export const DIRTY_WORDS = ['anjing', 'bangsat', 'tolol', 'goblok', 'bajingan', 'kampret', 'jancuk', 'kontol', 'memek', 'ngentot', 'asu', 'babi'];
export function maskDirtyWords(text) {
  let out = String(text || '');
  for (const w of DIRTY_WORDS) {
    out = out.replace(new RegExp('\\b' + w + '\\b', 'gi'), '***');
  }
  return out;
}
export function hasLink(text) {
  return /(https?:\/\/|www\.)/i.test(String(text || ''));
}

export const pluginDefs = [
  {
    id: 'reading-time',
    name: 'Waktu Baca',
    description: 'Menampilkan perkiraan menit baca di bawah judul post.',
    postMeta: (post) => {
      const words = String(post.body || '').trim().split(/\s+/).filter(Boolean).length;
      const minutes = Math.max(1, Math.round(words / 200));
      return ` · ±${minutes} menit baca`;
    },
  },
  {
    id: 'share',
    name: 'Bagikan',
    description: 'Tombol bagikan WhatsApp dan X di bawah post.',
    postFooter: (post, ctx) => {
      const url = encodeURIComponent((ctx.baseUrl || '') + '/post/' + post.slug);
      const text = encodeURIComponent(post.title);
      return `<p>Bagikan: <a href="https://wa.me/?text=${text}%20${url}">WhatsApp</a> · <a href="https://twitter.com/intent/tweet?text=${text}&url=${url}">X</a></p>`;
    },
  },
  {
    id: 'related',
    name: 'Post Terkait',
    description: 'Menampilkan post lain dengan kategori sama di bawah post.',
    postFooter: (post, ctx) => {
      const rel = (ctx.related || []).filter(p => p.id !== post.id).slice(0, 3);
      if (!rel.length) return '';
      return `<div class="card"><h3>Post Terkait</h3>` + rel.map(p => `<p><a href="/post/${p.slug}">${p.title}</a></p>`).join('') + `</div>`;
    },
  },
  {
    id: 'filter-kotor',
    name: 'Filter Kata Kotor',
    description: 'Menyensor kata kotor di komentar yang tampil (***). Isi asli di database tidak diubah, admin tetap melihat aslinya di moderasi.',
  },
  {
    id: 'tahan-link',
    name: 'Tahan Komentar Berlink',
    description: 'Komentar yang mengandung link (http/https/www) selalu ditahan untuk moderasi, bahkan dari admin, untuk cegah spam link.',
  },
  {
    id: 'tahan-panjang',
    name: 'Tahan Komentar Panjang',
    description: 'Komentar lebih dari 1000 karakter ditahan untuk moderasi (anti spam panjang).',
  },
];
