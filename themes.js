// Tema WorkerCMS — sistem tema ala WordPress, versi data (bukan kode per tema).
// Satu tema = satu definisi data: warna, font, radius kartu, lebar halaman.
// Menambah tema baru = tambah satu entri di themeDefs, lalu redeploy.
// Ganti tema dari dashboard admin (/kendali -> Pengaturan -> Tema), tersimpan
// di D1 cms_settings (kunci 'theme'). Tema lama 'terang'/'gelap' tetap ada
// supaya setelan yang sudah tersimpan tidak rusak.
//
// Identitas default WorkerCMS (bukan palet template generik): latar malam
// pekat #05070d, gradasi biru #3b82f6 -> ungu #8b5cf6, tombol radius 10px,
// judul tebal rapat, meta huruf kapital berjarak. Tema baru dibedakan lewat
// TIPOGRAFI dan TATA LETAK, bukan sekadar ganti palet acak, supaya tetap
// kelihatan satu keluarga.
//
// RESPONSIF lintas platform (perintah pemilik 29 Okt 2026): satu kode web
// untuk semua perangkat, tidak ada aplikasi terpisah per platform. Viewport
// sudah ada di shell(); CSS di bawah memakai lebar fluida + breakpoint:
// layar kecil (HP) = padding mengecil, judul mengecil, tombol minimal 44px
// supaya nyaman disentuh, input 16px supaya tidak zoom sendiri di iOS;
// layar besar (PC) = lebar konten membesar sedikit. Gambar/video tidak
// pernah meluber dari kartu.
function baseCss(def) {
  const { bg, fg, card, muted, accent, border, accent2, font, radius, maxWidth } = def;
  return `body{margin:0;font-family:${font};background:${bg};color:${fg};line-height:1.6;display:flex;flex-direction:column;min-height:100vh;font-size:16px}` +
    `*,*::before,*::after{box-sizing:border-box}` +
    `header{padding:18px 20px;border-bottom:1px solid ${border}}header a{color:${fg};text-decoration:none}` +
    `header .brand{font-size:clamp(18px,4vw,20px);font-weight:800;letter-spacing:-.02em;display:inline-flex;align-items:center}header .mark{width:30px;height:30px;flex:0 0 30px;margin-right:10px}header .mark svg{width:30px;height:30px;display:block}header nav{margin-top:8px;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 14px}` +
    `header nav a{margin-right:0;color:${accent}}main{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:clamp(14px,4vw,20px)}` +
    `.card{background:${card};border:1px solid ${border};border-radius:${radius}px;padding:18px;margin:0 0 16px;overflow-wrap:anywhere}` +
    `.card h2{margin:0 0 6px;font-weight:800;letter-spacing:-.02em;font-size:clamp(20px,5vw,26px)}.card h2 a{color:${fg};text-decoration:none}.meta{color:${muted};font-size:12px;letter-spacing:.04em;text-transform:uppercase}` +
    `a{color:${accent}}img,video{max-width:100%;height:auto}audio{width:100%}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid ${border};border-radius:10px;background:${card};color:${fg};font-size:16px}` +
    `input[type=checkbox]{width:auto;padding:0;margin:0;vertical-align:middle}.remember{display:flex;align-items:center;gap:8px;margin:6px 0 12px}.remember input{flex:0 0 auto}` +
    `.view-eye{display:inline-block;width:18px;height:14px;vertical-align:-2px}.view-eye svg{width:18px;height:14px;display:block}.view-eye .eye-blink{transform-origin:center;transform-box:fill-box;animation:eyeBlink 4s linear infinite}@keyframes eyeBlink{0%,92%,100%{transform:scaleY(1)}94%,96%{transform:scaleY(.08)}}` +
    `button{padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,${accent},${accent2});color:#fff;font-weight:700;cursor:pointer}` +
    `.post-cover{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px;display:block;margin-bottom:12px}` +
    `.read-more{display:inline-block;padding:10px 16px;border-radius:10px;background:linear-gradient(135deg,${accent},${accent2});color:#fff!important;font-weight:700;text-decoration:none}` +
    `.fab{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;line-height:1;box-shadow:0 10px 28px rgba(0,0,0,.35);z-index:50;transition:transform .25s,opacity .25s;text-decoration:none;color:#fff;background:linear-gradient(135deg,${accent},${accent2})}.fab-hidden{transform:translateY(90px);opacity:0;pointer-events:none}` +
    `@media (max-width:600px){.fab{right:16px;bottom:16px}}` +
    `footer{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:20px;color:${muted};font-size:13px;margin-top:auto}` +
    `@media (max-width:600px){header{padding:14px 16px}main{padding:14px}.card{padding:14px}button{min-height:44px;padding:12px 18px}}` +
    `@media (min-width:900px){main,footer{max-width:${maxWidth + 40}px}}`;
}
function shell(css, def, siteTitle, pageTitle, content, siteAvatar) {
  const mark = String(siteTitle || 'W').trim().charAt(0).toUpperCase() || 'W';
  const avatarHtml = siteAvatar
    ? `<img src="${siteAvatar}" alt="" style="width:30px;height:30px;flex:0 0 30px;margin-right:10px;border-radius:50%;object-fit:cover">`
    : '';
  const accent = def.accent, accent2 = def.accent2;
  // Logo animasi SVG (bukan Lottie): tanpa JS eksternal, tanpa file JSON,
  // tanpa beban unduhan tambahan — jadi tetap jalan di halaman
  // pemeliharaan saat D1 mati. Animasi hanya sapuan kilau halus tiap
  // 5 detik (SMIL di dalam SVG), bukan putaran terus-menerus yang
  // mengganggu. Huruf di tengah = huruf pertama judul situs.
  const markSvg = `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="markGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${accent2}"/></linearGradient><clipPath id="markClip"><rect width="48" height="48" rx="13"/></clipPath></defs><rect width="48" height="48" rx="13" fill="url(#markGrad)"/><g clip-path="url(#markClip)"><g><animateTransform attributeName="transform" type="translate" values="-48 0; 96 0; 96 0" keyTimes="0;0.55;1" dur="5s" begin="0.8s" repeatCount="indefinite"/><rect x="0" y="-12" width="16" height="72" fill="#ffffff" opacity="0.28" transform="skewX(-20)"/></g></g><text x="24" y="33" text-anchor="middle" font-size="26" font-weight="800" fill="#ffffff" font-family="Inter,system-ui,sans-serif">${mark}</text></svg>`;
  // Footer: copyright otomatis 2024–tahun berjalan, dan uptime sejak
  // 2024-01-01 WIB (mode rincian thn/bln/mgg/hari/jam:menit:detik, klik untuk
  // ganti ke total jam, update tiap detik). Nama brand di footer dan mark di
  // header berasal dari siteTitle (judul situs di pengaturan), jadi tema
  // default tetap netral tanpa nama pemilik.
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024–'+y):'2024'}var START=new Date('2024-01-01T00:00:00+07:00').getTime();var el=document.getElementById('uptime'),mode=0;function p2(n){return (n<10?'0':'')+n}function parts(){var f=new Date(START),t=new Date();var y=t.getFullYear()-f.getFullYear(),mo=t.getMonth()-f.getMonth(),d=t.getDate()-f.getDate(),h=t.getHours()-f.getHours(),mi=t.getMinutes()-f.getMinutes(),s=t.getSeconds()-f.getSeconds();if(s<0){s+=60;mi--}if(mi<0){mi+=60;h--}if(h<0){h+=24;d--}if(d<0){mo--;d+=new Date(t.getFullYear(),t.getMonth(),0).getDate()}if(mo<0){y--;mo+=12}var w=Math.floor(d/7);d=d%7;return{y:y,mo:mo,w:w,d:d,h:h,mi:mi,s:s}}function render(){if(!el)return;if(mode===0){var p=parts(),o=[];if(p.y>0)o.push(p.y+' thn');if(p.mo>0)o.push(p.mo+' bln');if(p.w>0)o.push(p.w+' mgg');if(p.d>0)o.push(p.d+' hari');o.push(p2(p.h)+':'+p2(p.mi)+':'+p2(p.s));el.textContent='Online '+o.join(' ')}else{var hrs=Math.floor((Date.now()-START)/3600000);el.textContent='Online '+hrs.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+' jam'}}if(el){el.addEventListener('click',function(){mode=(mode+1)%2;render()});render();setInterval(render,1000)}}catch(e){}})();(function(){try{var eyes=document.querySelectorAll('.view-eye .eye-blink');var d=-(Date.now()%4000);eyes.forEach(function(e){e.style.animationDelay=d+'ms'})}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} — ${siteTitle}</title><style>${css}</style></head><body><header><a class="brand" href="/">${avatarHtml || `<span class="mark">${markSvg}</span>`}${siteTitle}</a><nav><a href="/">Beranda</a><a href="/akun">Akun</a></nav></header><main>${content}</main><footer><p>© <span id="copyr">2024–2026</span> ${siteTitle} · <span id="uptime" title="Klik untuk ganti mode tampilan" style="cursor:pointer;border-bottom:1px dotted #5b6b8c">…</span></p></footer>${footerScript}</body></html>`;
}
const themeDefs = {
  terang: {
    name: 'Terang',
    bg: '#f6f7fb', fg: '#0a0f1c', card: '#ffffff', muted: '#5c6a86',
    accent: '#3b82f6', border: '#d8deeb', accent2: '#8b5cf6',
    font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 18, maxWidth: 720,
  },
  gelap: {
    name: 'Gelap',
    bg: '#05070d', fg: '#f0f4fc', card: '#0d1424', muted: '#8b98b4',
    accent: '#3b82f6', border: 'rgba(120,160,220,.12)', accent2: '#8b5cf6',
    font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 18, maxWidth: 720,
  },
  majalah: {
    name: 'Majalah',
    bg: '#faf9f6', fg: '#16130f', card: '#ffffff', muted: '#6b6257',
    accent: '#3b82f6', border: '#e3ddd0', accent2: '#8b5cf6',
    font: 'Georgia,"Times New Roman",serif', radius: 12, maxWidth: 780,
  },
  minimal: {
    name: 'Minimal',
    bg: '#ffffff', fg: '#111111', card: '#ffffff', muted: '#666666',
    accent: '#111111', border: '#e5e5e5', accent2: '#111111',
    font: 'Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif', radius: 8, maxWidth: 680,
  },
};
export const themes = Object.fromEntries(Object.entries(themeDefs).map(([id, def]) => [id, {
  name: def.name,
  render: ({ siteTitle, pageTitle, content, siteAvatar }) => shell(baseCss(def), def, siteTitle, pageTitle, content, siteAvatar),
}]));
