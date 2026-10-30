// WorkerCMS — Worker Cloudflare (satu Worker, D1, tanpa build step selain esbuild untuk deploy).
// Modul: util.js (helper), auth.js (sesi + akun), security.js (rate limit),
// content.js (post + komentar), store.js (skema + backup + render),
// editor.js (editor post 3 mode), themes.js (tema), plugins.js (plugin).
// Fitur: post (buat/hapus dari admin), komentar (moderasi + balasan + vote),
// tema (ganti dari admin), plugin (aktif/nonaktif dari admin).
// KEAMANAN SATU ADMIN:
// - HANYA SATU admin: pemilik dengan ADMIN_TOKEN. TIDAK ADA akun editor, penulis, atau
//   pendaftar publik. TIDAK ADA endpoint publik untuk membuat post — post hanya lewat
//   POST /kendali/* dengan sesi admin + token CSRF. Pengunjung hanya bisa kirim komentar,
//   dan komentar itu pun pending sampai admin setujui.
// - Login di-rate-limit: 5x gagal dari satu IP dalam 15 menit -> diblokir sementara (429).
// - Semua aksi admin POST wajib membawa token CSRF yang terikat sesi (HMAC).
// - Backup: database kedua khusus jadi tempat backup CMS (bukan database live kedua).
//   Panel admin punya tombol "Buat Backup Sekarang" + riwayat backup.
// Admin: login pakai ADMIN_TOKEN (secret di Worker, BUKAN di kode ini, buat acak >=32 karakter,
//   jangan dibagikan, ganti segera bila bocor) -> sistem token ala video login:
//   token AKSES stateless HMAC 1 jam + token REFRESH opaque di D1 (hash SHA-256 saja
//   yang disimpan, token mentah tidak pernah disimpan) yang DIPUTAR tiap dipakai.
//   Tanpa "ingat saya": refresh 1 hari; dengan "ingat saya": refresh 30 hari.
//   Refresh lama yang sudah diputar lalu dipakai lagi = tanda pencurian -> semua
//   sesi dicabut. "Keluar dari Semua Perangkat" mencabut semua refresh token.
// Deploy: esbuild worker.js --bundle --format=esm, upload dengan binding D1 bernama DB + secret ADMIN_TOKEN.
// Catatan deploy root: Worker ini MENGGANTIKAN isi root bila di-route ke domain utama.
// Situs lama yang ada di root harus dipindah ke subdomain dulu bila root mau jadi CMS ini.
import { themes } from './themes.js';
import { pluginDefs } from './plugins.js';
import { esc, para, slugify, sanitizeHtml, html, redirect, parseCookies, clientIp, randomHex } from './util.js';
import { isAdmin, csrfToken, issueTokens, getRefreshRow, revokeAllRefresh, tryRefresh, redirectWithCookies, clearAuthCookies, hashPassword, verifyPassword, userCsrf, getCommenter, userSessionCookie, isPostUnlocked, postUnlockCookie } from './auth.js';
import { checkRateLimit } from './security.js';
import { isScheduled, visibilityLabel, postCard, renderCommentsTree, adBanner } from './content.js';
import { ensureSchema, getSetting, getEnabledPlugins, doBackup, renderPage, envSiteTitle } from './store.js';
import { editorCard } from './editor.js';


function adminNav(current) {
  const items = [['/kendali', 'Dashboard'], ['/kendali/posts', 'Post'], ['/kendali/posts/new', 'Post Baru'], ['/kendali/comments', 'Komentar'], ['/kendali/users', 'Akun'], ['/kendali/plugins', 'Plugin'], ['/kendali/settings', 'Pengaturan'], ['/kendali/sessions', 'Sesi'], ['/kendali/backup', 'Backup']];
  return '<nav style="display:flex;flex-wrap:wrap;gap:6px 12px;margin-bottom:16px">' + items.map(([href, label]) => '<a href="' + href + '"' + (href === current ? ' style="font-weight:800;text-decoration:underline"' : '') + '>' + label + '</a>').join('') + '</nav>';
}

