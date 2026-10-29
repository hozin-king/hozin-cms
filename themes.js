// Tema CMS Hozin — menambah tema baru = tambah satu entri di sini, lalu redeploy.
// Tiap tema: { name, render({ siteTitle, pageTitle, content }) } -> HTML lengkap.
// `content` sudah di-escape / dibangun aman oleh worker.js, tema tidak perlu escape ulang.
function baseCss(bg, fg, card, muted, accent, border) {
  return `body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:${bg};color:${fg}}` +
    `header{padding:18px 20px;border-bottom:1px solid ${border}}header a{color:${fg};text-decoration:none}` +
    `header .brand{font-size:22px;font-weight:800}header nav{margin-top:6px;font-size:14px}` +
    `header nav a{margin-right:14px;color:${accent}}main{max-width:720px;margin:0 auto;padding:20px}` +
    `.card{background:${card};border:1px solid ${border};border-radius:14px;padding:16px;margin:0 0 16px}` +
    `.card h2{margin:0 0 6px}.card h2 a{color:${fg};text-decoration:none}.meta{color:${muted};font-size:13px}` +
    `a{color:${accent}}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid ${border};border-radius:10px;background:${card};color:${fg}}` +
    `button{padding:10px 16px;border:0;border-radius:10px;background:${accent};color:#fff;font-weight:700;cursor:pointer}` +
    `footer{max-width:720px;margin:0 auto;padding:20px;color:${muted};font-size:13px}`;
}
function shell(css, siteTitle, pageTitle, content) {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle} — ${siteTitle}</title><style>${css}</style></head><body><header><a class="brand" href="/">${siteTitle}</a><nav><a href="/">Beranda</a><a href="/admin">Admin</a></nav></header><main>${content}</main><footer>${siteTitle} — CMS Hozin</footer></body></html>`;
}
export const themes = {
  terang: {
    name: 'Terang',
    render: ({ siteTitle, pageTitle, content }) => shell(baseCss('#f8fafc', '#0f172a', '#ffffff', '#64748b', '#0284c7', '#e2e8f0'), siteTitle, pageTitle, content),
  },
  gelap: {
    name: 'Gelap',
    render: ({ siteTitle, pageTitle, content }) => shell(baseCss('#0f172a', '#e2e8f0', '#1e293b', '#94a3b8', '#38bdf8', '#334155'), siteTitle, pageTitle, content),
  },
};
