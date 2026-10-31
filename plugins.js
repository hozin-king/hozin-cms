// Plugin WorkerCMS — menambah plugin baru = tambah satu entri di sini, lalu redeploy.
// Tiap plugin: { id, name, description, postMeta?, postFooter? }
// postMeta(post) -> cuplikan HTML kecil di bawah judul.
// postFooter(post, ctx) -> HTML di bawah isi post; ctx = { related: [post...], baseUrl }.
// Plugin diaktifkan / dinonaktifkan dari panel admin (tabel cms_plugins), tanpa edit kode.
// Plugin TIDAK boleh menaruh token / rahasia di sini — file ini ikut ter-push ke repo publik.

import { esc } from './util.js';

export const DIRTY_WORDS = ['anjing', 'anjim', 'anjir', 'anjrit', 'anjrot', 'bangsat', 'tolol', 'goblok', 'goblog', 'bajingan', 'kampret', 'jancuk', 'jancok', 'dancuk', 'kontol', 'konthol', 'qontol', 'memek', 'pepek', 'ngentot', 'entot', 'asu', 'babi', 'bacot', 'bangke', 'bego', 'bencong', 'banci', 'brengsek', 'jembut', 'keparat', 'kimak', 'pantek', 'pukimak', 'lonte', 'fuck', 'bitch'];
export function maskDirtyWords(text) {
  let out = String(text || '');
  for (const w of DIRTY_WORDS) {
    out = out.replace(new RegExp('\\b' + w + '\\b', 'gi'), '***');
  }
  return out;
}

export function normalizeText(text) {
  let t = String(text || '').toLowerCase();
  t = t.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's').replace(/@/g, 'a');
  t = t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/(.)\1{2,}/g, '$1');
  return t;
}
export function hasDirtyWord(text) {
  const norm = normalizeText(text);
  const nospace = norm.replace(/ /g, '');
  return DIRTY_WORDS.some(w => new RegExp('\\b' + w + '\\b').test(norm) || nospace.includes(w));
}
export const JUDOL_PATTERNS = ['judol', 'judi', 'judi online', 'judi slot', 'judi bola', 'situs judi', 'situs slot', 'situs slot gacor', 'situs togel', 'situs gacor', 'slot gacor', 'slot online', 'slot88', 'togel88', 'gacor', 'gacor hari ini', 'jam gacor', 'jam hoki', 'maxwin', 'togel', 'bandar togel', 'agen togel', 'agen slot', 'prediksi togel', 'bocoran slot', 'bocoran pola', 'pola slot', 'pola gacor', 'pola turbo', 'pola malam', 'rtp slot', 'rtp live', 'rtp gacor', 'link gacor', 'link alternatif', 'daftar slot', 'daftar sekarang', 'mix parlay', 'parlay', 'scatter', 'free spin', 'bonus deposit', 'bonus new member', 'bonus besar', 'win rate', 'deposit pulsa', 'deposit dana', 'cashback', 'bit.ly', 'tinyurl', 'linktr.ee'];
export function hasJudol(text) {
  const norm = normalizeText(text);
  const nospace = norm.replace(/ /g, '');
  return JUDOL_PATTERNS.some(ph => {
    const phNorm = ph.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
    const phNospace = phNorm.replace(/ /g, '');
    return norm.includes(phNorm) || nospace.includes(phNospace);
  });
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
      return `<div class="card"><h3>Post Terkait</h3>` + rel.map(p => `<p><a href="/post/${esc(p.slug)}">${esc(p.title)}</a></p>`).join('') + `</div>`;
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
  {
    id: 'blokir-link',
    name: 'Blokir Komentar Berlink',
    description: 'Menolak langsung komentar komentator yang mengandung link (tidak disimpan, tidak masuk moderasi). Admin dikecualikan. Lebih keras dari Tahan Komentar Berlink.',
  },
  {
    id: 'blokir-kotor',
    name: 'Blokir Kata Kotor',
    description: 'Menolak langsung komentar komentator yang mengandung kata kotor (tidak disimpan). Admin dikecualikan. Lebih keras dari Filter Kata Kotor yang hanya menyensor tampilan.',
  },
  {
    id: 'blokir-judol',
    name: 'Blokir Judol Otomatis',
    description: 'Menolak langsung komentar komentator yang mengandung kata/frasa judi online (judol, judi, togel, slot gacor, gacor, maxwin, dll). Admin dikecualikan. Kata slot saja tidak diblokir.',
  },
];
