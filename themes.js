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
    `:focus-visible{outline:2px solid ${accent};outline-offset:2px}` +
    `button{padding:9px 16px;border:0;border-radius:8px;background:${accent};color:#fff;font-weight:600;cursor:pointer;font-size:14.5px}` +
    `.post-cover{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:10px;display:block;margin-bottom:12px}` +
    `.read-more{display:inline-block;padding:9px 16px;border-radius:8px;background:${accent};color:#fff!important;font-weight:600;text-decoration:none;font-size:14px}` +
    `.fab{position:fixed;right:18px;bottom:22px;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;box-shadow:0 3px 10px rgba(0,0,0,.18);z-index:50;text-decoration:none;color:#fff;background:${accent}}` +
    // Code viewer (11 Nov 2026 — port dari live v44, ganti pre-wrap):
    // kode tampil SATU BARIS dan digeser horizontal di dalam kotak,
    // bukan patah mid-word. overflow-x:auto + max-width:100% menjaga
    // kotak tetap di dalam halaman, jadi lebar halaman HP tidak bocor.
    `pre{max-width:100%;overflow-x:auto;overflow-y:hidden;padding:12px 14px;border-radius:${radius}px;background:${card};border:1px solid ${border};font-size:13.5px;line-height:1.55;white-space:pre;overflow-wrap:normal;word-break:normal;tab-size:2;-webkit-overflow-scrolling:touch}` +
    `pre code{display:block;overflow-wrap:normal;word-break:normal;background:transparent;padding:0;font-size:inherit}` +
    `@media (max-width:640px){header{padding:10px 12px}main{padding:12px 10px}.card{padding:14px}button,.read-more{min-height:44px}}` +
    `@media (min-width:641px) and (max-width:900px){main,footer{max-width:680px;padding:16px 18px}}` +
    `@media (min-width:901px){main,footer{max-width:${maxWidth + 40}px;padding:24px 20px}}` +
    `footer{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:20px 14px;color:${muted};font-size:13px;margin-top:auto;border-top:1px solid ${border}}` +
    `.view-eye{display:inline-block;width:22px;height:20px;vertical-align:-5px}.view-eye svg{width:22px;height:20px;display:block}`;
}
function shell(css, def, siteTitle, pageTitle, content, siteAvatar, metaDesc = '') {
  const mark = String(siteTitle || 'W').trim().charAt(0).toUpperCase() || 'W';
  const avatarHtml = siteAvatar ? `<img src="${siteAvatar}" alt="" style="width:26px;height:26px;flex:0 0 26px;margin-right:9px;border-radius:50%;object-fit:cover">` : '';
  const accent = def.accent;
  const markSvg = `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="11" fill="${accent}"/><text x="24" y="33" text-anchor="middle" font-size="26" font-weight="700" fill="#fff" font-family="Inter,system-ui,sans-serif">${mark}</text></svg>`;
  const desc = metaDesc ? String(metaDesc).slice(0, 155) : '';
  const metaTags = desc ? `<meta name="description" content="${desc}"><meta property="og:title" content="${pageTitle} — ${siteTitle}"><meta property="og:description" content="${desc}"><meta property="og:type" content="website">` : '';
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024–'+y):'2024'}}catch(e){}})();<\/script>`;
  // Tombol Salin di tiap blok kode (port dari live v44, v42 8 Nov 2026):
  // bungkus tiap <pre> jadi .codebox + tombol Salin (clipboard API +
  // fallback execCommand) + label bahasa.
  const codeBoxCss = `.codebox{position:relative}.codebox pre{padding-top:38px}.copy-btn{position:absolute;top:8px;right:8px;z-index:2;padding:6px 12px;border:0;border-radius:6px;background:${accent};color:#fff;font-weight:600;cursor:pointer;font-size:12.5px;min-height:0}.copy-btn.copied{background:#16a34a}.code-lang{position:absolute;top:9px;left:12px;z-index:2;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${def.muted};font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;pointer-events:none}`;
  const copyScript = `<script>(function(){try{var NAMES={js:'JavaScript',javascript:'JavaScript',ts:'TypeScript',typescript:'TypeScript',kt:'Kotlin',kotlin:'Kotlin',java:'Java',cpp:'C++','c++':'C++',c:'C',py:'Python',python:'Python',sh:'Bash',bash:'Bash',shell:'Bash',html:'HTML',xml:'XML',css:'CSS',json:'JSON',sql:'SQL',go:'Go',rs:'Rust',rust:'Rust',rb:'Ruby',ruby:'Ruby',php:'PHP',swift:'Swift',dart:'Dart',lua:'Lua'};function detectLang(txt,cls){var m=/language-([\\w+-]+)/.exec(cls||'');if(m){var k=m[1].toLowerCase();return NAMES[k]||m[1];}var t=txt||'';if(/^\\s*javascript:/i.test(t))return 'JavaScript';if(/#include\\s*[<"][\\w.\\/]+[>"]/.test(t)||/\\bstd::/.test(t)||/\\bcout\\s*<</.test(t)||/\\bint\\s+main\\s*\\(/.test(t))return 'C++';if(/\\bpublic\\s+(static\\s+)?(class|void|int|String|final)\\b/.test(t)||/\\bSystem\\.out\\.println\\b/.test(t)||/import\\s+java\\./.test(t))return 'Java';if(/\\bfun\\s+\\w+\\s*\\(/.test(t)||/\\bval\\s+\\w+\\s*[=:]/.test(t)||/(^|\\n)\\s*println\\s*\\(/.test(t))return 'Kotlin';if(/(^|\\n)\\s*def\\s+\\w+\\s*\\(/.test(t)||(/\\bprint\\s*\\(/.test(t)&&/(^|\\n)[^\\n]*:\\s*$/.test(t)))return 'Python';if(/^\\s*#!/.test(t)||/(^|\\n)\\s*(sudo|apt|chmod|mkdir|cd)\\s+/.test(t))return 'Bash';if(/<!DOCTYPE\\s+html/i.test(t)||/<html[\\s>]/.test(t)||/<div[\\s>]/.test(t))return 'HTML';if(/\\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE)\\b/i.test(t))return 'SQL';if(/\\bdocument\\.(createElement|querySelector|getElementById)\\b/.test(t)||/\\bconsole\\.(log|warn|error)\\b/.test(t)||/\\bfunction\\s+\\w+\\s*\\(/.test(t)||/=>/.test(t))return 'JavaScript';if(/^\\s*\\{[\\s\\S]*\\"\\w+\\"\\s*:/.test(t))return 'JSON';return 'Kode';}document.querySelectorAll('pre').forEach(function(pre){var box=document.createElement('div');box.className='codebox';pre.parentNode.insertBefore(box,pre);box.appendChild(pre);var code=pre.querySelector('code');var tag=document.createElement('span');tag.className='code-lang';tag.textContent=detectLang(pre.innerText||pre.textContent,code?code.className:'');box.appendChild(tag);var btn=document.createElement('button');btn.type='button';btn.className='copy-btn';btn.textContent='Salin';btn.addEventListener('click',function(){var txt=pre.innerText||pre.textContent;function done(){btn.textContent='Disalin \\u2713';btn.classList.add('copied');setTimeout(function(){btn.textContent='Salin';btn.classList.remove('copied')},1500)}function fallback(){var ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');done()}catch(e){}document.body.removeChild(ta)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(done,function(){fallback()})}else{fallback()}});box.appendChild(btn)})}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} — ${siteTitle}</title>${metaTags}<style>${css}${codeBoxCss}</style></head><body><header><a class="brand" href="/">${avatarHtml || `<span class="mark">${markSvg}</span>`}${siteTitle}</a><nav><a href="/">Beranda</a><a href="/akun">Akun</a></nav></header><main>${content}</main><footer><p>© <span id="copyr">2024–2026</span> ${siteTitle} · <a href="/uptime">Uptime</a></p></footer>${footerScript}${copyScript}</body></html>`;
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
