'use strict';

// Checks the compiled lock scanner's JSON output. Runs natively on Windows and
// under Mono elsewhere (where only the self-test and error paths can run).
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const exe = path.join(__dirname, '..', 'resources', 'wipeout-locks.exe');
const isWin = process.platform === 'win32';

function hasMono() {
  try { execFileSync('mono', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

if (!fs.existsSync(exe)) {
  console.log('helper tests skipped: resources/wipeout-locks.exe not built (npm run build:helper)');
  process.exit(0);
}
if (!isWin && !hasMono()) {
  console.log('helper tests skipped: needs Windows or Mono');
  process.exit(0);
}
const run = (args, input) => {
  const r = isWin ? spawnSync(exe, args, { input, encoding: 'utf8' }) : spawnSync('mono', [exe, ...args], { input, encoding: 'utf8' });
  return JSON.parse(r.stdout);
};

const st = run(['--self-test']);
assert.strictEqual(st.quote, 'say "hi"');
assert.strictEqual(st.path, 'C:\\Users\\Sherry\\node_modules');
assert.strictEqual(st.control, 'tab\tnewline\nbell\u0007');
assert.strictEqual(st.unicode, 'café مرحبا 🚀');
assert.strictEqual(st.nothing, null);
assert.deepStrictEqual(st.ints, [3000, 5173]);
assert.deepStrictEqual(st.strings, ['a', 'b']);

const noTarget = run([]);
assert.strictEqual(noTarget.ok, false);
assert.match(noTarget.error, /No folder given/);
assert.deepStrictEqual(noTarget.processes, []);

if (isWin) {
  const me = run(['--describe', String(process.pid)]);
  assert.strictEqual(me.exists, true);
  assert.strictEqual(me.name.toLowerCase(), 'node.exe');
  assert.ok(me.startedAt);
  const gone = run(['--describe', '999999']);
  assert.strictEqual(gone.exists, false);
}

console.log('All helper tests passed.');
