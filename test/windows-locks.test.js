'use strict';

// Windows-only integration test for the lock scanner: starts real processes
// that hold a folder in different ways and checks the scanner names them.
//   1. a process whose working folder is inside the target (a terminal's cd)
//   2. a process with a file open inside the target
//   3. a process running from an .exe inside the target
// Run with: npm run test:windows   (CI runs it on windows-latest)

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('windows-locks test skipped: not Windows');
  process.exit(0);
}

const exe = path.join(__dirname, '..', 'resources', 'wipeout-locks.exe');
const ps1 = path.join(__dirname, '..', 'scripts', 'find-locks.ps1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wipeout-locks-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wipeout-other-'));
  const held = path.join(dir, 'held.txt');
  fs.writeFileSync(held, 'x');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const nodeCopy = path.join(binDir, 'node-copy.exe');
  fs.copyFileSync(process.execPath, nodeCopy);

  const keepAlive = 'setInterval(() => {}, 1000)';
  const cwdHolder = spawn(process.execPath, ['-e', keepAlive], { cwd: dir, stdio: 'ignore' });
  const fileHolder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(held)}, 'r'); ${keepAlive}`], { stdio: 'ignore' });
  const runner = spawn(nodeCopy, ['-e', keepAlive], { cwd: os.tmpdir(), stdio: 'ignore' });
  await sleep(1500);

  const check = (data, label) => {
    assert.strictEqual(data.ok, true, `${label}: ${data.error}`);
    const find = (pid) => data.processes.find((p) => p.pid === pid);
    const a = find(cwdHolder.pid);
    assert.ok(a, `${label}: finds the process whose working folder is inside`);
    assert.strictEqual(a.holdsFolder, true, `${label}: working folder counts as holding the folder`);
    const b = find(fileHolder.pid);
    assert.ok(b && b.handleCount >= 1, `${label}: finds the process with a file open`);
    assert.ok(b.samples.some((s) => s.toLowerCase().endsWith('held.txt')), `${label}: lists the held file`);
    const c = find(runner.pid);
    assert.ok(c && c.runsFromFolder, `${label}: finds the program running from inside`);
    assert.strictEqual(a.name.toLowerCase(), 'node.exe');
    assert.ok(a.commandLine && a.commandLine.includes('setInterval'), `${label}: reads the command line`);
    assert.strictEqual(a.parentPid, process.pid, `${label}: knows the parent`);
  };

  try {
    // Compiled helper, with a second folder over stdin to check target indexes.
    const t0 = Date.now();
    const r = spawnSync(exe, ['--stdin'], { input: `${dir}\n${other}\n`, encoding: 'utf8' });
    const data = JSON.parse(r.stdout);
    check(data, 'helper');
    assert.deepStrictEqual(data.processes.find((p) => p.pid === cwdHolder.pid).targets, [0]);
    console.log(`  helper ok (${Date.now() - t0} ms, scan ${data.scanMs} ms)`);

    // PowerShell fallback finds the same things.
    const t1 = Date.now();
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Target', dir], { encoding: 'utf8' });
    check(JSON.parse(ps.stdout.slice(ps.stdout.indexOf('{'))), 'powershell');
    console.log(`  powershell fallback ok (${Date.now() - t1} ms)`);

    // A folder nobody holds comes back empty.
    const empty = JSON.parse(spawnSync(exe, ['--target', other], { encoding: 'utf8' }).stdout);
    assert.strictEqual(empty.ok, true);
    assert.strictEqual(empty.processes.length, 0, 'nothing holds the other folder');
    console.log('All windows-locks tests passed.');
  } finally {
    for (const c of [cwdHolder, fileHolder, runner]) { try { c.kill(); } catch { /* ignore */ } }
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
