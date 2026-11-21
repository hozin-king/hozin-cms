// Util WorkerCMS — escape, sanitasi HTML, cookie, hash, dan helper HTTP.
// Dipakai auth.js, content.js, store.js, dan worker.js. Tanpa dependensi D1.

export function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
// Bandingkan string tanpa early-exit (tahan orakel timing), untuk HMAC /
// token / CSRF. Panjang berbeda -> false (bukan kebocoran panjang, karena
// panjang HMAC hex selalu tetap 64).
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// Escape wildcard LIKE (dipakai dengan ESCAPE '!'): '%'/'_' di input
// pencarian admin tidak boleh berfungsi sebagai wildcard.
export function escapeLikeTerm(t) {
  return String(t ?? '').replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}
export function para(text) {
  return esc(text).split(/\n\s*\n/).map(p => `<p>${p.replaceAll('\n', '<br>')}</p>`).join('');
}
export function slugify(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'post';
}
// Tag post: disimpan sebagai satu string dipisah koma di kolom cms_posts.tags.
// Normalisasi: potong spasi, buang yang kosong/terlalu panjang, dedup
// (tak peduli huruf besar-kecil, pertahankan ejaan pertama), maks 10 tag.
export function parseTags(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const t = part.trim();
    if (!t || t.length > 30) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}
