// Tema CMS Hozin — menambah tema baru = tambah satu entri di sini, lalu redeploy.
// Tiap tema: { name, render({ siteTitle, pageTitle, content }) } -> HTML lengkap.
// `content` sudah di-escape / dibangun aman oleh worker.js, tema tidak perlu escape ulang.
//
// ANTI AI SLOP (perintah pemilik, prinsip 9 Okt 2026): tema ini TIDAK pakai
// palet default Tailwind (slate + sky, kartu bulat generik) yang dipakai
// template massal. Identitasnya diambil dari situs lama hozinking.my.id
// (homepage.js): latar malam pekat #05070d, gradasi biru #3b82f6 -> ungu
// #8b5cf6, aksen cyan #22d3ee, tombol radius 10px, judul tebal rapat,
// meta huruf kapital berjarak — supaya CMS ini kelihatan satu keluarga
// dengan situs lamamu, bukan situs template acak. Kedua tema memakai
// aksen yang SAMA, hanya latarnya yang dibalik, jadi ganti tema tidak
// terasa seperti ganti situs lain.
function baseCss(bg, fg, card, muted, accent, border, accent2) {
  return `body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:${bg};color:${fg};line-height:1.6;display:flex;flex-direction:column;min-height:100vh}` +
    `header{padding:18px 20px;border-bottom:1px solid ${border}}header a{color:${fg};text-decoration:none}` +
    `header .brand{font-size:20px;font-weight:800;letter-spacing:-.02em;display:inline-flex;align-items:center}header .mark{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,${accent},${accent2});display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:800;margin-right:10px}header nav{margin-top:8px;font-size:14px}` +
    `header nav a{margin-right:14px;color:${accent}}main{max-width:720px;margin:0 auto;padding:20px}` +
    `.card{background:${card};border:1px solid ${border};border-radius:18px;padding:18px;margin:0 0 16px}` +
    `.card h2{margin:0 0 6px;font-weight:800;letter-spacing:-.02em}.card h2 a{color:${fg};text-decoration:none}.meta{color:${muted};font-size:12px;letter-spacing:.04em;text-transform:uppercase}` +
    `a{color:${accent}}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid ${border};border-radius:10px;background:${card};color:${fg}}` +
    `button{padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,${accent},${accent2});color:#fff;font-weight:700;cursor:pointer}` +
    `footer{max-width:720px;margin:0 auto;padding:20px;color:${muted};font-size:13px;margin-top:auto}`;
}
function shell(css, siteTitle, pageTitle, content) {
  // Footer dipertahankan dari situs lama hozinking.my.id (homepage.js):
  // copyright otomatis 2024–tahun berjalan, dan uptime server sejak 2024-01-01 WIB
  // (mode rincian thn/bln/mgg/hari/jam:menit:detik, klik untuk ganti ke total jam, update tiap detik).
  const footerScript = `<script>(function(){try{var yr=document.getElementById('copyr');if(yr){var y=new Date().getFullYear();yr.textContent=y>2024?('2024–'+y):'2024'}var START=new Date('2024-01-01T00:00:00+07:00').getTime();var el=document.getElementById('uptime'),mode=0;function p2(n){return (n<10?'0':'')+n}function parts(){var f=new Date(START),t=new Date();var y=t.getFullYear()-f.getFullYear(),mo=t.getMonth()-f.getMonth(),d=t.getDate()-f.getDate(),h=t.getHours()-f.getHours(),mi=t.getMinutes()-f.getMinutes(),s=t.getSeconds()-f.getSeconds();if(s<0){s+=60;mi--}if(mi<0){mi+=60;h--}if(h<0){h+=24;d--}if(d<0){mo--;d+=new Date(t.getFullYear(),t.getMonth(),0).getDate()}if(mo<0){y--;mo+=12}var w=Math.floor(d/7);d=d%7;return{y:y,mo:mo,w:w,d:d,h:h,mi:mi,s:s}}function render(){if(!el)return;if(mode===0){var p=parts(),o=[];if(p.y>0)o.push(p.y+' thn');if(p.mo>0)o.push(p.mo+' bln');if(p.w>0)o.push(p.w+' mgg');if(p.d>0)o.push(p.d+' hari');o.push(p2(p.h)+':'+p2(p.mi)+':'+p2(p.s));el.textContent='Online '+o.join(' ')}else{var hrs=Math.floor((Date.now()-START)/3600000);el.textContent='Online '+hrs.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.')+' jam'}}if(el){el.addEventListener('click',function(){mode=(mode+1)%2;render()});render();setInterval(render,1000)}}catch(e){}})();<\/script>`;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} — ${siteTitle}</title><style>${css}</style></head><body><header><a class="brand" href="/"><span class="mark">H</span>${siteTitle}</a><nav><a href="/">Beranda</a><a href="/admin">Admin</a></nav></header><main>${content}</main><footer><p>© <span id="copyr">2024–2026</span> HozinKing · <span id="uptime" title="Klik untuk ganti mode tampilan" style="cursor:pointer;border-bottom:1px dotted #5b6b8c">…</span></p></footer>${footerScript}</body></html>`;
}
export const themes = {
  terang: {
    name: 'Terang',
    render: ({ siteTitle, pageTitle, content }) => shell(baseCss('#f6f7fb', '#0a0f1c', '#ffffff', '#5c6a86', '#3b82f6', '#d8deeb', '#8b5cf6'), siteTitle, pageTitle, content),
  },
  gelap: {
    name: 'Gelap',
    render: ({ siteTitle, pageTitle, content }) => shell(baseCss('#05070d', '#f0f4fc', '#0d1424', '#8b98b4', '#3b82f6', 'rgba(120,160,220,.12)', '#8b5cf6'), siteTitle, pageTitle, content),
  },
};
