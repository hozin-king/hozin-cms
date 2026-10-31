// Tema WorkerCMS — sistem tema data-driven.
// Responsif mobile / tablet / desktop. Aksen solid, tipografi nyaman, tidak gradient berat.
import { esc } from './util.js';
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
    `.view-eye{display:inline-block;width:22px;height:20px;vertical-align:-5px}.view-eye svg{width:22px;height:20px;display:block}` +
    `.fab{position:fixed;right:18px;bottom:22px;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 3px 10px rgba(0,0,0,.18);z-index:50;text-decoration:none;color:#fff;background:${accent}}` +
    `@media (max-width:640px){header{padding:10px 12px}main{padding:12px 10px}.card{padding:14px}button,.read-more{min-height:44px}}` +
    `@media (min-width:641px) and (max-width:900px){main,footer{max-width:680px;padding:16px 18px}}` +
    `@media (min-width:901px){main,footer{max-width:${maxWidth + 40}px;padding:24px 20px}}` +
    `footer{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:20px 14px;color:${muted};font-size:13px;margin-top:auto;border-top:1px solid ${border}}`;
}
function shell(css, def, siteTitle, pageTitle, content, siteAvatar, metaDesc = '') {
  const mark = String(siteTitle || 'W').trim().charAt(0).toUpperCase() || 'W';
  const avatarHtml = siteAvatar ? `<img src="${siteAvatar}" alt="" style="width:26px;height:26px;flex:0 0 26px;margin-right:9px;border-radius:50%;object-fit:cover">` : '';
  const accent = def.accent;
  const markSvg = `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="11" fill="${accent}"/><text x="24" y="33" text-anchor="middle" font-size="26" font-weight="700" fill="#fff" font-family="Inter,system-ui,sans-serif">${mark}</text></svg>`;
  // metaDesc di-escape: nilainya bisa berasal dari isi post di masa depan,
  // dan tanpa escape kutip di dalamnya bisa menutup atribut content="...".
  const desc = metaDesc ? esc(String(metaDesc).slice(0, 155)) : '';
  const metaTags = desc ? `<meta name="description" content="${desc}"><meta property="og:title" content="${pageTitle} — ${siteTitle}"><meta property="og:description" content="${desc}"><meta property="og:type" content="website">` : '';
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024–'+y):'2024'}}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} — ${siteTitle}</title>${metaTags}<style>${css}</style></head><body><header><a class="brand" href="/">${avatarHtml || `<span class="mark">${markSvg}</span>`}${siteTitle}</a><nav><a href="/">Beranda</a><a href="/akun">Akun</a></nav></header><main>${content}</main><footer><p>© <span id="copyr">2024–2026</span> ${siteTitle}</p></footer>${footerScript}</body></html>`;
}
const themeDefs = {
  terang: { name: 'Terang', bg: '#f8f9fa', fg: '#1a1a1a', card: '#fff', muted: '#5f6b7a', accent: '#2563eb', border: '#e5e7eb', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 10, maxWidth: 720 },
  gelap: { name: 'Gelap', bg: '#0f1419', fg: '#e7e9ea', card: '#1a1f26', muted: '#8b98a5', accent: '#3b82f6', border: '#2f3336', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 10, maxWidth: 720 },
  majalah: { name: 'Majalah', bg: '#faf8f5', fg: '#1c1917', card: '#fff', muted: '#78716c', accent: '#1d4ed8', border: '#e7e5e4', font: 'Georgia,"Times New Roman",serif', radius: 8, maxWidth: 760 },
  minimal: { name: 'Minimal', bg: '#fff', fg: '#171717', card: '#fff', muted: '#737373', accent: '#171717', border: '#e5e5e5', font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 6, maxWidth: 680 },
};
export const themes = Object.fromEntries(Object.entries(themeDefs).map(([id, def]) => [id, {
  name: def.name,
  render: ({ siteTitle, pageTitle, content, siteAvatar, metaDesc }) => shell(baseCss(def), def, siteTitle, pageTitle, content, siteAvatar, metaDesc),
}]));
