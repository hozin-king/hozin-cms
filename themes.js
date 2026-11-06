// Tema WorkerCMS — sistem tema data-driven.
// Responsif mobile / tablet / desktop. Aksen solid, tipografi nyaman, tidak gradient berat.
function baseCss(def) {
  const { bg, fg, card, muted, accent, border, font, radius, maxWidth } = def;
  return `body{margin:0;font-family:${font};background:${bg};color:${fg};line-height:1.65;display:flex;flex-direction:column;min-height:100vh;font-size:16px;-webkit-font-smoothing:antialiased}` +
    `*,*::before,*::after{box-sizing:border-box}` +
    `header{padding:14px 18px;border-bottom:1px solid ${border};background:${card}}header a{color:${fg};text-decoration:none}` +
    `header .brand{font-size:clamp(16px,3.2vw,19px);font-weight:700;display:inline-flex;align-items:center}header .mark{width:26px;height:26px;flex:0 0 26px;margin-right:9px}header .mark svg{width:26px;height:26px;display:block}header nav{margin-top:8px;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 14px}` +
    `header nav a{color:${accent};font-weight:500}main{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:18px 14px}` +
    `.card{background:${card};border:1px solid ${border};border-radius:${radius}px;padding:18px;margin:0 0 18px;overflow-wrap:anywhere;box-shadow:0 1px 2px rgba(0,0,0,.03)}` +
    `.card h2{margin:0 0 6px;font-weight:700;font-size:clamp(19px,4.2vw,25px);line-height:1.3}.card h2 a{color:${fg};text-decoration:none}.meta{color:${muted};font-size:13px;margin-bottom:6px}` +
    `a{color:${accent}}img,video{max-width:100%;height:auto;border-radius:8px}audio{width:100%}input,textarea,select{width:100%;box-sizing:border-box;padding:9px 12px;margin:3px 0 12px;border:1px solid ${border};border-radius:8px;background:${bg};color:${fg};font-size:16px;font-family:inherit}` +
    `button{padding:9px 16px;border:0;border-radius:8px;background:${accent};color:#fff;font-weight:600;cursor:pointer;font-size:14.5px}` +
    `.post-cover{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:10px;display:block;margin-bottom:12px}` +
    `.read-more{display:inline-block;padding:9px 16px;border-radius:8px;background:${accent};color:#fff!important;font-weight:600;text-decoration:none;font-size:14px}` +
    `.fab{position:fixed;right:18px;bottom:22px;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 3px 10px rgba(0,0,0,.18);z-index:50;text-decoration:none;color:#fff;background:${accent}}` +
    `@media (max-width:640px){header{padding:10px 12px}main{padding:12px 10px}.card{padding:14px}button,.read-more{min-height:44px}}` +
    `@media (min-width:641px) and (max-width:900px){main,footer{max-width:680px;padding:16px 18px}}` +
    `@media (min-width:901px){main,footer{max-width:${maxWidth + 40}px;padding:24px 20px}}` +
    `footer{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:20px 14px;color:${muted};font-size:13px;margin-top:auto;border-top:1px solid ${border}}` +
    `.view-eye{display:inline-block;width:22px;height:20px;vertical-align:-5px}.view-eye svg{width:22px;height:20px;display:block}`;
}
function renandoCss(def) {
  const { bg, fg, card, muted, accent, border, font } = def;
  return `html{scroll-behavior:smooth}` +
    `body{margin:0;font-family:${font};background:${bg};color:${fg};line-height:1.6;display:flex;flex-direction:column;min-height:100vh;font-size:16px;-webkit-font-smoothing:antialiased;overflow-x:hidden}` +
    `*,*::before,*::after{box-sizing:border-box}` +
    `header{position:sticky;top:0;z-index:10;padding:16px 18px;border-bottom:1px solid ${border};background:${bg}}header a{color:${fg};text-decoration:none}` +
    `header .brand{font-size:clamp(20px,4vw,28px);font-weight:800;letter-spacing:-.02em;text-transform:uppercase;display:inline-flex;align-items:center}header .mark{width:30px;height:30px;flex:0 0 30px;margin-right:10px}header .mark svg{width:30px;height:30px;display:block}header nav{margin-top:10px;font-size:13px;display:flex;flex-wrap:wrap;gap:6px 18px}` +
    `header nav a{color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:.08em}main{width:100%;max-width:1080px;margin:0 auto;padding:28px 18px}` +
    `main>h2{font-size:clamp(30px,6vw,54px);line-height:1.05;font-weight:800;letter-spacing:-.03em;text-transform:uppercase;margin:8px 0 24px}` +
    `.card,article.card{background:${card};border:1px solid ${border};border-radius:0;padding:24px;margin:0 0 24px;overflow-wrap:anywhere;animation:renandoUp .35s ease both}` +
    `main>div.card:nth-of-type(n+2){content-visibility:auto;contain-intrinsic-size:0 420px}` +
    `.card h2{margin:0 0 10px;font-weight:800;font-size:clamp(28px,6vw,52px);line-height:1.05;letter-spacing:-.03em;text-transform:uppercase}.card h2 a{color:${fg};text-decoration:none}.card h2 a:hover{color:${accent}}` +
    `.card h3{font-size:clamp(20px,4vw,28px);line-height:1.2;font-weight:800;letter-spacing:-.02em;text-transform:uppercase;margin:20px 0 8px}.meta{color:${muted};font-size:13px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em}` +
    `a{color:${accent}}img,video{max-width:100%;height:auto;border-radius:0}audio{width:100%}input,textarea,select{width:100%;box-sizing:border-box;padding:10px 12px;margin:3px 0 12px;border:1px solid #333;border-radius:4px;background:${bg};color:${fg};font-size:16px;font-family:inherit}` +
    `button{padding:11px 18px;border:0;border-radius:4px;background:${accent};color:#fff;font-weight:700;cursor:pointer;font-size:14px;text-transform:uppercase;letter-spacing:.06em}` +
    `.post-cover{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:0;display:block;margin-bottom:14px}` +
    `.read-more{display:inline-block;padding:11px 18px;border-radius:4px;background:${accent};color:#fff!important;font-weight:700;text-decoration:none;font-size:14px;text-transform:uppercase;letter-spacing:.06em}` +
    `.fab{position:fixed;right:18px;bottom:22px;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;z-index:50;text-decoration:none;color:#fff;background:${accent}}` +
    `@keyframes renandoUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}` +
    `@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.card,article.card{animation:none}}` +
    `@media (max-width:640px){header{padding:12px 14px}main{padding:16px 12px}.card,article.card{padding:18px}button,.read-more{min-height:44px}}` +
    `footer{width:100%;max-width:1080px;margin:0 auto;padding:20px 18px;color:${muted};font-size:13px;margin-top:auto;border-top:1px solid ${border}}` +
    `.view-eye{display:inline-block;width:22px;height:20px;vertical-align:-5px}.view-eye svg{width:22px;height:20px;display:block}`;
}
// Tema Glass (6 Nov 2026): dock kaca cair di bawah layar — blur + filter gooey.
// Sengaja tema TERPISAH dari Renando supaya janji anti-lag Renando tidak rusak:
// backdrop-filter blur tiap frame + filter SVG itu berat di HP spek rendah.
function glassCss(def) {
  return baseCss(def) +
    `body{padding-bottom:96px}` +
    `.fab{bottom:96px}` +
    `.glass-dock{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:60;display:flex;gap:4px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);box-shadow:0 8px 32px rgba(0,0,0,.4);backdrop-filter:blur(18px) saturate(160%);-webkit-backdrop-filter:blur(18px) saturate(160%)}` +
    `.glass-dock::after{content:"";position:absolute;inset:0;border-radius:inherit;background:linear-gradient(115deg,rgba(255,255,255,.14),transparent 40%,transparent 60%,rgba(56,189,248,.12));pointer-events:none}` +
    `.glass-dock-item{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:64px;padding:6px 10px;border-radius:999px;color:${def.fg};text-decoration:none;font-size:11px;font-weight:600;letter-spacing:.02em}.glass-dock-item svg{width:22px;height:22px;display:block}.glass-dock-item:active{background:rgba(255,255,255,.14)}` +
    `.glass-goo{position:absolute;inset:0;overflow:hidden;border-radius:inherit;filter:url(#glass-gooey);pointer-events:none}.glass-goo i{position:absolute;width:36px;height:36px;border-radius:50%;background:rgba(125,211,252,.5);filter:blur(8px)}.glass-goo i:first-child{left:12%;top:8px}.glass-goo i:last-child{right:12%;bottom:6px;background:rgba(167,139,250,.45)}`;
}
// Dock hanya 2 ikon NYATA (Beranda + Akun) — CMS tidak punya fitur cari/grid/voice,
// jadi ikon itu TIDAK dipasang (tombol palsu dilarang).
const glassDockHtml = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><filter id="glass-gooey" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur"/><feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter></defs></svg>` +
  `<nav class="glass-dock" aria-label="Navigasi bawah"><span class="glass-goo" aria-hidden="true"><i></i><i></i></span><a class="glass-dock-item" href="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg><span>Beranda</span></a><a class="glass-dock-item" href="/akun"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/></svg><span>Akun</span></a></nav>`;
