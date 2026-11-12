// reading.js — Pelacak waktu baca + statistik + first-visit + Stopwatch Abadi (v81).
//
// ALGORITMA WAKTU BACA (perintah pemilik, 12 Nov 2026):
//   Waktu baca HANYA terhitung saat pengguna sedang scroll KE BAWAH (aktif
//   maju membaca konten). Aturan yang dipakai:
//   1. Detik aktif dihitung per 1 detik (ticker) bila SEMUA kondisi ini benar:
//      - halaman terlihat (document.visibilityState === 'visible'), dan
//      - ada aktivitas (scroll / ketik / sentuh) dalam 15 detik terakhir
//        (IDLE_MS), dan
//      - pengguna sudah pernah scroll ke bawah minimal sekali di halaman ini
//        (baru menatap bagian atas tanpa scroll = belum mulai membaca).
//   2. Scroll ke ATAS tidak menambah hitungan baru (kemajuan hanya maju),
//      tapi menit yang sudah didapat TETAP tersimpan — tidak pernah dikurangi.
//   3. Diam > 15 detik tanpa aktivitas apa pun = pause (tidak dihitung).
//   4. Flush ke server tiap 30 detik bila ada detik tertunda, plus saat
//      halaman disembunyikan/ditutup (sendBeacon). Gagal kirim = diam
//      (fail-open, tidak mengganggu baca); detik tertunda disimpan untuk
//      percobaan berikut, dibatasi 600 detik.
//   5. Server membatasi: maks 120 detik per flush, maks 6 flush/menit per
//      akun (rate limit), maks 4 jam per akun per hari (WIB). Lebih dari itu
//      diterima sebagai ok tapi tidak disimpan (anti-borong).
//   6. Hanya akun komentator yang tercatat (anonim ditolak). Admin tidak
//      dilacak — statistik ini untuk akun komentator.
//
// PENYIMPANAN (D1 cms-db, agregat — bukan baris mentah per flush):
//   - cms_reading_sessions (user_id, day_wib, post_id, seconds, max_scroll):
//     satu baris per akun/hari/post, UPSERT menambah detik + MAX scroll.
//   - cms_reading_hours (user_id, day_wib, hour_wib, seconds): satu baris
//     per akun/hari/jam (WIB), UPSERT menambah detik.
//   - cms_users.reading_private (0 = terlihat pengguna lain di fase 2,
//     1 = private; default 0). Fase 1: hanya pemilik + super admin yang
//     bisa lihat; endpoint publik belum dibangun.
//   Data baca TIDAK di-prune seperti view events: total menit adalah
//   riwayat akun, dan prune akan mengecilkan total diam-diam. Volume
//   dibatasi kunci primer (maks 1 baris per akun/hari/post + per
//   akun/hari/jam).
//
// ALGORITMA FIRST-VISIT (perintah pemilik, 12 Nov 2026):
//   Hanya untuk pengunjung BARU di beranda halaman 1: tanpa sesi admin,
//   tanpa sesi akun komentator, tanpa cookie cms_fv. Komposisi 10 slot:
//   4 terbaru + 3 terpopuler (views) + 3 rotasi harian (acak deterministik
//   dari tanggal WIB — berubah tiap hari, tanpa simpan state), tanpa
//   pengulangan item. Setelah tampil sekali, cookie cms_fv=1 (30 hari)
//   dipasang supaya kunjungan berikut memakai beranda normal. Pengunjung
//   yang sudah punya riwayat TIDAK berubah perilakunya.
//
// STOPWATCH ABADI (perintah pemilik, 12 Nov 2026):
//   Sama seperti "Stopwatch Abadi" di aplikasi Hozin Tools: BUKAN stopwatch
//   start/pause/reset/lap — melainkan penghitung naik abadi sejak satu
//   start_time yang tersimpan di D1 stopwatch-db (tabel eternal_stopwatch,
//   user default_user), plus kartu countdown hari besar & event. Di /uptime,
//   start_time dibaca server-side dari BACKUP_DB (binding stopwatch-db),
//   jadi tidak perlu tombol sync seperti di aplikasi.

