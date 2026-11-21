// build.mjs — build Worker hozin-cms (audit keamanan 21 Nov 2026).
//
// 1. Salin sumber ke dist/src/.
// 2. Minify skrip inline panel admin di salinan itu (esbuild, TANPA mangling
//    identifier) — blok yang gagal verifikasi dilewati apa adanya (fail-closed).
// 3. Minify konstanta globeScript (skrip globe halaman /uptime) dengan cara sama.
// 4. Bundle dist/src/worker.js dengan esbuild --minify -> dist/worker.js.
// 5. Verifikasi: tiap dist/src/*.js lolos node --check; bundle bisa di-import
//    dan export default-nya punya fetch(); jumlah penutup </script> per file
//    tidak berubah (menangkap pemotongan blok yang salah).
//
// TIDAK dipakai obfuscator berat / "enkripsi" JS: JS harus bisa jalan di
// browser sehingga selalu bisa dikembalikan, dan repo ini publik sehingga
// sumbernya memang terbaca. Minify di sini murni mengecilkan ukuran +
// menghilangkan komentar, bukan keamanan.
//
// Jalankan: npm ci && node build.mjs
// Uji bundle hasil build: npm run test:dist (seluruh suite lawan dist/).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync, transformSync } from 'esbuild';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(ROOT, 'dist', 'src');
const OUT_FILE = join(ROOT, 'dist', 'worker.js');
const OUT_UNMINIFIED = join(ROOT, 'dist', 'worker.unminified.js');

// Interpolasi template literal luar yang BOLEH muncul di dalam skrip inline.
// Selain daftar ini, ${...} di dalam skrip adalah literal (tertulis \${...})
// atau kesalahan — keduanya tidak diganti placeholder. Urutan: terpanjang dulu
// supaya ${JSON.stringify(csrf)} tidak tertelan ${csrf}.
const INTERP_ALLOWLIST = [
  '${JSON.stringify(csrf)}',
  '${globeJson}',
  '${feedJson}',
  '${startMs}',
  '${csrf}',
].sort((a, b) => b.length - a.length);

const PH_PREFIX = '__AUDIT_PH_';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unescape nilai template literal JS (apa yang dilihat runtime) dari teks
// sumber di dalam backtick. Menangani \\, \`, \$, \n, \r, \t, \x.., \u....,
// \u{...}, dan line continuation.
function templateUnescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const n = s[i + 1];
    if (n === 'n') { out += '\n'; i++; }
    else if (n === 'r') { out += '\r'; i++; }
    else if (n === 't') { out += '\t'; i++; }
    else if (n === 'b') { out += '\b'; i++; }
    else if (n === 'f') { out += '\f'; i++; }
    else if (n === 'v') { out += '\v'; i++; }
    else if (n === '0' && (i + 2 >= s.length || !/[0-9]/.test(s[i + 2]))) { out += '\0'; i++; }
    else if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 3; }
    else if (n === 'u' && s[i + 2] === '{') {
      const e = s.indexOf('}', i + 3);
      const cp = e === -1 ? NaN : parseInt(s.slice(i + 3, e), 16);
      if (Number.isFinite(cp)) { out += String.fromCodePoint(cp); i = e; }
      else out += c;
    }
    else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 5; }
    else if (n === '\n') { i++; } // line continuation -> hilang
    else if (n === '\r' && s[i + 2] === '\n') { i += 2; }
    else { out += n; i++; } // \\ ` $ ' " dan lainnya -> karakter itu sendiri
  }
  return out;
}

