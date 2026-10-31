// Content WorkerCMS — visibilitas post, kartu post, dan pohon komentar.
import { esc, stripTags } from './util.js';
import { maskDirtyWords } from './plugins.js';

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
export function adBanner(adImage, adLink, adText, adsenseClient = '', adsenseSlot = '') {
  const img = typeof adImage === 'string' && adImage.startsWith('https://') ? adImage : '';
  const link = typeof adLink === 'string' && adLink.startsWith('https://') ? adLink : '';
  const manual = (img && link) ? `<div class="card" style="text-align:center"><p class="meta">Iklan</p><a href="${esc(link)}" target="_blank" rel="sponsored noopener"><img src="${esc(img)}" alt="${esc(adText || 'Iklan')}" loading="lazy" style="max-width:100%;height:auto;border-radius:12px"></a>${adText ? `<p>${esc(adText)}</p>` : ''}</div>` : '';
  // AdSense: hanya bila client valid (ca-pub-angka). Slot kosong = unit auto.
  // Iklan AdSense baru tampil setelah Google menyetujui situs; sebelum itu
  // slot ini bisa kosong — itu perilaku AdSense, bukan bug CMS.
  const client = typeof adsenseClient === 'string' && /^ca-pub-\d+$/.test(adsenseClient.trim()) ? adsenseClient.trim() : '';
  const slot = typeof adsenseSlot === 'string' && /^\d+$/.test(adsenseSlot.trim()) ? adsenseSlot.trim() : '';
  if (!client) return manual;
  const adsense = `<div class="card" style="text-align:center"><p class="meta">Iklan</p><script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${esc(client)}" crossorigin="anonymous"></script><ins class="adsbygoogle" style="display:block" data-ad-client="${esc(client)}"${slot ? ` data-ad-slot="${esc(slot)}"` : ''} data-ad-format="auto" data-full-width-responsive="true"></ins><script>(adsbygoogle = window.adsbygoogle || []).push({});</script></div>`;
  return adsense + manual;
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
    ? `<a href="/post/${esc(post.slug)}"><img class="post-cover" src="${esc(imgMatch[1])}" alt="" loading="lazy"></a>`
    : '';
  const editLink = isAdmin
    ? ` · <a href="/kendali/posts/edit?id=${esc(post.id)}">Edit</a>`
    : '';
  return `<article class="card">${cover}<h2><a href="/post/${esc(post.slug)}">${esc(post.title)}</a></h2><p class="meta">${esc(post.category)} · ${esc(String(post.created_at || '').slice(0, 10))} · ${viewEye(views)}${meta}</p><p>${esc(plain.slice(0, 200))}${plain.length > 200 ? '…' : ''}</p><p><a class="read-more" href="/post/${esc(post.slug)}">Selengkapnya →</a>${editLink}</p></article>`;
}

