// OTP email untuk verifikasi pendaftaran komentator (v83).
// Pengiriman lewat Resend (free tier 3.000 email/bulan, maks 100/hari) —
// Worker tidak bisa kirim email sendiri. Secret Worker RESEND_API_KEY wajib;
// tanpa itu pengiriman gagal jujur (tidak ada kode yang pura-pura terkirim).
// From default onboarding@resend.dev HANYA bisa kirim ke email pemilik akun
// Resend itu sendiri — untuk kirim ke pendaftar mana pun, domain
// hozinking.my.id wajib diverifikasi dulu di Resend, lalu set secret
// RESEND_FROM = 'Hozin King <noreply@hozinking.my.id>'.
import { sha256Hex } from './util.js';

export const OTP_TTL_MS = 10 * 60 * 1000; // kode berlaku 10 menit
export const OTP_MAX_ATTEMPTS = 5; // percobaan verifikasi per kode
export const OTP_SEND_LIMIT = 3; // kode per email per jam
export const OTP_SEND_WINDOW_MS = 60 * 60 * 1000;

export function randomOtpCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

export function validEmail(email) {
  return typeof email === 'string' && email.length > 0 && email.length <= 128
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// Bandingkan hash best-effort constant-time (tanpa early-exit), pola yang
// sama dengan verifyPassword di auth.js.
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sendOtpEmail(env, email, code) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'email_not_configured' };
  const from = env.RESEND_FROM || 'Hozin King <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Kode verifikasi akun hozinking.my.id',
        html: `<p>Kode verifikasi akun <b>hozinking.my.id</b> kamu:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Kode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun.</p>`,
        text: `Kode verifikasi akun hozinking.my.id kamu: ${code}. Kode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun.`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: 'email_send_failed' };
    return { ok: true };
  } catch {
    return { ok: false, error: 'email_send_failed' };
  }
}

// Buat (atau ganti) kode untuk email lalu kirim. Satu kode aktif per email.
// Bila pengiriman gagal, baris kode dihapus supaya kirim ulang bisa bersih.
export async function issueOtp(env, email) {
  const code = randomOtpCode();
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO cms_otp_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)`
  ).bind(email, codeHash, now + OTP_TTL_MS, now).run();
  const sent = await sendOtpEmail(env, email, code);
  if (!sent.ok) {
    await env.DB.prepare(`DELETE FROM cms_otp_codes WHERE email = ?`).bind(email).run();
    return sent;
  }
  return { ok: true };
}

// Verifikasi kode: hash saja yang tersimpan, plaintext tidak pernah ke D1.
// Kode salah menambah attempts; habis masa berlaku / habis percobaan =
// kode dihapus. Pesan gagal sengaja generik (pemanggil yang menampilkan).
export async function verifyOtp(env, email, code) {
  const row = await env.DB.prepare(`SELECT * FROM cms_otp_codes WHERE email = ?`).bind(email).first();
  if (!row) return { ok: false };
  if (Number(row.attempts) >= OTP_MAX_ATTEMPTS || Date.now() > Number(row.expires_at)) {
    await env.DB.prepare(`DELETE FROM cms_otp_codes WHERE email = ?`).bind(email).run();
    return { ok: false };
  }
  const ok = safeEqualHex(await sha256Hex(String(code || '').trim()), row.code_hash);
  if (!ok) {
    await env.DB.prepare(`UPDATE cms_otp_codes SET attempts = attempts + 1 WHERE email = ?`).bind(email).run();
    return { ok: false };
  }
  await env.DB.prepare(`DELETE FROM cms_otp_codes WHERE email = ?`).bind(email).run();
  return { ok: true };
}