// Escape kembali nilai runtime supaya aman ditaruh di dalam template literal.
function templateEscape(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

// Minify satu blok JS inline. `code` = isi blok APA ADANYA dari file sumber
// (teks di dalam template literal). Kembalikan teks hasil minify yang SUDAH
// di-escape untuk template literal, atau null bila blok harus dilewati.
function minifyInlineJs(code, label) {
  if (!code.trim()) return null;
  // 1. Placeholder untuk interpolasi luar (hanya yang TIDAK di-escape).
  const used = [];
  let tmp = code;
  for (const interp of INTERP_ALLOWLIST) {
    const re = new RegExp('(?<!\\\\)' + escapeRegExp(interp), 'g');
    if (re.test(tmp)) {
      tmp = tmp.replace(re, PH_PREFIX + used.length + '__');
      used.push(interp);
    }
  }
  // Blok yang isinya hanya interpolasi (blok JSON, ${globeScript}, ${js})
  // bukan JS — lewati.
  if (!tmp.replace(new RegExp(PH_PREFIX + '\\d+__', 'g'), '').trim()) return null;
  // 2. Unescape template literal -> nilai runtime (JS asli).
  let runtime;
  try {
    runtime = templateUnescape(tmp);
  } catch (e) {
    console.log(`  [lewat] ${label}: templateUnescape gagal (${e.message})`);
    return null;
  }
  // 3. Minify (whitespace + syntax, TANPA mangling identifier).
  let min;
  try {
    min = transformSync(runtime, { loader: 'js', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false }).code.trim();
  } catch (e) {
    console.log(`  [lewat] ${label}: esbuild gagal (${String(e.message).split('\n')[0]})`);
    return null;
  }
  // 4. Placeholder harus utuh + hasil harus bisa di-parse.
  for (let i = 0; i < used.length; i++) {
    if (!min.includes(PH_PREFIX + i + '__')) {
      console.log(`  [lewat] ${label}: placeholder ${used[i]} hilang setelah minify`);
      return null;
    }
  }
  try {
    new Function(min); // eslint-disable-line no-new-func
  } catch (e) {
    console.log(`  [lewat] ${label}: hasil minify gagal parse (${e.message})`);
    return null;
  }
  // 5. Escape untuk template literal DULU (placeholder identifier polos,
  //    jadi tidak tersentuh escape), BARU kembalikan interpolasi. Urutan ini
  //    penting: kalau restore dulu, escape akan mengubah ${csrf} (nyata)
  //    menjadi \${csrf} (literal) sehingga token CSRF / data globe tidak
  //    tersubstitusi di halaman hasil render.
  const escaped = templateEscape(min);
  // 6. Round-trip: unescape lagi harus sama persis dengan hasil minify.
  if (templateUnescape(escaped) !== min) {
    console.log(`  [lewat] ${label}: round-trip escape gagal`);
    return null;
  }
  let final = escaped;
  used.forEach((interp, i) => {
    final = final.split(PH_PREFIX + i + '__').join(interp);
  });
  // 7. Nilai runtime teks final harus sama dengan hasil minify (interpolasi
  //    adalah penanda posisi nilai, bukan teks literal).
  let restored = min;
  used.forEach((interp, i) => {
    restored = restored.split(PH_PREFIX + i + '__').join(interp);
  });
  if (templateUnescape(final) !== restored) {
    console.log(`  [lewat] ${label}: round-trip final gagal`);
    return null;
  }
  // 8. Hanya pakai bila benar-benar lebih pendek dari aslinya.
  if (final.length >= code.length) {
    console.log(`  [lewat] ${label}: tidak lebih pendek (${code.length} -> ${final.length})`);
    return null;
  }
  return final;
}

// Cari blok <script>...</script> (penutup </script> atau <\/script>) di teks.
// Lewati kemunculan di dalam komentar baris penuh (baris diawali //).
function* findScriptBlocks(src) {
  const re = /<script[^>]*>/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (src.slice(lineStart, m.index).trimStart().startsWith('//')) continue;
    const end1 = src.indexOf('</script>', m.index);
    const end2 = src.indexOf('<\\/script>', m.index);
    let end = -1;
    let closerLen = 0;
    if (end1 !== -1 && (end2 === -1 || end1 < end2)) { end = end1; closerLen = 9; }
    else if (end2 !== -1) { end = end2; closerLen = 10; }
    if (end === -1) continue;
    yield { openEnd: m.index + m[0].length, closeStart: end, closeEnd: end + closerLen };
  }
}

function countClosers(s) {
  return {
    plain: (s.match(/<\/script>/g) || []).length,
    escaped: (s.match(/<\\\/script>/g) || []).length,
  };
}

