// Content WorkerCMS — visibilitas post, kartu post, dan pohon komentar.
import { esc, stripTags } from './util.js';

// Visibilitas post: 'public' (beranda + link), 'private' (hanya admin),
// 'unlisted' (tidak di beranda, bisa dibuka siapa pun yang tahu link),
// 'password' (link + password, isi TIDAK dimuat sama sekali sebelum kunci
// dibuka — lihat rute detail: metadata dulu, body hanya diambil setelah
// lolos). Terjadwal = publish_at di masa depan: beranda + pengunjung belum
// bisa melihat, admin bisa pratinjau. Tidak butuh cron: tiap request
// membandingkan publish_at dengan waktu sekarang, jadi begitu waktunya
// lewat, post otomatis tampil.
export function isScheduled(post, nowIso) {
  return post.publish_at && String(post.publish_at) > nowIso;
}
export function visibilityLabel(post, nowIso) {
  if (isScheduled(post, nowIso)) return 'Terjadwal';
  if (post.visibility === 'private') return 'Private';
  if (post.visibility === 'unlisted') return 'Link saja';
  if (post.visibility === 'password') return 'Password';
  return 'Publik';
}

// Slot iklan manual (bukan AdSense): hanya tampil bila gambar + link diisi
// di Pengaturan. Tidak ada script pihak ketiga, jadi tidak memperlambat
// halaman. Kosong = tidak tampil sama sekali, tidak ada kotak kosong.
export function adBanner(adImage, adLink, adText) {
  const img = typeof adImage === 'string' && adImage.startsWith('https://') ? adImage : '';
  const link = typeof adLink === 'string' && adLink.startsWith('https://') ? adLink : '';
  if (!img || !link) return '';
  return `<div class="card" style="text-align:center"><p class="meta">Iklan</p><a href="${esc(link)}" target="_blank" rel="sponsored noopener"><img src="${esc(img)}" alt="${esc(adText || 'Iklan')}" loading="lazy" style="max-width:100%;height:auto;border-radius:12px"></a>${adText ? `<p>${esc(adText)}</p>` : ''}</div>`;
}


// Ikon mata kreatif (bukan emoji): SVG mata dengan iris biru-ungu, pupil,
// dan titik cahaya. Animasi kedip diatur .eye-blink (4 detik, CSS di themes.js);
// sinkronisasi fase dilakukan footer script di themes.js dari jam dinding
// (Date.now() % 4000), jadi semua penonton yang jam HP-nya benar (NTP)
// melihat kedip pada detik yang sama, bukan kedip acak per halaman.
export function viewEye(views) {
  return '<span class="view-eye" aria-label="Dilihat"><svg viewBox="0 0 32 28" fill="none" aria-hidden="true"><g class="eye-blink"><path d="M2 14 Q16 2 30 14 Q16 26 2 14 Z" fill="#ffffff" stroke="#3b82f6" stroke-width="1.5"/><circle cx="16" cy="14" r="7" fill="#3b82f6"/><circle cx="16" cy="14" r="3.5" fill="#0b1220"/><circle cx="18" cy="11.5" r="1.3" fill="#ffffff"/></g></svg></span> ' + views;
}

export function postCard(post, plugins, isAdmin = false) {
  const meta = plugins.map(p => p.postMeta ? p.postMeta(post) : '').join('');
  // Cuplikan selalu dari teks polos (tag HTML post dibuang), jadi cuplikan
  // tidak pernah membocorkan markup. Jumlah tayang hanya logo mata + angka,
  // tanpa kata "dilihat" — sesuai permintaan pemilik.
  // Sampul: gambar pertama di isi post (hanya http/https, di-escape).
  // Kalau tidak ada gambar, kartu tetap teks saja — tidak ada kotak kosong.
  const plain = stripTags(post.body || '');
  const views = Number(post.views) || 0;
  const imgMatch = String(post.body || '').match(/<img[^>]+src=["'](https?:[^"'\s>]+)["']/i);
  const cover = imgMatch
    ? `<a href="/p/${esc(post.slug)}"><img class="post-cover" src="${esc(imgMatch[1])}" alt="" loading="lazy"></a>`
    : '';
  const editLink = isAdmin
    ? ` · <a href="/kendali/posts/edit?id=${esc(post.id)}">Edit</a>`
    : '';
  return `<article class="card">${cover}<h2><a href="/p/${esc(post.slug)}">${esc(post.title)}</a></h2><p class="meta">${esc(post.category)} · ${esc(String(post.created_at || '').slice(0, 10))} · ${viewEye(views)}${meta}</p><p>${esc(plain.slice(0, 200))}${plain.length > 200 ? '…' : ''}</p><p><a class="read-more" href="/p/${esc(post.slug)}">Selengkapnya →</a>${editLink}</p></article>`;
}

// Pohon komentar: balasan menempel di bawah induknya, indent dibatasi
// supaya tidak bergeser terlalu jauh di layar HP.
export function renderCommentsTree(comments, votes, myVotes, csrfField, canReply, postSlug) {
  const byParent = new Map();
  for (const c of comments) {
    const key = c.parent_id ? String(c.parent_id) : 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }
  const renderOne = (c, depth) => {
    const v = votes.get(c.id) || { like: 0, dislike: 0 };
    const mine = myVotes.get(c.id) || 0;
    const indent = Math.min(depth, 3) * 18;
    const replyForm = canReply
      ? `<form method="post" action="/p/${esc(postSlug)}/comment" style="margin-top:8px"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="parent_id" value="${c.id}"><textarea name="text" maxlength="2000" placeholder="Balas ${esc(c.name)}…" required></textarea><button type="submit">Balas</button></form>`
      : '';
    const voteForms = canReply
      ? `<form method="post" action="/p/${esc(postSlug)}/comment/vote" style="display:inline"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><input type="hidden" name="vote" value="1"><button type="submit">${mine === 1 ? '<b>👍 ' + v.like + '</b>' : '👍 ' + v.like}</button></form> <form method="post" action="/p/${esc(postSlug)}/comment/vote" style="display:inline"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><input type="hidden" name="vote" value="-1"><button type="submit">${mine === -1 ? '<b>👎 ' + v.dislike + '</b>' : '👎 ' + v.dislike}</button></form>`
      : `<span>👍 ${v.like} · 👎 ${v.dislike}</span>`;
    const kids = (byParent.get(String(c.id)) || []).map(k => renderOne(k, depth + 1)).join('');
    return `<div class="card" style="margin-left:${indent}px"><p><b>${esc(c.name)}</b></p><p>${esc(c.text)}</p><p>${voteForms}</p>${replyForm}${kids}</div>`;
  };
  // Komentar yang induknya sudah dihapus diperlakukan sebagai komentar utama,
  // supaya tidak hilang diam-diam.
  const roots = [...(byParent.get('root') || [])];
  for (const c of comments) {
    if (c.parent_id && !comments.some(p => p.id === c.parent_id) && !roots.includes(c)) roots.push(c);
  }
  return roots.map(c => renderOne(c, 0)).join('') || '<p>Belum ada komentar.</p>';
}
