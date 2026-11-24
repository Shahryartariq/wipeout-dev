'use strict';

// Windows-only test for Wipeout Lite (lite/wipeout-lite.exe). Runs the real
// .exe with --json (no dialogs) against folders held by real processes.
// Run with: npm run test:lite   (CI runs it on windows-latest)

const assert = require('assert');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('lite test skipped: not Windows');
  process.exit(0);
}

const exe = path.join(__dirname, '..', 'lite', 'wipeout-lite.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function lite(...args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 120000 });
  assert.ok(r.stdout, `no output from wipeout-lite ${args.join(' ')} (exit ${r.status}) ${r.stderr || ''}`);
  return JSON.parse(r.stdout);
}

function regHas(key) {
  return spawnSync('reg.exe', ['query', key], { encoding: 'utf8' }).status === 0;
}

(async () => {
  assert.ok(fs.existsSync(exe), 'lite/wipeout-lite.exe is built (npm run build:helper)');
  assert.strictEqual(lite('--version').ok, true);
  console.log(`  exe ${Math.round(fs.statSync(exe).size / 1024)} KB`);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wipeout-lite-'));
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive');

  // ---- 1. a project held three ways, with long paths, read-only files and a junction
  const proj = path.join(base, 'project');
  const nm = path.join(proj, 'node_modules');
  for (let i = 0; i < 40; i++) {
    const d = path.join(nm, `pkg${i}`, 'lib');
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < 25; j++) fs.writeFileSync(path.join(d, `f${j}.js`), 'module.exports = 1;');
  }
  let deep = path.join(nm, 'deep');
  while (deep.length < 320) deep = path.join(deep, 'a-rather-long-folder-name');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'past-260.txt'), 'x');
  const ro = path.join(nm, 'readonly.txt');
  fs.writeFileSync(ro, 'x');
  fs.chmodSync(ro, 0o444);
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(nm, 'linked'), outside], { stdio: 'ignore' });
  const held = path.join(proj, 'held.txt');
  fs.writeFileSync(held, 'x');
  const binDir = path.join(proj, 'bin');
  fs.mkdirSync(binDir);
  const nodeCopy = path.join(binDir, 'node-copy.exe');
  fs.copyFileSync(process.execPath, nodeCopy);

  const keepAlive = 'setInterval(() => {}, 1000)';
  const cwdHolder = spawn(process.execPath, ['-e', keepAlive], { cwd: proj, stdio: 'ignore' });
  const fileHolder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(held)}, 'r'); ${keepAlive}`], { stdio: 'ignore' });
  const runner = spawn(nodeCopy, ['-e', keepAlive], { cwd: os.tmpdir(), stdio: 'ignore' });
  const pids = [cwdHolder.pid, fileHolder.pid, runner.pid];
  await sleep(1500);

  try {
    const scan = lite('--scan', proj);
    for (const pid of pids) {
      const h = scan.holders.find((x) => x.pid === pid);
      assert.ok(h, `scan finds process ${pid}`);
      assert.strictEqual(h.willStop, true, `process ${pid} will be stopped`);
    }
    assert.ok(!scan.holders.some((h) => h.pid === process.pid), 'the test runner itself does not hold the folder');
    console.log(`  scan ok (${scan.holders.length} holders)`);

    const t0 = Date.now();
    const r = lite(proj, '--json');
    assert.strictEqual(r.ok, true, `wipe ok: ${JSON.stringify(r)}`);
    assert.ok(!fs.existsSync(proj), 'project folder is gone');
    for (const pid of pids) {
      assert.ok(r.stopped.includes(pid), `reports stopping ${pid}`);
      assert.ok(!alive(pid), `process ${pid} has exited`);
    }
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'the junction target was not touched');
    assert.ok(r.files >= 1000, `deleted ${r.files} files`);
    console.log(`  locked project wiped ok (${r.files} files, ${r.ms} ms in-app, ${Date.now() - t0} ms total)`);
  } finally {
    for (const c of [cwdHolder, fileHolder, runner]) { try { c.kill(); } catch { /* gone */ } }
  }

  // ---- 2. a folder that is itself a junction: only the link goes
  const link = path.join(base, 'just-a-link');
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, outside], { stdio: 'ignore' });
  const lr = lite(link, '--json');
  assert.strictEqual(lr.ok, true);
  assert.strictEqual(lr.linkOnly, true);
  assert.ok(!fs.existsSync(link), 'link removed');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'link target kept');
  console.log('  junction root removes only the link');

  // ---- 3. folders it must refuse
  const refuse = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    os.homedir(),
    path.join(os.homedir(), 'Documents'),
    path.parse(base).root,
  ];
  for (const p of refuse) {
    const x = lite(p, '--json');
    assert.strictEqual(x.ok, false, `refuses ${p}`);
    assert.ok(fs.existsSync(p), `${p} still there`);
  }
  const missing = lite(path.join(base, 'nope'), '--json');
  assert.strictEqual(missing.ok, false);
  console.log(`  refuses ${refuse.length} protected folders`);

  // ---- 4. install and uninstall (current user only, no admin)
  const menu = 'HKCU\\Software\\Classes\\Directory\\shell\\WipeoutLite';
  const apps = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WipeoutLite';
  const ins = lite('--install', '--json');
  assert.strictEqual(ins.ok, true);
  assert.ok(fs.existsSync(ins.installed), 'copied to the install folder');
  assert.ok(regHas(menu + '\\command'), 'right-click entry added');
  assert.ok(regHas(apps), 'listed in Settings > Apps');
  const cmd = spawnSync('reg.exe', ['query', menu + '\\command', '/ve'], { encoding: 'utf8' }).stdout;
  assert.ok(cmd.includes(ins.installed) && cmd.includes('"%1"'), `menu command: ${cmd}`);

  // The installed copy works from the menu's command line.
  const viaMenu = path.join(base, 'via-menu');
  fs.mkdirSync(path.join(viaMenu, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(viaMenu, 'sub', 'a.txt'), 'x');
  const vr = JSON.parse(spawnSync(ins.installed, [viaMenu, '--json'], { encoding: 'utf8' }).stdout);
  assert.strictEqual(vr.ok, true);
  assert.ok(!fs.existsSync(viaMenu));

  const un = JSON.parse(spawnSync(ins.installed, ['--uninstall', '--json'], { encoding: 'utf8' }).stdout);
  assert.strictEqual(un.ok, true);
  assert.ok(!regHas(menu), 'right-click entry removed');
  assert.ok(!regHas(apps), 'Settings > Apps entry removed');
  await sleep(5000);
  assert.ok(!fs.existsSync(path.dirname(ins.installed)), 'install folder removed after exit');
  console.log('  install, run from install folder, uninstall ok');

  fs.rmSync(base, { recursive: true, force: true });
  console.log('All lite tests passed.');
})().catch((err) => { console.error(err); process.exit(1); });