const report = { files: [], skipped: 0, minified: 0, beforeInline: 0, afterInline: 0 };

// --- 1. Salin sumber ke dist/src/ ---
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
mkdirSync(SRC_DIR, { recursive: true });
const jsFiles = readdirSync(ROOT).filter((f) => f.endsWith('.js') && f !== 'test.mjs' && f !== 'test-dist.mjs' && f !== 'build.mjs');
for (const f of jsFiles) cpSync(join(ROOT, f), join(SRC_DIR, f));

// --- 2. Minify skrip inline di tiap salinan ---
for (const f of jsFiles) {
  const path = join(SRC_DIR, f);
  let src = readFileSync(path, 'utf8');
  const before = countClosers(src);
  const blocks = [...findScriptBlocks(src)];
  let changed = 0;
  let saved = 0;
  // Proses dari belakang supaya offset blok sebelumnya tidak bergeser.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const code = src.slice(b.openEnd, b.closeStart);
    const min = minifyInlineJs(code, `${f} blok#${i + 1}`);
    if (min === null) { report.skipped++; continue; }
    report.beforeInline += code.length;
    report.afterInline += min.length;
    saved += code.length - min.length;
    src = src.slice(0, b.openEnd) + min + src.slice(b.closeStart);
    changed++;
    report.minified++;
  }
  // --- 3. globeScript (worker.js): konstanta template literal, bukan tag ---
  if (f === 'worker.js') {
    const gm = src.match(/const globeScript = `((?:\\`|[^`])*)`;/);
    if (gm) {
      const min = minifyInlineJs(gm[1], 'worker.js globeScript');
      if (min !== null) {
        report.beforeInline += gm[1].length;
        report.afterInline += min.length;
        saved += gm[1].length - min.length;
        src = src.replace(gm[0], 'const globeScript = `' + min + '`;');
        changed++;
        report.minified++;
      } else report.skipped++;
    }
  }
  if (changed) writeFileSync(path, src);
  const after = countClosers(src);
  if (before.plain !== after.plain || before.escaped !== after.escaped) {
    throw new Error(`${f}: jumlah penutup </script> berubah (${JSON.stringify(before)} -> ${JSON.stringify(after)}) — build dibatalkan`);
  }
  report.files.push({ file: f, blocks: blocks.length, changed, saved });
}

// --- 4. Bundle: baseline tanpa minify (ukuran pembanding) + minify ---
buildSync({ entryPoints: [join(SRC_DIR, 'worker.js')], bundle: true, format: 'esm', outfile: OUT_UNMINIFIED });
buildSync({ entryPoints: [join(SRC_DIR, 'worker.js')], bundle: true, format: 'esm', minify: true, outfile: OUT_FILE });

// --- 5. Verifikasi ---
for (const f of jsFiles) {
  execFileSync(process.execPath, ['--check', join(SRC_DIR, f)], { stdio: 'pipe' });
}
const sizeUnmin = statSync(OUT_UNMINIFIED).size;
const sizeMin = statSync(OUT_FILE).size;
const bundle = await import(OUT_FILE + '?v=' + Date.now());
if (typeof bundle.default?.fetch !== 'function') throw new Error('bundle dist/worker.js tidak mengekspor default.fetch');

console.log('build OK');
console.log(`  skrip inline: ${report.minified} diminify, ${report.skipped} dilewati, ${report.beforeInline} -> ${report.afterInline} karakter (hemat ${report.beforeInline - report.afterInline})`);
for (const r of report.files.filter((x) => x.blocks)) {
  console.log(`  ${r.file}: ${r.blocks} blok, ${r.changed} diminify, hemat ${r.saved} karakter`);
}
console.log(`  bundle tanpa minify: ${sizeUnmin} B`);
console.log(`  bundle minify      : ${sizeMin} B (hemat ${sizeUnmin - sizeMin} B, ${((1 - sizeMin / sizeUnmin) * 100).toFixed(1)}%)`);
console.log('  dist/worker.js bisa di-import, default.fetch tersedia');
