// Tema CMS Hozin — sistem tema ala WordPress, versi data (bukan kode per tema).
// Satu tema = satu definisi data: warna, font, radius kartu, lebar halaman.
// Menambah tema baru = tambah satu entri di themeDefs, lalu redeploy.
// Ganti tema dari dashboard admin (/admin -> Pengaturan -> Tema), tersimpan
// di D1 cms_settings (kunci 'theme'). Tema lama 'terang'/'gelap' tetap ada
// supaya setelan yang sudah tersimpan tidak rusak.
//
// ANTI AI SLOP (perintah pemilik, prinsip 9 Okt 2026): tema ini TIDAK pakai
// palet default Tailwind (slate + sky, kartu bulat generik) yang dipakai
// template massal. Identitasnya diambil dari situs lama hozinking.my.id
// (homepage.js): latar malam pekat #05070d, gradasi biru #3b82f6 -> ungu
// #8b5cf6, tombol radius 10px, judul tebal rapat, meta huruf kapital
// berjarak. Tema baru dibedakan lewat TIPOGRAFI dan TATA LETAK, bukan
// sekadar ganti palet acak, supaya tetap kelihatan satu keluarga.
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
    `header .brand{font-size:clamp(18px,4vw,20px);font-weight:800;letter-spacing:-.02em;display:inline-flex;align-items:center}header .mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,${accent},${accent2});display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;margin-right:10px}header nav{margin-top:8px;font-size:14px;display:flex;flex-wrap:wrap;gap:6px 14px}` +
    `header nav a{margin-right:0;color:${accent}}main{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:clamp(14px,4vw,20px)}` +
    `.card{background:${card};border:1px solid ${border};border-radius:${radius}px;padding:18px;margin:0 0 16px;overflow-wrap:anywhere}` +
    `.card h2{margin:0 0 6px;font-weight:800;letter-spacing:-.02em;font-size:clamp(20px,5vw,26px)}.card h2 a{color:${fg};text-decoration:none}.meta{color:${muted};font-size:12px;letter-spacing:.04em;text-transform:uppercase}` +
    `a{color:${accent}}img,video{max-width:100%;height:auto}audio{width:100%}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid ${border};border-radius:10px;background:${card};color:${fg};font-size:16px}` +
    `button{padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,${accent},${accent2});color:#fff;font-weight:700;cursor:pointer}` +
    `footer{width:100%;max-width:${maxWidth}px;margin:0 auto;padding:20px;color:${muted};font-size:13px;margin-top:auto}` +
    `@media (max-width:600px){header{padding:14px 16px}main{padding:14px}.card{padding:14px}button{min-height:44px;padding:12px 18px}}` +
    `@media (min-width:900px){main,footer{max-width:${maxWidth + 40}px}}`;
}
function shell(css, siteTitle, pageTitle, content) {
  // Footer dipertahankan dari situs lama hozinking.my.id (homepage.js):
  // copyright otomatis 2024–tahun berjalan, dan uptime server sejak 2024-01-01 WIB
  // (mode rincian thn/bln/mgg/hari/jam:menit:detik, klik untuk ganti ke total jam, update tiap detik).
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024–'+y):'2024'}var START=new Date('2024-01-01T00:00:00+07:00').getTime();var el=document.getElementById('uptime'),mode=0;function p2(n){return (n<10?'0':'')+n}function parts(){var f=new Date(START),t=new Date();var y=t.getFullYear()-f.getFullYear(),mo=t.getMonth()-f.getMonth(),d=t.getDate()-f.getDate(),h=t.getHours()-f.getHours(),mi=t.getMinutes()-f.getMinutes(),s=t.getSeconds()-f.getSeconds();if(s<0){s+=60;mi--}if(mi<0){mi+=60;h--}if(h<0){h+=24;d--}if(d<0){mo--;d+=new Date(t.getFullYear(),t.getMonth(),0).getDate()}if(mo<0){y--;mo+=12}var w=Math.floor(d/7);d=d%7;return{y:y,mo:mo,w:w,d:d,h:h,mi:mi,s:s}}function render(){if(!el)return;if(mode===0){var p=parts(),o=[];if(p.y>0)o.push(p.y+' thn');if(p.mo>0)o.push(p.mo+' bln');if(p.w>0)o.push(p.w+' mgg');if(p.d>0)o.push(p.d+' hari');o.push(p2(p.h)+':'+p2(p.mi)+':'+p2(p.s));el.textContent='Online '+o.join(' ')}else{var hrs=Math.floor((Date.now()-START)/3600000);el.textContent='Online '+hrs.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+' jam'}}if(el){el.addEventListener('click',function(){mode=(mode+1)%2;render()});render();setInterval(render,1000)}}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} — ${siteTitle}</title><style>${css}</style></head><body><header><a class="brand" href="/"><span class="mark">H</span>${siteTitle}</a><nav><a href="/">Beranda</a><a href="/admin">Admin</a></nav></header><main>${content}</main><footer><p>© <span id="copyr">2024–2026</span> HozinKing · <span id="uptime" title="Klik untuk ganti mode tampilan" style="cursor:pointer;border-bottom:1px dotted #5b6b8c">…</span></p></footer>${footerScript}</body></html>`;
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
  render: ({ siteTitle, pageTitle, content }) => shell(baseCss(def), siteTitle, pageTitle, content),
}]));