export function tagSlug(tag) {
  return slugify(tag);
}
export function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    // CSP: skrip/style inline diizinkan karena tema + editor blok memakai
    // skrip inline (footer uptime, editor). Yang dilarang keras: objek/embed
    // (Flash/Java), frame dari luar (clickjacking sudah DENY juga), form ke
    // luar situs, dan gambar hanya dari situs sendiri / https / data.
    'content-security-policy': "default-src 'self'; img-src 'self' https: data:; media-src 'self' https:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    ...headers,
  } });
}
export function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}
export async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// Baca body request dengan batas (streaming, tanpa buffer penuh):
// kembalikan Uint8Array bila total <= maxBytes, null bila melampaui.
// Dipakai saat Content-Length tidak ada / tidak bisa dipercaya —
// membaca lewat stream lalu membatalkan (cancel) begitu batas terlampaui,
// jadi body besar tidak pernah dibaca penuh ke memori sebelum limit
// diterapkan. Dipakai handleFetch di worker.js sebelum formData()/text().
export async function readCappedBody(request, maxBytes) {
  const stream = request.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) return null;
        chunks.push(value);
      }
    }
  } finally {
    try { await reader.cancel(); } catch (e) {}
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// Sisip video dari URL (editor ala Blogspot): YouTube / Vimeo -> iframe embed
// kanonis, file video langsung (.mp4/.webm/.mov) -> <video>. Selain itu null
// (URL ditolak editor, dan iframe-nya dibuang sanitasi). ID YouTube harus
// tepat 11 karakter; parameter lain (mis. ?t=) dibuang demi URL kanonis.
export function videoEmbedUrl(u) {
  const raw = String(u || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch (e) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const ytId = (() => {
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'www.youtube-nocookie.com') {
      if (url.pathname === '/watch') {
        const id = url.searchParams.get('v') || '';
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      const m = url.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
      return m ? m[2] : null;
    }
    return null;
  })();
  if (ytId) return { kind: 'youtube', embed: 'https://www.youtube-nocookie.com/embed/' + ytId, id: ytId };
  if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
    const m = url.pathname.match(/^\/(?:video\/)?(\d+)(?:\/|$)/);
    if (m) return { kind: 'vimeo', embed: 'https://player.vimeo.com/video/' + m[1], id: m[1] };
  }
  const path = url.pathname.toLowerCase();
  // File video langsung: HANYA https (http = mixed content di halaman HTTPS).
  if (/\.(mp4|webm|mov)$/.test(path)) return url.protocol === 'https:' ? { kind: 'file', embed: raw, id: '' } : null;
  return null;
}
export function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '');
}
// Sanitasi HTML mode (editor HTML / blok): daftar putih tag + atribut saja.
// Yang dibuang total: script/style/iframe/object/embed/form dan isinya,
// komentar HTML, semua atribut on* (onclick dsb), style, dan URL
// javascript:/data:/vbscript:. Tag di luar daftar putih dibuang tapi teks
// di dalamnya dipertahankan, jadi tidak ada markup jahat yang lolos ke
// pengunjung. Disimpan sudah bersih, dan saat render dibersihkan sekali
// lagi (defense in depth) — jadi baris lama di DB pun tidak bisa menyisip
// skrip. Catatan jujur: sanitasi regex bukan parser HTML penuh; untuk
// situs satu admin ini cukup, dan post hanya bisa dibuat admin yang login.
export const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'br', 'hr', 'img', 'figure', 'figcaption', 'pre', 'code', 'span', 'div', 'video', 'audio', 'source', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);
export const ALLOWED_ATTRS = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  video: new Set(['src', 'poster', 'controls', 'preload']),
  audio: new Set(['src', 'controls', 'preload']),
  source: new Set(['src', 'type']),
};
export function safeUrl(u) {
  const v = String(u || '').trim();
  if (/^(https?:\/\/|\/|#|mailto:)/i.test(v)) return v;
  return '';
}
// URL media (img src / video poster): HANYA https atau path relatif.
// http ditolak supaya halaman HTTPS tidak dicampuri mixed content.
export function safeMediaUrl(u) {
  const v = String(u || '').trim();
  if (/^(https:\/\/|\/)/i.test(v)) return v;
  return '';
}
// Cek magic bytes gambar (PNG/JPEG/GIF/WebP/BMP). MIME + ekstensi bisa
// dipalsukan; SVG (teks '<') selalu ditolak karena tidak punya magic bytes.
export function isImageMagic(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return true; // GIF
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return true; // WebP (RIFF....WEBP)
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return true; // BMP
  return false;
}
export function sanitizeHtml(input) {
  let s = String(input || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // iframe HANYA dari host embed yang diizinkan (YouTube/Vimeo): tukar dulu
  // dengan token supaya tidak ikut dibuang bersama iframe jahat di bawah,
  // lalu kembalikan dalam bentuk kanonis setelah sanitasi. URL file video
  // bukan iframe, jadi tidak masuk sini. Token tanpa < > lolos dari pass
  // tag di bawah tanpa berubah.
  const embeds = [];
  const keepFrame = (whole) => {
    const m = whole.match(/src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
    const src = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    const v = videoEmbedUrl(src);
    if (!v || v.kind === 'file') return '';
    const title = v.kind === 'youtube' ? 'Video YouTube' : 'Video Vimeo';
    const allow = v.kind === 'youtube' ? 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share' : 'autoplay; fullscreen; picture-in-picture';
    embeds.push('<iframe src="' + esc(v.embed) + '" title="' + title + '" width="560" height="315" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="' + allow + '" allowfullscreen></iframe>');
    return '__HOZIN_EMBED_' + (embeds.length - 1) + '__';
  };
  s = s.replace(/<iframe\b[^>]*>([\s\S]*?)<\/iframe\s*>/gi, keepFrame);
  s = s.replace(/<iframe\b[^>]*\/>/gi, keepFrame);
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button', 'link', 'meta', 'title', 'head', 'body', 'html']) {
    s = s.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), '');
    s = s.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), '');
  }
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (whole, tagName, attrs) => {
    const tag = tagName.toLowerCase();
    const closing = whole.startsWith('</');
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (closing) return '</' + tag + '>';
    const allowed = ALLOWED_ATTRS[tag] || new Set();
    let out = '';
    const attrRe = /([a-zA-Z-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = attrRe.exec(attrs || '')) !== null) {
      const name = m[1].toLowerCase();
      if (!allowed.has(name)) continue;
      if (name === 'controls') { out += ' controls'; continue; }
      const val = m[2] ?? m[3] ?? m[4] ?? '';
      if (name === 'href' || name === 'src' || name === 'poster') {
        // href boleh http/mailto; src/poster media HANYA https (anti mixed
        // content — halaman HTTPS tidak boleh memuat media http).
        const safe = name === 'href' ? safeUrl(val) : safeMediaUrl(val);
        if (!safe) continue;
        out += ' ' + name + '="' + esc(safe) + '"';
      } else {
        out += ' ' + name + '="' + esc(val) + '"';
      }
    }
    const selfClose = (tag === 'br' || tag === 'hr' || tag === 'img' || tag === 'source') ? ' /' : '';
    return '<' + tag + out + selfClose + '>';
  });
  s = s.replace(/__HOZIN_EMBED_(\d+)__/g, (m, i) => embeds[Number(i)] || '');
  return s;
}