// Pohon komentar: balasan menempel di bawah induknya, indent dibatasi
// supaya tidak bergeser terlalu jauh di layar HP.
export function renderCommentsTree(comments, votes, myVotes, csrfField, canReply, postSlug, maskDirty = false, viewer = {}) {
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
      ? `<form method="post" action="/post/${esc(postSlug)}/comment" style="margin-top:8px"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="parent_id" value="${c.id}"><textarea name="text" maxlength="2000" placeholder="Balas ${esc(c.name)}…" required></textarea><button type="submit">Balas</button></form>`
      : '';
    // Ikon vote buatan sendiri (SVG, bukan emoji): jempol atas/bawah gaya
    // YouTube — angka Suka tampil, angka Tidak Suka DISEMBUNYIKAN (tetap
    // tercatat di database dan tombolnya tetap bisa dipakai).
    const thumbUp = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-3px"><path d="M1 21h4V9H1v12zM23 10c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>';
    const thumbDown = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-3px"><g transform="translate(0,24) scale(1,-1)"><path d="M1 21h4V9H1v12zM23 10c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></g></svg>';
    const voteForms = canReply
      ? `<form method="post" action="/post/${esc(postSlug)}/comment/vote" class="vote-form" style="display:inline"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><input type="hidden" name="vote" value="1"><button type="submit" data-vote="like" data-count="${v.like}" aria-label="Suka" aria-pressed="${mine === 1}">${thumbUp} <span>${v.like}</span></button></form> <form method="post" action="/post/${esc(postSlug)}/comment/vote" class="vote-form" style="display:inline"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><input type="hidden" name="vote" value="-1"><button type="submit" data-vote="dislike" aria-label="Tidak suka" aria-pressed="${mine === -1}">${thumbDown}</button></form>`
      : `<span>${thumbUp} ${v.like} · ${thumbDown}</span>`;
    const kids = (byParent.get(String(c.id)) || []).map(k => renderOne(k, depth + 1)).join('');
    const displayText = maskDirty ? maskDirtyWords(c.text) : c.text;
    const pinLabel = Number(c.pinned) === 1 ? '<p><b>📌 Disematkan</b></p>' : '';
    // Edit + hapus langsung dari halaman post, sesuai peran:
    // - Admin: komentar siapa pun (peran tertinggi).
    // - Komentator: hanya komentarnya sendiri.
    // - Pengunjung / komentator lain: tidak ada tombolnya sama sekali.
    // Edit komentator kembali pending; edit admin langsung tampil.
    const canManage = Boolean(viewer.isAdmin || (viewer.username && c.name === viewer.username));
    const editForm = canManage
      ? `<details><summary>Edit komentar</summary><form method="post" action="/post/${esc(postSlug)}/comment/edit"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><textarea name="text" maxlength="2000" required>${esc(c.text)}</textarea><button type="submit">Simpan Edit</button></form>${viewer.isAdmin ? '' : '<p>Komentar yang diedit kembali menunggu persetujuan admin.</p>'}</details>`
      : '';
    const deleteForm = canManage
      ? `<details><summary>Hapus komentar</summary><form method="post" action="/post/${esc(postSlug)}/comment/delete"><input type="hidden" name="csrf" value="${csrfField}"><input type="hidden" name="comment_id" value="${c.id}"><p>Komentar ini akan dihapus permanen.</p><button type="submit">Hapus Permanen</button></form></details>`
      : '';
    return `<div class="card" style="margin-left:${indent}px">${pinLabel}<p><b>${esc(c.name)}</b></p><p>${esc(displayText)}</p><p>${voteForms}</p>${editForm}${deleteForm}${replyForm}${kids}</div>`;
  };
  // Komentar yang induknya sudah dihapus diperlakukan sebagai komentar utama,
  // supaya tidak hilang diam-diam.
  const roots = [...(byParent.get('root') || [])];
  for (const c of comments) {
    if (c.parent_id && !comments.some(p => p.id === c.parent_id) && !roots.includes(c)) roots.push(c);
  }
  // Disematkan dulu (ala YouTube: 1 per post, paling atas), lalu terlama dulu.
  roots.sort((a, b) => (Number(b.pinned || 0) - Number(a.pinned || 0)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  // Vote TANPA reload: form vote dicegat JS, kirim fetch, angka Suka di-update
  // di tempat. Kalau JS mati / fetch gagal, form dikirim biasa (reload) —
  // jadi vote tidak pernah hilang gara-gara script ini.
  const voteScript = `<script>(function(){if(window.__cmsVoteAjax)return;window.__cmsVoteAjax=1;document.addEventListener('submit',async function(e){var f=e.target;if(!f.classList||!f.classList.contains('vote-form'))return;e.preventDefault();var btn=f.querySelector('button');if(!btn||btn.disabled)return;btn.disabled=true;try{var res=await fetch(f.action,{method:'POST',headers:{'X-Requested-With':'fetch'},body:new FormData(f)});if(!res.ok)throw new Error('vote gagal');var d=await res.json();var wrap=f.parentElement;var likeBtn=wrap&&wrap.querySelector('button[data-vote="like"]');var disBtn=wrap&&wrap.querySelector('button[data-vote="dislike"]');if(likeBtn){var sp=likeBtn.querySelector('span');if(sp)sp.textContent=d.like;likeBtn.setAttribute('data-count',d.like);likeBtn.setAttribute('aria-pressed',d.mine===1);}if(disBtn)disBtn.setAttribute('aria-pressed',d.mine===-1);}catch(err){f.submit();}finally{btn.disabled=false;}});})();<\/script>`;
  return (roots.map(c => renderOne(c, 0)).join('') || '<p>Belum ada komentar.</p>') + voteScript;
}
