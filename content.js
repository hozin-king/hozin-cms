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

export function postCard(post, plugins) {
  const meta = plugins.map(p => p.postMeta ? p.postMeta(post) : '').join('');
  // Cuplikan selalu dari teks polos (tag HTML post dibuang), jadi cuplikan
  // tidak pernah membocorkan markup. Jumlah tayang hanya logo mata + angka,
  // tanpa kata "dilihat" — sesuai permintaan pemilik.
  const plain = stripTags(post.body || '');
  const views = Number(post.views) || 0;
  return `<article class="card"><h2><a href="/p/${esc(post.slug)}">${esc(post.title)}</a></h2><p class="meta">${esc(post.category)} · ${esc(String(post.created_at || '').slice(0, 10))} · 👁 ${views}${meta}</p><p>${esc(plain.slice(0, 200))}${plain.length > 200 ? '…' : ''}</p></article>`;
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