function shell(css, def, siteTitle, pageTitle, content, siteAvatar, metaDesc = '') {
  const mark = String(siteTitle || 'W').trim().charAt(0).toUpperCase() || 'W';
  const avatarHtml = siteAvatar ? `<img src="${siteAvatar}" alt="" style="width:26px;height:26px;flex:0 0 26px;margin-right:9px;border-radius:50%;object-fit:cover">` : '';
  const accent = def.accent;
  const markSvg = `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="11" fill="${accent}"/><text x="24" y="33" text-anchor="middle" font-size="26" font-weight="700" fill="#fff" font-family="Inter,system-ui,sans-serif">${mark}</text></svg>`;
  const desc = metaDesc ? String(metaDesc).slice(0, 155) : '';
  const metaTags = desc ? `<meta name="description" content="${desc}"><meta property="og:title" content="${pageTitle} — ${siteTitle}"><meta property="og:description" content="${desc}"><meta property="og:type" content="website">` : '';
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024–'+y):'2024'}}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} — ${siteTitle}</title>${metaTags}<style>${css}</style></head><body><header><a class="brand" href="/">${avatarHtml || `<span class="mark">${markSvg}</span>`}${siteTitle}</a><nav><a href="/">Beranda</a><a href="/akun">Akun</a></nav></header><main>${content}</main><footer><p>© <span id="copyr">2024–2026</span> ${siteTitle} · <a href="/uptime">Online sejak 1 Januari 2024</a></p></footer>${footerScript}</body></html>`;
}
const themeDefs = {
  terang: { name: 'Terang', bg: '#f8f9fa', fg: '#1a1a1a', card: '#fff', muted: '#5f6b7a', accent: '#2563eb', border: '#e5e7eb', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 10, maxWidth: 720 },
  gelap: { name: 'Gelap', bg: '#0f1419', fg: '#e7e9ea', card: '#1a1f26', muted: '#8b98a5', accent: '#3b82f6', border: '#2f3336', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 10, maxWidth: 720 },
  majalah: { name: 'Majalah', bg: '#faf8f5', fg: '#1c1917', card: '#fff', muted: '#78716c', accent: '#1d4ed8', border: '#e7e5e4', font: 'Georgia,"Times New Roman",serif', radius: 8, maxWidth: 760 },
  minimal: { name: 'Minimal', bg: '#fff', fg: '#171717', card: '#fff', muted: '#737373', accent: '#171717', border: '#e5e5e5', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 6, maxWidth: 680 },
  renando: { name: 'Renando (Gelap, Anti-Lag)', bg: '#0a0a0a', fg: '#fafafa', card: '#131313', muted: '#a1a1aa', accent: '#ff2626', border: '#262626', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 0, maxWidth: 1080 },
  glass: { name: 'Glass (Kaca Cair)', bg: '#0b0e14', fg: '#eef2f7', card: '#141926', muted: '#94a3b8', accent: '#38bdf8', border: '#232a3a', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 16, maxWidth: 720 },
};
export const themes = Object.fromEntries(Object.entries(themeDefs).map(([id, def]) => [id, {
  name: def.name,
  render: ({ siteTitle, pageTitle, content, siteAvatar, metaDesc }) => {
    if (id === 'glass') {
      const html = shell(glassCss(def), def, siteTitle, pageTitle, content, siteAvatar, metaDesc);
      return html.replace('</body>', glassDockHtml + '</body>');
    }
    return shell(id === 'renando' ? renandoCss(def) : baseCss(def), def, siteTitle, pageTitle, content, siteAvatar, metaDesc);
  },
}]));
