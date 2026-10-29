// Plugin CMS Hozin — menambah plugin baru = tambah satu entri di sini, lalu redeploy.
// Tiap plugin: { id, name, description, postMeta?, postFooter? }
// postMeta(post) -> cuplikan HTML kecil di bawah judul.
// postFooter(post, ctx) -> HTML di bawah isi post; ctx = { related: [post...], baseUrl }.
// Plugin diaktifkan / dinonaktifkan dari panel admin (tabel cms_plugins), tanpa edit kode.
// Plugin TIDAK boleh menaruh token / rahasia di sini — file ini ikut ter-push ke repo publik.
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
      const url = encodeURIComponent((ctx.baseUrl || '') + '/p/' + post.slug);
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
      return `<div class="card"><h3>Post Terkait</h3>` + rel.map(p => `<p><a href="/p/${p.slug}">${p.title}</a></p>`).join('') + `</div>`;
    },
  },
];
