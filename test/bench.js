'use strict';

// Same thread pool size the app's delete worker uses (must be set before any fs work).
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '64';

// Delete-engine benchmark: builds a node_modules-shaped tree (2,000 packages,
// 100,000 files), then times Wipeout's scan and wipe against the OS's own
// delete command. Run with: npm run bench
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, wipe } = require('../src/wipe-core');

const PACKAGES = Number(process.env.BENCH_PACKAGES || 2000);
const FILES = 50;

function build(root) {
  for (let i = 0; i < PACKAGES; i++) {
    const d = path.join(root, 'node_modules', `pkg-${i}`, 'lib', 'sub');
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < FILES; j++) fs.writeFileSync(path.join(d, `f${j}.js`), 'x'.repeat(300));
  }
}

(async () => {
  const root = path.join(os.tmpdir(), `wipeout-bench-${process.pid}`);
  build(root);
  let t = Date.now();
  const s = await scan(root);
  const scanMs = Date.now() - t;
  t = Date.now();
  const r = await wipe(root);
  const wipeMs = Date.now() - t;

  build(root);
  t = Date.now();
  if (process.platform === 'win32') execSync(`cmd /d /c rmdir /s /q "${root}"`);
  else execSync(`rm -rf "${root}"`);
  const nativeMs = Date.now() - t;

  console.log(JSON.stringify({
    platform: process.platform, cpus: os.cpus().length, files: s.files, dirs: s.dirs,
    scanMs, wipeMs, wipeOk: r.ok, nativeDeleteMs: nativeMs,
    native: process.platform === 'win32' ? 'rmdir /s /q' : 'rm -rf',
  }, null, 2));
})();