export default {
  // Fallback anti-1101 (insiden 29 Okt 2026 20:28 WIB): bila D1 tidak bisa
  // diakses — mis. kuota baca harian gratis habis — JANGAN lempar exception
  // (Cloudflare mengubahnya jadi Error 1101 di semua halaman). Beranda tampil
  // statis, jalur lain dapat halaman 503 yang jelas. Begitu D1 bisa diakses
  // lagi (kuota reset tengah malam UTC = 07:00 WIB), semua kembali normal
  // tanpa redeploy, karena schemaReady di-reset saat gagal. Data tidak hilang:
  // ini hanya gagal baca, bukan gagal tulis.
  async fetch(request, env) {
    try {
      // Perpanjang sesi admin secara transparan: bila token akses sudah
      // kedaluwarsa tapi refresh masih sah, putar refresh dan teruskan request
      // dengan cookie baru. Login/logout dikecualikan karena mereka sendiri
      // yang mengelola token (rotasi di sini akan menimpa cookie hapus/login).
      // Jalur publik tidak disentuh supaya tidak membakar tulis D1 sia-sia.
      let req = request;
      let refreshedCookies = [];
      const u0 = new URL(request.url);
      if (u0.pathname.startsWith('/kendali') && u0.pathname !== '/kendali/login' && u0.pathname !== '/kendali/logout') {
        if (!(await isAdmin(request, env))) {
          const r = await tryRefresh(request, env);
          if (r) { req = r.request; refreshedCookies = r.cookies; }
        }
      }
      let res = await handleFetch(req, env);
      if (refreshedCookies.length) {
        const h = new Headers(res.headers);
        for (const c of refreshedCookies) h.append('set-cookie', c);
        res = new Response(res.body, { status: res.status, headers: h });
      }
      // Halaman admin tidak boleh di-cache browser / proxy (data sensitif).
      if (u0.pathname.startsWith('/kendali') || u0.pathname.startsWith('/akun')) {
        const h = new Headers(res.headers);
        h.set('cache-control', 'no-store');
        res = new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    } catch (e) {
      const theme = themes.terang;
      // Pengaman (failsafe) 29 Okt 2026 20:44 WIB (perintah pemilik):
      // bila database hilang atau error tak terduga apa pun terjadi, SELURUH
      // situs beralih ke halaman pemeliharaan berbahasa Inggris. Ini juga
      // pengaman keamanan: tidak ada detail internal (nama database, kuota,
      // jam reset, kode error) yang bocor ke pengunjung. Begitu database
      // bisa diakses lagi, halaman normal kembali otomatis tanpa redeploy,
      // karena fallback ini hanya berjalan saat request melempar error.
      // Riwayat koreksi: 20:42 catatan teknis dihapus dari beranda publik;
      // 20:43 semua error diubah jadi halaman pemeliharaan; 20:44 bahasanya
      // dijadikan Inggris dan berlaku untuk seluruh situs, termasuk beranda
      // (menggantikan fallback beranda statis sebelumnya).
      const maintenance = `<div class="card"><h2>Under Maintenance</h2><p>This site is currently under maintenance. We'll be back soon.</p><p>Please check back later.</p></div>`;
      return html(theme.render({ siteTitle: esc(envSiteTitle(env) || 'WorkerCMS'), pageTitle: 'Under Maintenance', content: maintenance }), 503);
    }
  },
};

async function handleFetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    let nowIso = new Date().toISOString();
    // Penjaga ukuran body: tolak POST raksasa sebelum dibaca penuh (anti
    // banjir POST). Batas 200 KB jauh di atas post/komentar normal.
    if (request.method === 'POST') {
      const cl = Number(request.headers.get('content-length') || '0');
      if (cl > 200000) {
        return html(themes.terang.render({ siteTitle: esc(envSiteTitle(env) || 'WorkerCMS'), pageTitle: 'Terlalu besar', content: '<div class="card"><p>Data yang dikirim terlalu besar (maks 200 KB).</p></div>' }), 413);
      }
    }
    await ensureSchema(env);
    // Hitung ulang waktu SETELAH schema: post sambutan yang baru dibuat
    // saat ensureSchema punya publish_at = waktu seed; kalau pakai waktu
    // awal request (beberapa ms lebih awal), post itu terfilter keluar
    // dari beranda di request pertamanya.
    nowIso = new Date().toISOString();
    const admin = await isAdmin(request, env);
    const commenter = admin ? null : await getCommenter(request, env);

    // ---- Publik: beranda (hanya post publik yang sudah terbit) ----
    if (request.method === 'GET' && path === '/') {
      // Anti overload: 10 post per halaman, ambil 11 untuk tahu ada halaman
      // berikutnya tanpa query COUNT tambahan. Tanpa batas ini, beranda
      // akan makin berat seiring post bertambah.
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
      const offset = (page - 1) * 10;
      // Percepat: query independen ini jalan barengan, bukan berurutan.
      const [rows, plugins, adImage, adLink, adText] = await Promise.all([
        env.DB.prepare(`SELECT * FROM cms_posts WHERE status = 'published' AND visibility = 'public' AND publish_at <= ? ORDER BY publish_at DESC LIMIT 11 OFFSET ?`).bind(nowIso, offset).all(),
        getEnabledPlugins(env),
        getSetting(env, 'ad_image', ''),
        getSetting(env, 'ad_link', ''),
        getSetting(env, 'ad_text', ''),
      ]);
      const allPosts = rows.results || [];
      const hasNext = allPosts.length > 10;
      const posts = allPosts.slice(0, 10);
      // Tombol melayang posting: hanya admin, kanan bawah. Sembunyi saat
      // di-scroll, muncul lagi 300 ms setelah scroll berhenti (debounce).
      // Diklik, langsung ke editor di dashboard (#post-baru).
      const fab = admin
        ? `<a href="/kendali/posts/new" class="fab" id="fabPost" aria-label="Buat post">+</a><script>(function(){var f=document.getElementById('fabPost');if(!f)return;var t=null;window.addEventListener('scroll',function(){f.classList.add('fab-hidden');if(t)clearTimeout(t);t=setTimeout(function(){f.classList.remove('fab-hidden')},300)},{passive:true})})();<\/script>`
        : '';
      const nav = (page > 1 ? `<p><a href="/?page=${page - 1}">← Post baru</a></p>` : '') + (hasNext ? `<p><a href="/?page=${page + 1}">Post lama →</a></p>` : '');
      const content = adBanner(adImage, adLink, adText) + (posts.length
        ? posts.map(p => postCard(p, plugins, admin)).join('')
        : '<div class="card"><p>Belum ada post.</p></div>') + nav + fab;
      return html(await renderPage(env, 'Beranda', content));
    }

    // ---- Post terkunci: buka kunci (rate-limit per IP + post) ----
    const unlockMatch = path.match(/^\/p\/([A-Za-z0-9-]+)\/unlock$/);
    if (unlockMatch && request.method === 'POST') {
      const slug = unlockMatch[1];
      const meta = await env.DB.prepare(`SELECT id, slug, visibility, publish_at, post_password_hash, post_password_salt FROM cms_posts WHERE slug = ?`).bind(slug).first();
      if (!meta || meta.visibility !== 'password') return redirect(`/p/${slug}`);
      const ip = clientIp(request);
      if (!(await checkRateLimit(env, 'unlock:' + ip + ':' + meta.id, 5, 15 * 60 * 1000))) {
        return html(await renderPage(env, 'Post Terkunci', '<div class="card"><p>Terlalu banyak percobaan. Coba lagi 15 menit.</p><p><a href="/p/' + esc(slug) + '">Kembali</a></p></div>'), 429);
      }
      const form = await request.formData();
      const pw = String(form.get('password') || '');
      const ok = meta.post_password_salt && meta.post_password_hash && await verifyPassword(pw, meta.post_password_salt, meta.post_password_hash);
      if (!ok) {
        return html(await renderPage(env, 'Post Terkunci', '<div class="card"><h2>Post Terkunci</h2><p>Password salah.</p><form method="post" action="/p/' + esc(slug) + '/unlock"><label>Password</label><input type="password" name="password" required><button type="submit">Buka</button></form></div>'), 403);
      }
      const cookie = await postUnlockCookie(env, meta.id);
      const headers = new Headers({ location: `/p/${slug}` });
      headers.append('set-cookie', cookie);
      return new Response(null, { status: 303, headers });
    }

    // ---- Publik: detail post + komentar (metadata dulu, body belakangan) ----
    const postMatch = path.match(/^\/p\/([A-Za-z0-9-]+)(?:\/comment)?$/);
    if (postMatch) {
      const slug = postMatch[1];
      if (request.method === 'GET') {
        // Langkah 1: metadata SAJA (tanpa judul, isi, kategori, tanggal).
        // Untuk post terkunci/private/terjadwal yang belum boleh dibuka, body
        // TIDAK PERNAH diambil dari DB, apalagi dikirim ke browser.
        const meta = await env.DB.prepare(`SELECT id, slug, visibility, publish_at, post_password_hash, post_password_salt FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (!meta) return html(await renderPage(env, 'Tidak ditemukan', '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
        const scheduled = isScheduled(meta, nowIso);
        if (meta.visibility === 'private' && !admin) return html(await renderPage(env, 'Tidak ditemukan', '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
        if (scheduled && !admin) return html(await renderPage(env, 'Tidak ditemukan', '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
        if (meta.visibility === 'password' && !admin && !(await isPostUnlocked(request, env, meta.id))) {
          // Halaman kunci generik: tanpa judul asli, tanpa isi, tanpa
          // komentar, tanpa post terkait — tidak ada yang bocor.
          const content = '<div class="card"><h2>Post Terkunci</h2><p>Post ini dilindungi password. Masukkan password untuk membukanya.</p><form method="post" action="/p/' + esc(slug) + '/unlock"><label>Password</label><input type="password" name="password" required><button type="submit">Buka</button></form></div>';
          return html(await renderPage(env, 'Post Terkunci', content));
        }
        // Langkah 2: baru sekarang body boleh diambil (sudah lolos semua gate).
        const post = await env.DB.prepare(`SELECT * FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (!post || post.status !== 'published') return html(await renderPage(env, 'Tidak ditemukan', '<div class="card"><p>Post tidak ditemukan.</p></div>'), 404);
        // Hitung tayang: hanya pengunjung (bukan admin), dan hanya sekali per
        // perangkat per hari (cookie) supaya refresh tidak menggelembungkan.
        let viewCookie = null;
        if (!admin) {
          const viewName = 'cms_view_' + String(post.id).replace(/[^A-Za-z0-9_-]/g, '_');
          if (!parseCookies(request)[viewName]) {
            await env.DB.prepare(`UPDATE cms_posts SET views = views + 1 WHERE id = ?`).bind(post.id).run();
            post.views = (Number(post.views) || 0) + 1;
            viewCookie = viewName + '=1; Path=/; Max-Age=86400';
          }
        }
        // Percepat: query independen detail post jalan barengan, bukan berurutan.
        const myKey = admin ? 'admin' : (commenter ? 'u:' + commenter.id : null);
        const [plugins, comments, rel, voteRows, myRows, adImage, adLink, adText] = await Promise.all([
          getEnabledPlugins(env),
          env.DB.prepare(`SELECT * FROM cms_comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at ASC`).bind(post.id).all(),
          env.DB.prepare(`SELECT * FROM cms_posts WHERE category = ? AND status = 'published' AND visibility = 'public' AND publish_at <= ? ORDER BY publish_at DESC`).bind(post.category, nowIso).all(),
          env.DB.prepare(`SELECT comment_id, vote, COUNT(*) AS n FROM cms_comment_votes GROUP BY comment_id, vote`).all(),
          myKey ? env.DB.prepare(`SELECT comment_id, vote FROM cms_comment_votes WHERE user_key = ?`).bind(myKey).all() : Promise.resolve({ results: [] }),
          getSetting(env, 'ad_image', ''),
          getSetting(env, 'ad_link', ''),
          getSetting(env, 'ad_text', ''),
        ]);
        const metaHtml = plugins.map(p => p.postMeta ? p.postMeta(post) : '').join('');
        const footers = plugins.map(p => p.postFooter ? p.postFooter(post, { related: rel.results || [], baseUrl: url.origin }) : '').join('');
        const notice = url.searchParams.get('komentar') === 'menunggu' ? '<div class="card"><p>Komentar dikirim, menunggu persetujuan admin.</p></div>' : '';
        const votes = new Map();
        for (const vr of (voteRows.results || [])) {
          const cur = votes.get(vr.comment_id) || { like: 0, dislike: 0 };
          if (Number(vr.vote) === 1) cur.like = Number(vr.n); else cur.dislike = Number(vr.n);
          votes.set(vr.comment_id, cur);
        }
        const myVotes = new Map();
        for (const mr of (myRows.results || [])) myVotes.set(mr.comment_id, Number(mr.vote));
        const canReply = Boolean(admin || commenter);
        const csrfForComment = admin ? await csrfToken(env) : (commenter ? await userCsrf(env, commenter.id) : '');
        const commentHtml = renderCommentsTree(comments.results || [], votes, myVotes, csrfForComment, canReply, slug);
        const commentForm = canReply
          ? `<form method="post" action="/p/${esc(slug)}/comment"><input type="hidden" name="csrf" value="${csrfForComment}"><label>Komentar sebagai ${admin ? 'Admin' : esc(commenter.username)}</label><textarea name="text" maxlength="2000" required></textarea><button type="submit">Kirim Komentar</button></form>`
          : `<div class="card"><p>Untuk berkomentar, login dulu atau buat akun.</p><p><a href="/akun">Login / Daftar Akun</a></p></div>`;
        const previewBanner = admin && (scheduled || meta.visibility !== 'public')
          ? `<div class="card"><p>Pratinjau admin: ${esc(visibilityLabel(post, nowIso))}${scheduled ? ' · terbit ' + esc(String(post.publish_at).slice(0, 16)) : ''}</p></div>`
          : '';
        const views = Number(post.views) || 0;
        const bodyHtml = post.body_mode === 'html' ? sanitizeHtml(post.body) : para(post.body);
        const content = `${previewBanner}<article class="card"><h2>${esc(post.title)}</h2><p class="meta">${esc(post.category)} · ${esc(String(post.created_at || '').slice(0, 10))} · 👁 ${views}${metaHtml}</p>${bodyHtml}</article>${adBanner(adImage, adLink, adText)}${footers}<h3>Komentar</h3>${commentHtml}${notice}${commentForm}`;
        const res = html(await renderPage(env, post.title, content));
        if (viewCookie) {
          const h = new Headers(res.headers);
          h.append('set-cookie', viewCookie);
          return new Response(res.body, { status: res.status, headers: h });
        }
        return res;
      }
      if (request.method === 'POST' && path.endsWith('/comment')) {
        // Komentar WAJIB akun (komentator atau admin). Tanpa akun -> ke /akun.
        if (!admin && !commenter) return redirect('/akun?pesan=login');
        const meta = await env.DB.prepare(`SELECT id, slug, visibility, publish_at FROM cms_posts WHERE slug = ?`).bind(slug).first();
        if (!meta) return redirect('/');
        if (meta.visibility === 'private' && !admin) return redirect('/');
        if (isScheduled(meta, nowIso) && !admin) return redirect('/');
        const form = await request.formData();
        // Honeypot anti-bot: kolom tersembunyi; kalau terisi, itu bot —
        // dibuang diam-diam tanpa disimpan.
        if (String(form.get('website') || '').trim()) return redirect(`/p/${slug}?komentar=menunggu`);
        const csrfNeed = admin ? await csrfToken(env) : await userCsrf(env, commenter.id);
        if (String(form.get('csrf') || '') !== csrfNeed) {
          return html(await renderPage(env, 'Komentar', '<div class="card"><p>Token tidak valid. Muat ulang halaman lalu coba lagi.</p></div>'), 403);
        }
        const ip = clientIp(request);
        if (!(await checkRateLimit(env, 'comment:' + ip, 5, 10 * 60 * 1000))) {
          return html(await renderPage(env, 'Komentar', '<div class="card"><p>Terlalu banyak komentar. Coba lagi beberapa menit.</p></div>'), 429);
        }
        const text = String(form.get('text') || '').trim().slice(0, 2000);
        const parentRaw = Number(form.get('parent_id') || 0);
        let parentId = null;
        if (parentRaw) {
          const parent = await env.DB.prepare(`SELECT id, post_id FROM cms_comments WHERE id = ?`).bind(parentRaw).first();
          if (parent && String(parent.post_id) === String(meta.id)) parentId = parentRaw;
        }
        if (text) {
          const name = admin ? 'Admin' : commenter.username;
          const status = admin ? 'approved' : 'pending';
          await env.DB.prepare(`INSERT INTO cms_comments (post_id, name, text, status, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?)`).bind(meta.id, name, text, status, new Date().toISOString(), parentId).run();
        }
        return redirect(`/p/${slug}?komentar=menunggu`);
      }
    }

    // ---- Like / dislike komentar (butuh akun, bisa batal / ganti) ----
    const voteMatch = path.match(/^\/p\/([A-Za-z0-9-]+)\/comment\/vote$/);
    if (voteMatch && request.method === 'POST') {
      const slug = voteMatch[1];
      if (!admin && !commenter) return redirect('/akun?pesan=login');
      const form = await request.formData();
      const csrfNeed = admin ? await csrfToken(env) : await userCsrf(env, commenter.id);
      if (String(form.get('csrf') || '') !== csrfNeed) {
        return html(await renderPage(env, 'Komentar', '<div class="card"><p>Token tidak valid.</p></div>'), 403);
      }
      const myKey = admin ? 'admin' : 'u:' + commenter.id;
      if (!(await checkRateLimit(env, 'vote:' + myKey, 30, 10 * 60 * 1000))) {
        return html(await renderPage(env, 'Komentar', '<div class="card"><p>Terlalu banyak vote. Coba lagi nanti.</p></div>'), 429);
      }
      const commentId = Number(form.get('comment_id') || 0);
      const vote = Number(form.get('vote') || 0);
      const meta = await env.DB.prepare(`SELECT id FROM cms_posts WHERE slug = ?`).bind(slug).first();
      const comment = commentId ? await env.DB.prepare(`SELECT id, post_id FROM cms_comments WHERE id = ?`).bind(commentId).first() : null;
      if (meta && comment && String(comment.post_id) === String(meta.id) && (vote === 1 || vote === -1)) {
        const existing = await env.DB.prepare(`SELECT vote FROM cms_comment_votes WHERE comment_id = ? AND user_key = ?`).bind(commentId, myKey).first();
        if (existing && Number(existing.vote) === vote) {
          await env.DB.prepare(`DELETE FROM cms_comment_votes WHERE comment_id = ? AND user_key = ?`).bind(commentId, myKey).run();
        } else if (existing) {
          await env.DB.prepare(`UPDATE cms_comment_votes SET vote = ? WHERE comment_id = ? AND user_key = ?`).bind(vote, commentId, myKey).run();
        } else {
          await env.DB.prepare(`INSERT INTO cms_comment_votes (comment_id, user_key, vote) VALUES (?, ?, ?)`).bind(commentId, myKey, vote).run();
        }
      }
      return redirect(`/p/${slug}`);
    }

    // ---- Akun komentator (BUKAN akun admin — hanya bisa komentar + vote) ----
    if (path === '/akun' && request.method === 'GET') {
      if (admin) {
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Kamu login sebagai Admin. Admin tidak perlu akun komentator.</p><p><a href="/kendali">Ke dashboard admin</a></p></div>'));
      }
      if (commenter) {
        return html(await renderPage(env, 'Akun', `<div class="card"><h2>Akun Saya</h2><p>Login sebagai <b>${esc(commenter.username)}</b>.</p><form method="post" action="/akun/logout"><button type="submit">Keluar</button></form></div>`));
      }
      const pesan = url.searchParams.get('pesan') === 'login' ? '<div class="card"><p>Login dulu atau buat akun untuk berkomentar.</p></div>' : '';
      // Halaman akun dibuat profesional dan tidak ramai: satu kartu sempit
      // di tengah, tab Login / Daftar (bukan dua kartu besar bertumpuk),
      // teks penjelasan dipersingkat jadi satu baris, checkbox Ingat saya
      // sebaris dengan labelnya (bukan melayang sendiri seperti sebelumnya).
      const content = `${pesan}<div class="card" style="max-width:440px;margin:0 auto"><div style="display:flex;gap:8px;margin-bottom:16px"><button type="button" id="tabLoginBtn" style="flex:1">Login</button><button type="button" id="tabDaftarBtn" style="flex:1;background:transparent;border:1px solid;color:inherit">Daftar</button></div><div id="loginForm"><h2 style="margin-top:0">Login</h2><form method="post" action="/akun/login"><label>Nama pengguna</label><input name="username" maxlength="20" required><label>Password</label><input type="password" name="password" required><label class="remember"><input type="checkbox" name="remember" value="1"> Ingat saya di perangkat ini</label><button type="submit" style="width:100%">Masuk</button></form><p style="text-align:center"><button type="button" id="toDaftarLink" style="background:none;border:0;color:inherit;text-decoration:underline;padding:0;font-weight:400">Belum punya akun? Daftar</button></p></div><div id="daftarForm" style="display:none"><h2 style="margin-top:0">Buat Akun</h2><p class="meta" style="text-transform:none;letter-spacing:0">Akun hanya untuk berkomentar dan like/dislike, bukan akun admin.</p><form method="post" action="/akun/daftar"><label>Nama pengguna</label><input name="username" maxlength="20" placeholder="huruf kecil, angka, _ , 3–20 karakter" required><label>Password (minimal 8 karakter)</label><input type="password" name="password" required><button type="submit" style="width:100%">Daftar</button></form><p style="text-align:center"><button type="button" id="toLoginLink" style="background:none;border:0;color:inherit;text-decoration:underline;padding:0;font-weight:400">Sudah punya akun? Login</button></p></div><script>(function(){var lb=document.getElementById('tabLoginBtn'),db=document.getElementById('tabDaftarBtn'),lf=document.getElementById('loginForm'),df=document.getElementById('daftarForm');function showLogin(){lf.style.display='block';df.style.display='none';lb.style.background='';lb.style.border='';lb.style.color='';db.style.background='transparent';db.style.border='1px solid';db.style.color='inherit'}function showDaftar(){lf.style.display='none';df.style.display='block';db.style.background='';db.style.border='';db.style.color='';lb.style.background='transparent';lb.style.border='1px solid';lb.style.color='inherit'}lb.onclick=showLogin;db.onclick=showDaftar;document.getElementById('toDaftarLink').onclick=showDaftar;document.getElementById('toLoginLink').onclick=showLogin;})();<\/script><noscript><style>#daftarForm{display:block!important}</style></noscript></div>`;
      return html(await renderPage(env, 'Akun', content));
    }
    if (path === '/akun/daftar' && request.method === 'POST') {
      const ip = clientIp(request);
      if (!(await checkRateLimit(env, 'akun:' + ip, 5, 15 * 60 * 1000))) {
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Terlalu banyak percobaan. Coba lagi 15 menit.</p></div>'), 429);
      }
      const form = await request.formData();
      const username = String(form.get('username') || '').trim().toLowerCase();
      const password = String(form.get('password') || '');
      if (!/^[a-z0-9_]{3,20}$/.test(username) || password.length < 8) {
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Nama pengguna atau password tidak valid. Nama: 3–20 karakter (huruf kecil, angka, _). Password: minimal 8 karakter.</p><p><a href="/akun">Kembali</a></p></div>'), 400);
      }
      // Nama 'admin' dicadangkan untuk deteksi admin di form login biasa:
      // tidak boleh didaftarkan sebagai akun komentator, supaya tidak ada
      // akun komentator yang menyamar jadi admin. Pesan disamakan dengan
      // nama sudah dipakai, supaya tidak bocor mana nama yang dicadangkan.
      if (username === 'admin') {
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Nama pengguna sudah dipakai.</p><p><a href="/akun">Kembali</a></p></div>'), 409);
      }
      const clash = await env.DB.prepare(`SELECT id FROM cms_users WHERE username = ?`).bind(username).first();
      if (clash) {
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Nama pengguna sudah dipakai.</p><p><a href="/akun">Kembali</a></p></div>'), 409);
      }
      const salt = randomHex(16);
      const hash = await hashPassword(password, salt);
      const id = 'u-' + Date.now().toString(36);
      await env.DB.prepare(`INSERT INTO cms_users (id, username, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)`).bind(id, username, hash, salt, new Date().toISOString()).run();
      const cookie = await userSessionCookie(env, id);
      const headers = new Headers({ location: '/' });
      headers.append('set-cookie', cookie);
      return new Response(null, { status: 303, headers });
    }
    if (path === '/akun/login' && request.method === 'POST') {
      const ip = clientIp(request);
      const form = await request.formData();
      const username = String(form.get('username') || '').trim().toLowerCase();
      const password = String(form.get('password') || '');
      // Login terpadu (perintah pemilik 30 Okt 2026): form ini tampak biasa
      // untuk semua orang, tapi bila nama 'admin' + token admin cocok,
      // sesi langsung naik jadi super-super-admin dan dialihkan ke
      // dashboard /kendali, dengan tampilan dan akses penuh admin.
      // Keamanan TIDAK turun: token admin tetap secret Worker, rate-limit
      // gagal admin 5/IP/15 menit tetap jalan, dan pesan gagal disamakan
      // dengan gagal komentator supaya tidak bocor akun mana yang admin.
      // Jalur admin TIDAK memakai rate-limit akun, supaya login komentator
      // yang sah tidak ikut memblokir login admin dari IP yang sama.
      if (username === 'admin') {
        const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const fails = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cms_login_attempts WHERE ip = ? AND created_at > ?`).bind(ip, since).first();
        if (fails && Number(fails.n) >= 5) {
          return html(await renderPage(env, 'Akun', '<div class="card"><p>Nama pengguna atau password salah.</p><p><a href="/akun">Kembali</a></p></div>'), 403);
        }
        if (env.ADMIN_TOKEN && password === env.ADMIN_TOKEN) {
          await env.DB.prepare(`DELETE FROM cms_login_attempts WHERE ip = ?`).bind(ip).run();
          const remember = form.get('remember') === '1';
          const cookies = await issueTokens(env, request, remember);
          return redirectWithCookies('/kendali', [...cookies, 'cms_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0']);
        }
        await env.DB.prepare(`INSERT INTO cms_login_attempts (ip, created_at) VALUES (?, ?)`).bind(ip, new Date().toISOString()).run();
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Nama pengguna atau password salah.</p><p><a href="/akun">Kembali</a></p></div>'), 403);
      }
      if (!(await checkRateLimit(env, 'akun:' + ip, 5, 15 * 60 * 1000))) {
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Terlalu banyak percobaan. Coba lagi 15 menit.</p></div>'), 429);
      }
      const user = await env.DB.prepare(`SELECT * FROM cms_users WHERE username = ?`).bind(username).first();
      const ok = user && await verifyPassword(password, user.salt, user.password_hash);
      if (!ok) {
        return html(await renderPage(env, 'Akun', '<div class="card"><p>Nama pengguna atau password salah.</p><p><a href="/akun">Kembali</a></p></div>'), 403);
      }
      const cookie = await userSessionCookie(env, user.id);
      const headers = new Headers({ location: '/' });
      headers.append('set-cookie', cookie);
      return new Response(null, { status: 303, headers });
    }
    if (path === '/akun/logout' && request.method === 'POST') {
      const headers = new Headers({ location: '/' });
      headers.append('set-cookie', 'cms_user=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return new Response(null, { status: 303, headers });
    }

    // ---- Admin: logout (login admin sudah pindah ke form biasa /akun/login,
    // jadi tidak ada lagi form login admin terpisah di /kendali/login) ----
    if (path === '/kendali/logout' && request.method === 'POST') {
      const form = await request.formData();
      if (String(form.get('csrf') || '') !== await csrfToken(env)) {
        return html(await renderPage(env, 'Admin', '<div class="card"><p>Token CSRF tidak valid.</p></div>'), 403);
      }
      // Logout tidak digate admin: token akses bisa saja sudah kedaluwarsa
      // saat tombol ditekan; yang dicabut adalah refresh perangkat ini.
      const row = await getRefreshRow(request, env);
      if (row) await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1 WHERE id = ?`).bind(row.id).run();
      return redirectWithCookies('/kendali', clearAuthCookies());
    }

    // ---- Admin: halaman-halaman terpisah (bukan satu halaman mega) ----
    // Logika: tiap urusan punya halamannya sendiri, supaya menulis post
    // tidak harus melewati Backup, Sesi, Pengaturan, Komentar, dan Plugin.
    // /kendali = ringkasan + navigasi saja. Post Baru = /kendali/posts/new.
    if (admin && request.method === 'GET' && (path === '/kendali' || path === '/kendali/posts' || path === '/kendali/posts/new' || path === '/kendali/comments' || path === '/kendali/users' || path === '/kendali/plugins' || path === '/kendali/settings' || path === '/kendali/sessions' || path === '/kendali/backup')) {
      const csrf = await csrfToken(env);
      const csrfField = `<input type="hidden" name="csrf" value="${csrf}">`;
      const nav = adminNav(path);
      if (path === '/kendali') {
        const [posts, comments, users, pluginRows] = await Promise.all([
          env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at DESC`).all(),
          env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at DESC`).all(),
          env.DB.prepare(`SELECT * FROM cms_users ORDER BY created_at DESC`).all(),
          env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all(),
        ]);
        const pending = (comments.results || []).filter(c => c.status !== 'approved').length;
        const activePlugins = (pluginRows.results || []).filter(r => Number(r.enabled) === 1).length;
        const content = `<h2>Dashboard Admin</h2><p>Peran: <b>Super-Super-Admin (satu-satunya)</b> — tidak ada akun admin lain. Akun komentator di bawah bukan akun admin.</p>${nav}<div class="card"><p><b>${(posts.results || []).length} Post</b> · <a href="/kendali/posts">Lihat Post</a> · <a href="/kendali/posts/new">Post Baru</a></p><p><b>${pending} Komentar menunggu</b> · <a href="/kendali/comments">Moderasi Komentar</a></p><p><b>${(users.results || []).length} Akun komentator</b> · <a href="/kendali/users">Lihat Akun</a></p><p><b>${activePlugins} Plugin aktif</b> · <a href="/kendali/plugins">Lihat Plugin</a></p></div><form method="post" action="/kendali/logout">${csrfField}<button type="submit">Keluar</button></form>`;
        return html(await renderPage(env, 'Admin', content));
      }
      if (path === '/kendali/posts') {
        const posts = await env.DB.prepare(`SELECT * FROM cms_posts ORDER BY created_at DESC`).all();
        const postRows = (posts.results || []).map(p => `<div class="card"><b>${esc(p.title)}</b> (${esc(visibilityLabel(p, new Date().toISOString()))} · 👁 ${Number(p.views) || 0} · ${esc(p.body_mode || 'text')}) <a href="/kendali/posts/edit?id=${esc(p.id)}">Edit</a> <form method="post" action="/kendali/posts/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(p.id)}"><button type="submit">Hapus</button></form></div>`).join('') || '<p>Belum ada post.</p>';
        const content = `<h2>Post</h2>${nav}<p><a href="/kendali/posts/new">+ Post Baru</a></p>${postRows}`;
        return html(await renderPage(env, 'Post', content));
      }
      if (path === '/kendali/posts/new') {
        const postError = url.searchParams.get('error') === 'password' ? '<div class="card"><p>Password post minimal 8 karakter, post tidak dibuat.</p></div>' : '';
        const content = `<h2>Post Baru</h2>${nav}${postError}` + editorCard(csrfField);
        return html(await renderPage(env, 'Post Baru', content));
      }
      if (path === '/kendali/comments') {
        const comments = await env.DB.prepare(`SELECT * FROM cms_comments ORDER BY created_at DESC`).all();
        const commentRows = (comments.results || []).map(c => `<div class="card"><b>${esc(c.name)}</b> [${esc(c.status)}]<p>${esc(c.text)}</p><form method="post" action="/kendali/comments/approve" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Setujui</button></form> <form method="post" action="/kendali/comments/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${c.id}"><button type="submit">Hapus</button></form></div>`).join('') || '<p>Belum ada komentar.</p>';
        const content = `<h2>Komentar</h2>${nav}${commentRows}`;
        return html(await renderPage(env, 'Komentar', content));
      }
      if (path === '/kendali/users') {
        const users = await env.DB.prepare(`SELECT * FROM cms_users ORDER BY created_at DESC`).all();
        const userRows = (users.results || []).map(u => `<div class="card"><b>${esc(u.username)}</b> · sejak ${esc(String(u.created_at || '').slice(0, 10))}<form method="post" action="/kendali/users/delete" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(u.id)}"><button type="submit">Hapus Akun</button></form></div>`).join('') || '<p>Belum ada akun komentator.</p>';
        const content = `<h2>Akun Komentator</h2>${nav}${userRows}`;
        return html(await renderPage(env, 'Akun Komentator', content));
      }
      if (path === '/kendali/plugins') {
        const pluginRows = await env.DB.prepare(`SELECT id, enabled FROM cms_plugins`).all();
        const pMap = new Map((pluginRows.results || []).map(r => [r.id, Number(r.enabled)]));
        const pluginForms = pluginDefs.map(p => `<div class="card"><b>${esc(p.name)}</b> — ${esc(p.description)}<form method="post" action="/kendali/plugins/toggle">${csrfField}<input type="hidden" name="id" value="${p.id}"><input type="hidden" name="enabled" value="${pMap.get(p.id) === 0 ? '1' : '0'}"><button type="submit">${pMap.get(p.id) === 0 ? 'Aktifkan' : 'Nonaktifkan'}</button></form></div>`).join('');
        const content = `<h2>Plugin</h2>${nav}${pluginForms}`;
        return html(await renderPage(env, 'Plugin', content));
      }
      if (path === '/kendali/settings') {
        const envTitle = envSiteTitle(env);
        const [themeId, siteTitleDb, siteAvatar, adImage, adLink, adText] = await Promise.all([
          getSetting(env, 'theme', 'terang'),
          envTitle ? Promise.resolve('') : getSetting(env, 'site_title', 'WorkerCMS'),
          getSetting(env, 'site_avatar', ''),
          getSetting(env, 'ad_image', ''),
          getSetting(env, 'ad_link', ''),
          getSetting(env, 'ad_text', ''),
        ]);
        const siteTitle = envTitle || siteTitleDb;
        const themeOptions = Object.entries(themes).map(([id, t]) => `<option value="${id}" ${id === themeId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
        const content = `<h2>Pengaturan</h2>${nav}<div class="card">${envTitle ? '<p>Judul yang tampil saat ini diatur dari variabel Worker (SITE_TITLE), bukan dari kolom ini — mengubah kolom ini tidak akan mengubah header sampai variabel itu dihapus.</p>' : ''}<form method="post" action="/kendali/settings">${csrfField}<label>Judul situs</label><input name="site_title" value="${esc(siteTitle)}"><label>Tema</label><select name="theme">${themeOptions}</select><label>Foto profil situs (link gambar https://…, kosong = tidak tampil)</label><input name="site_avatar" value="${esc(siteAvatar)}" placeholder="https://…"><label>Iklan: gambar banner (link https://…, kosong = iklan tidak tampil)</label><input name="ad_image" value="${esc(adImage)}" placeholder="https://…"><label>Iklan: link tujuan (https://…)</label><input name="ad_link" value="${esc(adLink)}" placeholder="https://…"><label>Iklan: teks (opsional)</label><input name="ad_text" value="${esc(adText)}"><button type="submit">Simpan Pengaturan</button></form></div>`;
        return html(await renderPage(env, 'Pengaturan', content, { siteTitle, themeId }));
      }
      if (path === '/kendali/sessions') {
        const dashNowIso = new Date().toISOString();
        const [sessionRows, currentRefresh] = await Promise.all([
          env.DB.prepare(`SELECT id, device, ip, created_at, last_used_at, expires_at FROM cms_refresh_tokens WHERE revoked = 0 AND expires_at > ? ORDER BY last_used_at DESC`).bind(dashNowIso).all(),
          getRefreshRow(request, env),
        ]);
        const sessionRowsHtml = (sessionRows.results || []).map(s => `<div class="card"><b>${esc(s.device || 'Perangkat')}</b> · ${esc(s.ip)} · terakhir ${esc(s.last_used_at)} · sampai ${esc(s.expires_at)}${currentRefresh && s.id === currentRefresh.id ? ' · <b>(perangkat ini)</b>' : ''}<form method="post" action="/kendali/sessions/revoke" style="display:inline">${csrfField}<input type="hidden" name="id" value="${esc(s.id)}"><button type="submit">Cabut</button></form></div>`).join('') || '<p>Tidak ada sesi aktif.</p>';
        const content = `<h2>Sesi & Perangkat</h2>${nav}<div class="card"><p>Token akses berlaku 1 jam, diperpanjang otomatis oleh token refresh. Refresh yang sudah diputar lalu dipakai lagi akan mencabut semua sesi (tanda token dicuri).</p><form method="post" action="/kendali/logout-all">${csrfField}<button type="submit">Keluar dari Semua Perangkat</button></form><h4>Sesi aktif</h4>${sessionRowsHtml}</div>`;
        return html(await renderPage(env, 'Sesi & Perangkat', content));
      }
      if (path === '/kendali/backup') {
        const backupRuns = await env.DB.prepare(`SELECT * FROM cms_backup_runs ORDER BY created_at DESC LIMIT 10`).all();
        const backupRows = (backupRuns.results || []).map(r => `<div class="card"><b>${esc(r.status)}</b> · ${esc(r.created_at)} · ${r.posts} post, ${r.comments} komentar${r.error ? `<p>Error: ${esc(r.error)}</p>` : ''}</div>`).join('') || '<p>Belum ada backup.</p>';
        const content = `<h2>Backup</h2>${nav}<div class="card"><h3>Backup ke Stopwatch</h3><p>Database stopwatch khusus dipakai sebagai tempat backup CMS. Salinan tidak pernah ditulis dari jalur lain — hanya tombol ini yang menulis ke sana.</p><form method="post" action="/kendali/backup">${csrfField}<button type="submit">Buat Backup Sekarang</button></form><h4>Riwayat Backup</h4>${backupRows}</div>`;
        return html(await renderPage(env, 'Backup', content));
      }
    }
    if (path === '/kendali' || path.startsWith('/kendali/')) {
      if (request.method === 'GET' && !admin) {
        return redirect('/akun?pesan=login');
      }
      // Halaman edit ada di bawah blok ini, jangan dialihkan duluan.
      if (request.method === 'GET' && admin && path !== '/kendali/posts/edit') {
        return redirect('/kendali');
      }
    }

    // ---- Admin: halaman edit post (prefilled, slug tetap saat disimpan) ----
    if (admin && request.method === 'GET' && path === '/kendali/posts/edit') {
      const id = url.searchParams.get('id') || '';
      const post = id ? await env.DB.prepare(`SELECT * FROM cms_posts WHERE id = ?`).bind(id).first() : null;
      if (!post) return redirect('/kendali/posts');
      const csrf = await csrfToken(env);
      const csrfField = `<input type="hidden" name="csrf" value="${csrf}">`;
      const editError = url.searchParams.get('error') === 'password' ? '<div class="card"><p>Password post minimal 8 karakter, perubahan tidak disimpan.</p></div>' : '';
      const content = editError + `<p><a href="/kendali/posts">← Kembali ke Post</a> · <a href="/kendali">Dashboard</a> · <a href="/p/${esc(post.slug)}">Lihat post</a></p>` + editorCard(csrfField, { post, action: '/kendali/posts/update' });
      return html(await renderPage(env, 'Edit Post', content));
    }

    // ---- Admin: aksi (butuh login + CSRF) ----
    if (admin && request.method === 'POST') {
      const form = await request.formData();
      if (String(form.get('csrf') || '') !== await csrfToken(env)) {
        return html(await renderPage(env, 'Admin', '<div class="card"><p>Token CSRF tidak valid. Muat ulang dashboard lalu coba lagi.</p></div>'), 403);
      }
      if (path === '/kendali/backup') {
        const now = new Date().toISOString();
        try {
          const counts = await doBackup(env);
          await env.DB.prepare(`INSERT INTO cms_backup_runs (created_at, status, posts, comments, error) VALUES (?, 'BERHASIL', ?, ?, '')`).bind(now, counts.posts, counts.comments).run();
        } catch (e) {
          await env.DB.prepare(`INSERT INTO cms_backup_runs (created_at, status, posts, comments, error) VALUES (?, 'GAGAL', 0, 0, ?)`).bind(now, String(e && e.message ? e.message : e).slice(0, 300)).run();
        }
        return redirect('/kendali/backup');
      }
      if (path === '/kendali/logout-all') {
        await revokeAllRefresh(env);
        return redirectWithCookies('/kendali', clearAuthCookies());
      }
      if (path === '/kendali/sessions/revoke') {
        const id = String(form.get('id') || '');
        const current = await getRefreshRow(request, env);
        await env.DB.prepare(`UPDATE cms_refresh_tokens SET revoked = 1 WHERE id = ?`).bind(id).run();
        if (current && current.id === id) return redirectWithCookies('/kendali', clearAuthCookies());
        return redirect('/kendali/sessions');
      }
      if (path === '/kendali/settings') {
        const siteTitle = String(form.get('site_title') || '').trim().slice(0, 100) || 'WorkerCMS';
        const theme = String(form.get('theme') || 'terang');
        // Foto profil + iklan: hanya link https yang disimpan, sisanya
        // dibersihkan jadi kosong supaya tidak ada skema aneh yang tampil.
        const cleanUrl = v => {
          const s = String(v || '').trim().slice(0, 500);
          return s.startsWith('https://') && !/["'<\s]/.test(s) ? s : '';
        };
        const siteAvatar = cleanUrl(form.get('site_avatar'));
        const adImage = cleanUrl(form.get('ad_image'));
        const adLink = cleanUrl(form.get('ad_link'));
        const adText = String(form.get('ad_text') || '').trim().slice(0, 100);
        if (themes[theme]) {
          await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('site_title', ?)`).bind(siteTitle).run();
          await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('theme', ?)`).bind(theme).run();
        }
        await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('site_avatar', ?)`).bind(siteAvatar).run();
        await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('ad_image', ?)`).bind(adImage).run();
        await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('ad_link', ?)`).bind(adLink).run();
        await env.DB.prepare(`INSERT OR REPLACE INTO cms_settings (key, value) VALUES ('ad_text', ?)`).bind(adText).run();
        return redirect('/kendali/settings');
      }
      if (path === '/kendali/posts') {
        const title = String(form.get('title') || '').trim().slice(0, 200);
        let body = String(form.get('body') || '').trim();
        const category = String(form.get('category') || 'Umum').trim().slice(0, 80) || 'Umum';
        const bodyMode = String(form.get('body_mode') || 'text') === 'html' ? 'html' : 'text';
        const visibilityRaw = String(form.get('visibility') || 'public');
        const visibility = ['public', 'private', 'unlisted', 'password'].includes(visibilityRaw) ? visibilityRaw : 'public';
        const now = new Date().toISOString();
        let publishAt = now;
        const publishRaw = String(form.get('publish_at_iso') || form.get('publish_at') || '');
        if (publishRaw) {
          const d = new Date(publishRaw);
          if (!isNaN(d.getTime())) publishAt = d.toISOString();
        }
        let pwHash = '';
        let pwSalt = '';
        if (visibility === 'password') {
          const pw = String(form.get('post_password') || '');
          if (pw.length < 8) return redirect('/kendali/posts/new?error=password');
          pwSalt = randomHex(16);
          pwHash = await hashPassword(pw, pwSalt);
        }
        if (bodyMode === 'html') body = sanitizeHtml(body).slice(0, 100000);
        else body = body.slice(0, 50000);
        if (title && body) {
          const id = 'p-' + Date.now().toString(36);
          let slug = slugify(title);
          const clash = await env.DB.prepare(`SELECT id FROM cms_posts WHERE slug = ?`).bind(slug).first();
          if (clash) slug = slug + '-' + Date.now().toString(36).slice(-4);
          await env.DB.prepare(`INSERT INTO cms_posts (id, slug, title, body, category, status, created_at, updated_at, body_mode, visibility, publish_at, post_password_hash, post_password_salt, views) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, 0)`).bind(id, slug, title, body, category, now, now, bodyMode, visibility, publishAt, pwHash, pwSalt).run();
        }
        return redirect('/kendali/posts');
      }
      if (path === '/kendali/posts/update') {
        const postId = String(form.get('id') || '');
        const old = postId ? await env.DB.prepare(`SELECT * FROM cms_posts WHERE id = ?`).bind(postId).first() : null;
        if (!old) return redirect('/kendali/posts');
        const title = String(form.get('title') || '').trim().slice(0, 200);
        let body = String(form.get('body') || '').trim();
        const category = String(form.get('category') || 'Umum').trim().slice(0, 80) || 'Umum';
        const bodyMode = String(form.get('body_mode') || 'text') === 'html' ? 'html' : 'text';
        const visibilityRaw = String(form.get('visibility') || 'public');
        const visibility = ['public', 'private', 'unlisted', 'password'].includes(visibilityRaw) ? visibilityRaw : 'public';
        const now = new Date().toISOString();
        let publishAt = old.publish_at || now;
        const publishRaw = String(form.get('publish_at_iso') || form.get('publish_at') || '');
        if (publishRaw) {
          const d = new Date(publishRaw);
          if (!isNaN(d.getTime())) publishAt = d.toISOString();
        }
        // Password: kosong = pakai lama, isi baru (>=8) = ganti, isi pendek = tolak.
        // Keluar dari password = hapus hash/salt lama. Slug TIDAK diubah,
        // supaya link lama ke post ini tidak putus.
        let pwHash = old.post_password_hash || '';
        let pwSalt = old.post_password_salt || '';
        if (visibility === 'password') {
          const pw = String(form.get('post_password') || '');
          if (pw) {
            if (pw.length < 8) return redirect('/kendali/posts/edit?id=' + postId + '&error=password');
            pwSalt = randomHex(16);
            pwHash = await hashPassword(pw, pwSalt);
          }
        } else {
          pwHash = '';
          pwSalt = '';
        }
        if (bodyMode === 'html') body = sanitizeHtml(body).slice(0, 100000);
        else body = body.slice(0, 50000);
        if (title && body) {
          await env.DB.prepare(`UPDATE cms_posts SET title = ?, body = ?, category = ?, updated_at = ?, body_mode = ?, visibility = ?, publish_at = ?, post_password_hash = ?, post_password_salt = ? WHERE id = ?`).bind(title, body, category, now, bodyMode, visibility, publishAt, pwHash, pwSalt, postId).run();
        }
        return redirect('/kendali/posts');
      }
      if (path === '/kendali/users/delete') {
        await env.DB.prepare(`DELETE FROM cms_users WHERE id = ?`).bind(String(form.get('id') || '')).run();
        return redirect('/kendali/users');
      }
      if (path === '/kendali/posts/delete') {
        const postId = String(form.get('id') || '');
        const cmts = await env.DB.prepare(`SELECT id FROM cms_comments WHERE post_id = ?`).bind(postId).all();
        for (const cm of (cmts.results || [])) {
          await env.DB.prepare(`DELETE FROM cms_comment_votes WHERE comment_id = ?`).bind(cm.id).run();
        }
        await env.DB.prepare(`DELETE FROM cms_comments WHERE post_id = ?`).bind(postId).run();
        await env.DB.prepare(`DELETE FROM cms_posts WHERE id = ?`).bind(postId).run();
        return redirect('/kendali/posts');
      }
      if (path === '/kendali/comments/approve') {
        await env.DB.prepare(`UPDATE cms_comments SET status = 'approved' WHERE id = ?`).bind(Number(form.get('id'))).run();
        return redirect('/kendali/comments');
      }
      if (path === '/kendali/comments/delete') {
        const cid = Number(form.get('id'));
        await env.DB.prepare(`DELETE FROM cms_comment_votes WHERE comment_id = ?`).bind(cid).run();
        await env.DB.prepare(`DELETE FROM cms_comments WHERE id = ?`).bind(cid).run();
        return redirect('/kendali/comments');
      }
      if (path === '/kendali/plugins/toggle') {
        const id = String(form.get('id') || '');
        if (pluginDefs.some(p => p.id === id)) {
          await env.DB.prepare(`UPDATE cms_plugins SET enabled = ? WHERE id = ?`).bind(Number(form.get('enabled')) ? 1 : 0, id).run();
        }
        return redirect('/kendali/plugins');
      }
    }
    // Jalur /admin lama sudah pensiun: siapa pun yang menebak /admin atau
    // /admin/* dialihkan ke form login biasa /akun, bukan ke form admin.
    if (path === '/admin' || path.startsWith('/admin/')) {
      return redirect('/akun');
    }
    if (path.startsWith('/kendali')) {
      return redirect('/akun?pesan=login');
    }
    return html(await renderPage(env, 'Tidak ditemukan', '<div class="card"><p>Halaman tidak ditemukan.</p></div>'), 404);
}
