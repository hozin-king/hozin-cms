// test-dist.mjs — jalankan SELURUH suite (test.mjs) melawan bundle hasil
// build (dist/worker.js), bukan sumber. Menangkap regresi minifikasi:
// skrip inline panel yang rusak akan gagal di new Function() / panel HTML.
// Prasyarat: npm run build sudah jalan (dist/worker.js ada).
// Pakai: npm run test:dist
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST_WORKER = join(ROOT, 'dist', 'worker.js');
if (!existsSync(DIST_WORKER)) {
  console.error('dist/worker.js belum ada — jalankan dulu: npm run build');
  process.exit(1);
}
// File tes sementara tinggal di root (import ./themes.js dll. tetap jalan);
// hanya import worker.js yang dialihkan ke dist/worker.js (termasuk '?fbm-evil=1').
const src = readFileSync(join(ROOT, 'test.mjs'), 'utf8');
const rewritten = src.replaceAll("'./worker.js", "'./dist/worker.js");
if (!rewritten.includes('./dist/worker.js')) throw new Error('tidak ada import worker.js yang terganti');
const tmp = join(ROOT, '.test-dist-run.mjs');
writeFileSync(tmp, rewritten);
try {
  execFileSync(process.execPath, [tmp], { stdio: 'inherit', cwd: ROOT });
} finally {
  rmSync(tmp, { force: true });
}