export const READING_IDLE_MS = 15000;
export const READING_TICK_MS = 1000;
export const READING_FLUSH_MS = 30000;
export const READING_PENDING_CAP_SECONDS = 600;
export const HEARTBEAT_MAX_SECONDS = 120;
export const READING_DAILY_CAP_SECONDS = 4 * 3600;
export const READING_RATE_LIMIT = 6;
export const READING_RATE_WINDOW_MS = 60 * 1000;

export const WIB_OFFSET_MS = 7 * 3600 * 1000;
export const WIB_DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

// Bagian tanggal/jam WIB dari timestamp ms. dayIdx: 0 = Minggu.
export function wibParts(tsMs) {
  const d = new Date(Number(tsMs) + WIB_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { date: `${y}-${m}-${day}`, hour: d.getUTCHours(), dayIdx: d.getUTCDay(), dayName: WIB_DAY_NAMES[d.getUTCDay()] };
}

// Agregasi statistik baca satu akun dari baris agregat D1.
// sessionRows: [{day_wib, seconds}], hourRows: [{hour_wib, seconds}].
// topDay: hari dengan detik terbanyak (seri -> tanggal paling awal).
// hourRange: rentang jam tersering — jam puncak + jam tetangga yang
// detiknya >= 50% puncak, dihitung melingkar 24 jam (boleh melewati
// tengah malam, mis. "23:00–02:00").
export function computeReadingStats(sessionRows, hourRows) {
  const sessions = Array.isArray(sessionRows) ? sessionRows : [];
  const hours = Array.isArray(hourRows) ? hourRows : [];
  let totalSeconds = 0;
  const byDay = new Map();
  for (const r of sessions) {
    const s = Math.max(0, Number(r.seconds) || 0);
    totalSeconds += s;
    byDay.set(String(r.day_wib), (byDay.get(String(r.day_wib)) || 0) + s);
  }
  let topDay = null;
  for (const [date, s] of [...byDay.entries()].sort()) {
    if (!topDay || s > topDay.seconds) topDay = { date, seconds: s };
  }
  if (topDay) {
    const idx = new Date(topDay.date + 'T00:00:00Z').getUTCDay();
    topDay.name = WIB_DAY_NAMES[idx];
    topDay.minutes = Math.floor(topDay.seconds / 60);
  }
  return {
    totalSeconds,
    totalMinutes: Math.floor(totalSeconds / 60),
    daysActive: byDay.size,
    topDay,
    hourRange: hourRangeFromHours(hours),
  };
}

export function hourRangeFromHours(hourRows) {
  const byHour = new Map();
  for (const r of (Array.isArray(hourRows) ? hourRows : [])) {
    const h = Number(r.hour_wib);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    byHour.set(h, (byHour.get(h) || 0) + Math.max(0, Number(r.seconds) || 0));
  }
  if (!byHour.size) return null;
  let peakHour = 0;
  let peak = -1;
  for (const [h, s] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    if (s > peak) { peak = s; peakHour = h; }
  }
  const threshold = peak * 0.5;
  let start = peakHour;
  let len = 1;
  while (len < 24 && (byHour.get((peakHour - len + 24 * 10) % 24) || 0) >= threshold) { start = (peakHour - len + 24) % 24; len++; }
  while (len < 24 && (byHour.get((peakHour + len) % 24) || 0) >= threshold) len++;
  const pad = n => String(n).padStart(2, '0');
  return {
    startHour: start,
    endHour: (start + len) % 24,
    peakHour,
    label: `${pad(start)}:00–${pad((start + len) % 24)}:00`,
  };
}

// Detik aktif dari jejak event (dipakai tes; tracker di browser memakai
// logika yang sama, lihat readingTrackerScript): sebuah detik dihitung
// hanya bila event scroll terjadi DAN posisi scroll naik (y lebih besar
// dari event sebelumnya) DAN jeda dari aktivitas terakhir <= idleMs.
// Scroll ke atas tidak menambah; diam > idleMs memutus rantai (detik
// setelah jeda panjang tidak dihitung mundur). Event input tanpa scroll
// hanya menjaga sesi tetap hidup (memperbarui lastActive).
export function countActiveSeconds(events, idleMs = READING_IDLE_MS) {
  let active = 0;
  let prevY = 0;
  let lastActive = null;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  for (const ev of sorted) {
    if (ev.y > prevY) {
      if (lastActive !== null) {
        const dt = Math.floor((ev.t - lastActive) / 1000);
        if (dt > 0 && dt * 1000 <= idleMs) active += dt;
      }
      lastActive = ev.t;
    } else {
      lastActive = ev.t;
    }
    prevY = ev.y;
  }
  return active;
}

// Acak deterministik (mulberry32) untuk rotasi harian first-visit.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Komposisi first-visit dari daftar post (urut publish_at DESC).
// seedDate: string tanggal WIB 'YYYY-MM-DD' — rotasi berubah tiap hari.
// Kembalian: { ordered, newest, popular, rotation } (tanpa duplikat).
export function pickFirstVisit(posts, seedDate) {
  const list = (Array.isArray(posts) ? posts : []).filter(p => p && p.id);
  const seen = new Set();
  const take = (arr, n) => {
    const out = [];
    for (const p of arr) {
      if (out.length >= n) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
    return out;
  };
  const newest = take(list, 4);
  const byViews = [...list].sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
  const popular = take(byViews, 3);
  const rest = list.filter(p => !seen.has(p.id));
  let seed = 0;
  for (const ch of String(seedDate || '')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = mulberry32(seed || 1);
  const pool = [...rest];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const rotation = take(pool, 3);
  return { ordered: [...newest, ...popular, ...rotation], newest, popular, rotation };
}

// Format Stopwatch Abadi, sama seperti aplikasi Hozin Tools.
// Digital: "HHH:MM:SS.cc" (jam 3 digit, centisecond). Detail: rincian
// tahun/bulan/minggu/hari + "HH:MM:SS.mmm".
export function formatStopwatch(ms, detailed) {
  const elapsed = Math.max(0, Number(ms) || 0);
  if (!detailed) {
    const totalSeconds = Math.floor(elapsed / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const cs = Math.floor((elapsed % 1000) / 10);
    const pad2 = n => String(n).padStart(2, '0');
    return `${String(hours).padStart(3, '0')}:${pad2(minutes)}:${pad2(seconds)}.${pad2(cs)}`;
  }
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  const remMillis = elapsed % 1000;
  const remSec = seconds % 60;
  const remMin = minutes % 60;
  const remHour = hours % 24;
  const remDay = days % 30;
  const remMonth = months % 12;
  const pad2 = n => String(n).padStart(2, '0');
  const parts = [];
  if (years > 0) parts.push(`${years} Thn`);
  if (months > 0 || years > 0) parts.push(`${remMonth} Bln`);
  if (weeks > 0 || months > 0 || years > 0) parts.push(`${weeks} Mgg`);
  if (days > 0 || weeks > 0 || months > 0 || years > 0) parts.push(`${remDay} Hari`);
  return (parts.length ? parts.join(' ') + '\n' : '') + `${pad2(remHour)}:${pad2(remMin)}:${pad2(remSec)}.${String(remMillis).padStart(3, '0')}`;
}

// Event countdown Stopwatch Abadi — sama persis seperti aplikasi:
// Idul Fitri & Idul Adha memakai tanggal Hijri yang sudah dihitung di
// aplikasi (hardcode, 5 tahun ke depan); sisanya tanggal Gregorian yang
// bergulir ke tahun berikut bila sudah lewat. GTA 6: jendela rilis
// estimasi 15 November (sama seperti aplikasi).
export const STOPWATCH_EVENTS = [
  { title: 'Idul Fitri (Auto-Next Year)', kind: 'hijri', targets: [1773964800000, 1804560000000, 1835068800000, 1865577600000, 1896086400000] },
  { title: 'Idul Adha (Auto-Next Year)', kind: 'hijri', targets: [1780012800000, 1810521600000, 1841030400000, 1871539200000] },
  { title: 'Hari Kemerdekaan RI (17 Agustus)', kind: 'gregorian', month: 8, day: 17 },
  { title: 'Tahun Baru Masehi (1 Januari)', kind: 'gregorian', month: 1, day: 1 },
  { title: 'Hari Natal (25 Desember)', kind: 'gregorian', month: 12, day: 25 },
  { title: 'Estimasi GTA 6 Launch Window', kind: 'gregorian', month: 11, day: 15 },
];

export function nextEventMs(ev, nowMs) {
  const now = Number(nowMs) || 0;
  if (ev.kind === 'hijri') {
    for (const t of ev.targets) if (t > now) return t;
    return now + 354 * 86400000;
  }
  const y = new Date(now).getUTCFullYear();
  let t = Date.UTC(y, ev.month - 1, ev.day, 0, 0, 0);
  if (now >= t) t = Date.UTC(y + 1, ev.month - 1, ev.day, 0, 0, 0);
  return t;
}

export function countdownParts(diffMs) {
  const d = Math.max(0, Number(diffMs) || 0);
  return {
    days: Math.floor(d / 86400000),
    hours: Math.floor(d / 3600000) % 24,
    mins: Math.floor(d / 60000) % 60,
    secs: Math.floor(d / 1000) % 60,
  };
}

// Script tracker waktu baca untuk halaman detail post (hanya untuk akun
// komentator yang login; anonim tidak dilacak). Ringan: satu ticker
// 1 detik + listener scroll/input pasif; kirim via fetch/beacon.
export function readingTrackerScript(postId, csrf) {
  const safePost = String(postId || '').replace(/[^A-Za-z0-9_-]/g, '');
  const safeCsrf = String(csrf || '').replace(/[^A-Za-z0-9]/g, '');
  if (!safePost || !safeCsrf) return '';
  const js = `(function(){if(window.__cmsReading)return;window.__cmsReading=1;var IDLE=${READING_IDLE_MS},FLUSH=${READING_FLUSH_MS},CAP=${READING_PENDING_CAP_SECONDS};var lastActivity=0,lastY=window.scrollY||0,maxY=0,pending=0,started=false;function now(){return Date.now()}function markActivity(){lastActivity=now()}window.addEventListener('scroll',function(){var y=window.scrollY||0;if(y>lastY){markActivity();if(y>maxY)maxY=y;started=true}lastY=y},{passive:true});['keydown','touchstart'].forEach(function(ev){window.addEventListener(ev,markActivity,{passive:true})});function maxScrollPermille(){var doc=document.documentElement;var total=doc.scrollHeight-(window.innerHeight||0);if(total<=0)return started?1000:0;return Math.min(1000,Math.round(maxY/total*1000))}function send(useBeacon){if(pending<=0)return;var body=JSON.stringify({post_id:'${safePost}',seconds:pending,max_scroll:maxScrollPermille(),csrf:'${safeCsrf}'});if(useBeacon&&navigator.sendBeacon){try{if(navigator.sendBeacon('/api/reading/heartbeat',new Blob([body],{type:'application/json'}))){pending=0}return}catch(e){}}fetch('/api/reading/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:body,keepalive:true}).then(function(r){if(r.ok)pending=0}).catch(function(){})}setInterval(function(){if(document.visibilityState!=='visible')return;if(!started)return;if(now()-lastActivity>IDLE)return;pending=Math.min(CAP,pending+1)},${READING_TICK_MS});setInterval(function(){send(false)},FLUSH);document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')send(true)});window.addEventListener('pagehide',function(){send(true)});})();`;
  return `<script data-reading-tracker>${js}<\/script>`;
}
