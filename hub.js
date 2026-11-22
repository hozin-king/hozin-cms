// Hub Muse (22 Nov 2026) — tukar perintah antar-Muse lewat Worker + D1.
// Office Online (Alyaa) + Muse lain (Sekar dulu, nanti bisa nambah):
// tiap Muse punya kunci sendiri; yang disimpan di D1 HANYA hash SHA-256
// kuncinya — plaintext kunci hanya tampil SEKALI di panel admin saat
// pendaftaran, tidak pernah disimpan, di-log, atau dikembalikan lagi.
// Tabel di cms-db (env.DB): hub_muses + hub_tasks (dibuat ensureSchema).
// Auth: kunci Muse terdaftar (Authorization: Bearer <key> / x-hub-key)
// ATAU sesi admin + header x-csrf (pola /api/admin/cerpen-*).
// Endpoint: GET /api/hub/status, GET /api/hub/tasks,
// POST /api/hub/tasks, POST /api/hub/tasks/:id/status,
// GET /api/hub/muses, POST /api/hub/muses (dua terakhir admin saja).
import { esc, sha256Hex, randomHex, clientIp } from './util.js';
import { csrfToken } from './auth.js';
import { checkRateLimit } from './security.js';
import { ensureSchema } from './store.js';

export const HUB_STATUSES = ['baru', 'dikerjakan', 'selesai', 'batal'];
export const HUB_MUSE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const HUB_ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HUB_KEY_PREFIX = 'hb-';
const wib = v => { const n = Number(v || 0); const ms = (n > 0 && n < 1e12) ? n * 1000 : n; return new Date(ms + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16); };

// Cari Muse dari kunci yang dikirim (hash dicocokkan di D1; kunci mentah
// tidak pernah disimpan). Sukses -> last_seen_at diperbarui (best-effort).
async function authHubMuse(request, env) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const raw = bearer || String(request.headers.get('x-hub-key') || '').trim();
  if (!raw) return null;
  let row = null;
  try {
    const hash = await sha256Hex(raw);
    row = await env.DB.prepare(`SELECT id, name, room, created_at, last_seen_at FROM hub_muses WHERE key_hash = ?`).bind(hash).first();
  } catch (e) { return null; }
  if (!row) return null;
  try { await env.DB.prepare(`UPDATE hub_muses SET last_seen_at = ? WHERE id = ?`).bind(Date.now(), row.id).run(); } catch (e) {}
  return row;
}

export async function handleHubApi(request, env, url, admin) {
  const hj = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  try {
    await ensureSchema(env);
    const path = url.pathname;
    // Auth: kunci Muse ATAU sesi admin. Tanpa keduanya -> 404 (sama seperti path tidak ada).
    const muse = await authHubMuse(request, env);
    const isAdm = !!admin;
    if (!muse && !isAdm) return hj({ ok: false, error: 'not found' }, 404);
    // Sesi admin wajib membawa x-csrf (pola cerpen-admin); kunci Muse
    // tidak butuh CSRF karena bukan sesi cookie.
    if (isAdm && !muse) {
      if (String(request.headers.get('x-csrf') || '') !== await csrfToken(env)) return hj({ ok: false, error: 'csrf tidak valid' }, 403);
    }
    if (!(await checkRateLimit(env, 'hub:' + clientIp(request), 60, 10 * 60 * 1000))) return hj({ ok: false, error: 'terlalu banyak permintaan' }, 429);
    async function readJsonBody() {
      const raw = await request.text();
      if (raw.length > 100 * 1024) return { err: 'body terlalu besar (maks 100 KB)' };
      if (!raw.trim()) return { body: {} };
      try { return { body: JSON.parse(raw) }; } catch (e) { return { err: 'body JSON tidak valid' }; }
    }

    // GET /api/hub/status — health + hitungan (kunci Muse atau admin).
    if (path === '/api/hub/status' && request.method === 'GET') {
      const m = await env.DB.prepare(`SELECT COUNT(*) AS c FROM hub_muses`).first();
      const t = await env.DB.prepare(`SELECT COUNT(*) AS c FROM hub_tasks WHERE status = 'baru'`).first();
      const d = await env.DB.prepare(`SELECT COUNT(*) AS c FROM hub_tasks WHERE status = 'dikerjakan'`).first();
      return hj({ ok: true, muses: Number(m && m.c) || 0, tasks_baru: Number(t && t.c) || 0, tasks_dikerjakan: Number(d && d.c) || 0, now: Date.now() });
    }

    // GET /api/hub/tasks?to=<id>&status=baru — antrean tugas.
    // Muse hanya boleh melihat tugas untuk dirinya sendiri (to dipaksa ke
    // id-nya); admin boleh memfilter to apa pun / tanpa filter.
    if (path === '/api/hub/tasks' && request.method === 'GET') {
      const qTo = String(url.searchParams.get('to') || '');
      const qStatus = String(url.searchParams.get('status') || '');
      if (muse && qTo && qTo !== muse.id) return hj({ ok: false, error: 'not found' }, 404);
      if (qStatus && !HUB_STATUSES.includes(qStatus)) return hj({ ok: false, error: 'status tidak valid' }, 400);
      const rows = await env.DB.prepare(`SELECT id, room, from_muse, to_muse, title, body, status, done_note, created_at, updated_at FROM hub_tasks ORDER BY created_at DESC LIMIT 200`).all();
      let tasks = rows.results || [];
      const wantTo = muse ? muse.id : qTo;
      if (wantTo) tasks = tasks.filter(t => t.to_muse === wantTo);
      if (qStatus) tasks = tasks.filter(t => t.status === qStatus);
      return hj({ ok: true, tasks: tasks.slice(0, 50) });
    }

    // POST /api/hub/tasks — beri perintah ke Muse lain.
    // from_muse = Muse yang terautentikasi (atau 'admin').
    if (path === '/api/hub/tasks' && request.method === 'POST') {
      const { body, err } = await readJsonBody();
      if (err) return hj({ ok: false, error: err }, 400);
      const toMuse = String(body.to_muse || '').trim();
      const title = String(body.title || '').trim();
      const taskBody = String(body.body || '').slice(0, 5000);
      const room = String(body.room || 'kantor').trim();
      if (!HUB_MUSE_ID_RE.test(toMuse)) return hj({ ok: false, error: 'to_muse tidak valid' }, 400);
      if (!title || title.length > 200) return hj({ ok: false, error: 'title wajib 1-200 karakter' }, 400);
      if (!HUB_ROOM_RE.test(room)) return hj({ ok: false, error: 'room tidak valid' }, 400);
      const target = await env.DB.prepare(`SELECT id FROM hub_muses WHERE id = ?`).bind(toMuse).first();
      if (!target) return hj({ ok: false, error: 'muse tujuan tidak dikenal' }, 400);
      const now = Date.now();
      const id = 'task-' + randomHex(12);
      const from = muse ? muse.id : 'admin';
      await env.DB.prepare(`INSERT INTO hub_tasks (id, room, from_muse, to_muse, title, body, status, done_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'baru', '', ?, ?)`).bind(id, room, from, toMuse, title, taskBody, now, now).run();
      return hj({ ok: true, task: { id, room, from_muse: from, to_muse: toMuse, title, body: taskBody, status: 'baru', done_note: '', created_at: now, updated_at: now } }, 201);
    }

    // POST /api/hub/tasks/:id/status — Muse yang ditugasi (atau admin)
    // mengubah status + catatan selesai.
    const mStatus = path.match(/^\/api\/hub\/tasks\/([^/]+)\/status$/);
    if (mStatus && request.method === 'POST') {
      const taskId = decodeURIComponent(mStatus[1]);
      const { body, err } = await readJsonBody();
      if (err) return hj({ ok: false, error: err }, 400);
      const status = String(body.status || '').trim();
      const note = String(body.note || '').slice(0, 1000);
      if (!HUB_STATUSES.includes(status)) return hj({ ok: false, error: 'status tidak valid' }, 400);
      const row = await env.DB.prepare(`SELECT id, room, from_muse, to_muse, title, body, status, done_note, created_at, updated_at FROM hub_tasks WHERE id = ?`).bind(taskId).first();
      if (!row) return hj({ ok: false, error: 'tugas tidak ditemukan' }, 404);
      if (muse && row.to_muse !== muse.id) return hj({ ok: false, error: 'not found' }, 404);
      const now = Date.now();
      await env.DB.prepare(`UPDATE hub_tasks SET status = ?, done_note = ?, updated_at = ? WHERE id = ?`).bind(status, note, now, taskId).run();
      return hj({ ok: true, task: { ...row, status, done_note: note, updated_at: now } });
    }

    // GET /api/hub/muses — daftar Muse (admin saja; tanpa key_hash).
    if (path === '/api/hub/muses' && request.method === 'GET') {
      if (!isAdm) return hj({ ok: false, error: 'not found' }, 404);
      const rows = await env.DB.prepare(`SELECT id, name, room, created_at, last_seen_at FROM hub_muses ORDER BY created_at ASC`).all();
      return hj({ ok: true, muses: rows.results || [] });
    }

    // POST /api/hub/muses — daftarkan Muse baru (admin saja). Kunci acak
    // dibuat di server; yang disimpan HANYA hash SHA-256-nya; plaintext
    // kunci dikembalikan SEKALI di respons ini — panel menampilkannya
    // sekali + tombol salin, lalu tidak pernah bisa dilihat lagi.
    if (path === '/api/hub/muses' && request.method === 'POST') {
      if (!isAdm) return hj({ ok: false, error: 'not found' }, 404);
      const { body, err } = await readJsonBody();
      if (err) return hj({ ok: false, error: err }, 400);
      const id = String(body.id || '').trim().toLowerCase();
      const name = String(body.name || '').trim();
      const room = String(body.room || 'kantor').trim();
      if (!HUB_MUSE_ID_RE.test(id)) return hj({ ok: false, error: 'id tidak valid (huruf kecil/angka/_/-, maks 32)' }, 400);
      if (!name || name.length > 80) return hj({ ok: false, error: 'name wajib 1-80 karakter' }, 400);
      if (!HUB_ROOM_RE.test(room)) return hj({ ok: false, error: 'room tidak valid' }, 400);
      const clash = await env.DB.prepare(`SELECT id FROM hub_muses WHERE id = ?`).bind(id).first();
      if (clash) return hj({ ok: false, error: 'id sudah terdaftar' }, 409);
      const key = HUB_KEY_PREFIX + randomHex(32);
      const keyHash = await sha256Hex(key);
      const now = Date.now();
      await env.DB.prepare(`INSERT INTO hub_muses (id, name, key_hash, room, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)`).bind(id, name, keyHash, room, now).run();
      return hj({ ok: true, muse: { id, name, room, created_at: now, last_seen_at: null }, key }, 201);
    }

    return hj({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    return hj({ ok: false, error: 'kesalahan server' }, 500);
  }
}

// ---- Admin: panel /kendali/hub ----
// Sengaja tanpa <table>: daftar memakai .adm-row/.adm-stats seperti panel
// admin lain, supaya tidak meluber di layar HP.
export async function renderHubPanel(env, csrf, nav, notice, url) {
  await ensureSchema(env);
  const fStatus = String(url.searchParams.get('status') || '');
  const statusValid = HUB_STATUSES.includes(fStatus);
  const [musesRes, tasksRes, cBaru, cKerja, cSelesai] = await Promise.all([
    env.DB.prepare(`SELECT id, name, room, created_at, last_seen_at FROM hub_muses ORDER BY created_at ASC`).all(),
    env.DB.prepare(`SELECT id, room, from_muse, to_muse, title, body, status, done_note, created_at, updated_at FROM hub_tasks ORDER BY created_at DESC LIMIT 50`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM hub_tasks WHERE status = 'baru'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM hub_tasks WHERE status = 'dikerjakan'`).first(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM hub_tasks WHERE status = 'selesai'`).first(),
  ]);
  const muses = musesRes.results || [];
  let tasks = tasksRes.results || [];
  if (statusValid) tasks = tasks.filter(t => t.status === fStatus);
  const statusBadge = s => s === 'baru' ? '<b style="color:#b45309">BARU</b>' : s === 'dikerjakan' ? '<b style="color:#2563eb">DIKERJAKAN</b>' : s === 'selesai' ? '<b style="color:#16a34a">SELESAI</b>' : '<b style="color:#6b7280">BATAL</b>';
  const museRows = muses.map(m => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(m.id)} · ${esc(m.name)}</span><div class="adm-row-meta">room ${esc(m.room)} · terdaftar ${esc(wib(m.created_at))} WIB · terakhir polling ${m.last_seen_at ? esc(wib(m.last_seen_at)) + ' WIB' : 'belum pernah'}</div></div></div>`).join('') || '<p>Belum ada Muse terdaftar. Daftarkan yang pertama di bawah.</p>';
  const taskRows = tasks.map(t => `<div class="adm-row"><div class="adm-row-body"><span class="adm-row-title">${esc(t.title)}</span><div class="adm-row-meta">${esc(t.from_muse)} → ${esc(t.to_muse)} · room ${esc(t.room)} · ${esc(wib(t.created_at))} WIB</div>${t.body ? `<div class="adm-row-meta" style="word-break:break-word">${esc(String(t.body).slice(0, 300))}</div>` : ''}${t.done_note ? `<div class="adm-row-meta">Catatan: ${esc(String(t.done_note).slice(0, 300))}</div>` : ''}</div>${statusBadge(t.status)}</div>`).join('') || '<p>Belum ada tugas.</p>';
  const statusOpts = [''].concat(HUB_STATUSES).map(s => `<option value="${esc(s)}"${(statusValid ? fStatus : '') === s ? ' selected' : ''}>${s === '' ? 'semua status' : s}</option>`).join('');
  const copyScript = `<script>(function(){async function copyText(t){try{await navigator.clipboard.writeText(t);return true;}catch(e){try{var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();var ok=document.execCommand('copy');document.body.removeChild(ta);return ok;}catch(e2){return false;}}}document.querySelectorAll('[data-hub-copy]').forEach(function(b){b.addEventListener('click',async function(){var ok=await copyText(b.getAttribute('data-hub-copy')||'');b.textContent=ok?'Tersalin':'Gagal menyalin';setTimeout(function(){b.textContent='Salin';},2000);});});})();</script>`;
  const panelScript = `<script>
const HUB_CSRF = "${csrf}";
const hubMsg = document.getElementById('hub-muse-msg');
function hubShowMsg(text, ok) { hubMsg.innerHTML = '<div class="card" style="border-color:' + (ok ? '#22c55e' : '#dc2626') + '"><p><b>' + (ok ? 'Berhasil:' : 'Gagal:') + '</b> ' + text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</p></div>'; }
async function hubCall(method, url, body) {
  const res = await fetch(url, { method: method, headers: { 'x-csrf': HUB_CSRF, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
document.getElementById('hub-muse-form').addEventListener('submit', async function (e) {
  e.preventDefault();
  const f = e.target;
  try {
    const data = await hubCall('POST', '/api/hub/muses', { id: f.id.value.trim().toLowerCase(), name: f.name.value.trim(), room: f.room.value.trim() || 'kantor' });
    document.getElementById('hub-key-text').textContent = data.key;
    document.getElementById('hub-key-copy').setAttribute('data-hub-copy', data.key);
    document.getElementById('hub-key-box').hidden = false;
    hubShowMsg('Muse ' + data.muse.id + ' terdaftar. Kunci di bawah hanya tampil sekali — salin sekarang.', true);
  } catch (err) { hubShowMsg(err.message, false); }
});
</script>`;
  return `<h2>Hub Muse</h2>${nav}${notice}`
    + `<div class="card"><h3>Ringkasan</h3><div class="adm-stats"><div class="adm-stat"><span class="adm-stat-num">${muses.length}</span><span class="adm-stat-label">Muse terdaftar</span></div><div class="adm-stat"><span class="adm-stat-num">${Number(cBaru && cBaru.c) || 0}</span><span class="adm-stat-label">tugas baru</span></div><div class="adm-stat"><span class="adm-stat-num">${Number(cKerja && cKerja.c) || 0}</span><span class="adm-stat-label">dikerjakan</span></div><div class="adm-stat"><span class="adm-stat-num">${Number(cSelesai && cSelesai.c) || 0}</span><span class="adm-stat-label">selesai</span></div></div><p style="font-size:13px;opacity:.7">Tiap Muse (Alyaa, Sekar, dst) polling <code>GET /api/hub/tasks?to=&lt;id&gt;&amp;status=baru</code> dengan kuncinya sendiri, lalu mengubah status lewat <code>POST /api/hub/tasks/:id/status</code>. Kunci plaintext tidak pernah disimpan di server — yang tersimpan hanya hash SHA-256-nya.</p></div>`
    + `<div class="card"><h3>Daftarkan Muse baru</h3><div id="hub-muse-msg"></div><form id="hub-muse-form"><label>ID (huruf kecil/angka/_/-, maks 32)<input name="id" required maxlength="32" pattern="[a-z0-9][a-z0-9_-]{0,31}" placeholder="mis. sekar" autocomplete="off"></label><label>Nama<input name="name" required maxlength="80" placeholder="mis. Sekar Larasati"></label><label>Room<input name="room" maxlength="32" placeholder="kantor" value="kantor"></label><p><button type="submit">Daftarkan Muse</button></p></form><div id="hub-key-box" hidden><p><b>Kunci Muse baru — hanya tampil sekali, salin sekarang:</b></p><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><code id="hub-key-text" style="word-break:break-all;font-size:15px"></code><button type="button" id="hub-key-copy" data-hub-copy="">Salin</button></div><p style="font-size:13px;opacity:.7">Setelah halaman dimuat ulang, kunci ini tidak bisa dilihat lagi — yang tersimpan di server hanya hash-nya. Tempel kunci ini di pihak Muse yang bersangkutan.</p></div></div>`
    + `<div class="card"><h3>Daftar Muse</h3>${museRows}</div>`
    + `<div class="card"><h3>Tugas terbaru</h3><form method="get" action="/kendali/hub" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end"><label style="margin:0">Status<select name="status">${statusOpts}</select></label><button type="submit">Filter</button></form>${taskRows}</div>`
    + copyScript + panelScript;
}
