'use strict';

// End-to-end flow tests: launches the real Electron app, drives the UI through
// its own functions, and checks the results on disk. Lock scanning needs
// Windows, so on other systems those steps use injected sample data.
//
//   npm run e2e            (Windows)
//   xvfb-run -a npm run e2e   (Linux CI / containers)

const { app } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
process.env.WIPEOUT_NO_UPDATES = '1';
require('../src/main.js');

const SHOTS = process.env.SHOTS || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wipeout-e2e-'));

function makeProject(dir, pkgs, files, ageDays) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  for (let i = 0; i < pkgs; i++) {
    const d = path.join(dir, 'node_modules', `pkg${i}`, 'lib');
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < files; j++) fs.writeFileSync(path.join(d, `f${j}.js`), 'x'.repeat(500));
  }
  const t = (Date.now() - ageDays * 86400000) / 1000;
  fs.utimesSync(path.join(dir, 'package.json'), t, t);
}

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    };
    const waitFor = async (expr, ms = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (await js(expr)) return true;
        await sleep(100);
      }
      throw new Error(`timed out waiting for: ${expr}`);
    };

    console.log('Wipeout end-to-end flows');
    await sleep(800);

    await step('starts on the empty screen', async () => {
      assert.strictEqual(await js('state.view'), 'empty');
      await shot('01-empty');
    });

    const single = path.join(base, 'days_counter');
    makeProject(single, 60, 10, 1500);

    await step('opens a folder and counts its files', async () => {
      await js(`loadFolder(${JSON.stringify(single)})`);
      await waitFor('state.view === "folder" && state.stats && state.stats.files > 0');
      assert.strictEqual(await js('state.stats.files'), 601);
      await shot('02-folder');
    });

    await step('a bad drop keeps the current folder on screen', async () => {
      const file = path.join(base, 'not-a-folder.txt');
      fs.writeFileSync(file, 'x');
      await js(`loadFolder(${JSON.stringify(file)})`);
      await sleep(300);
      assert.strictEqual(await js('state.view'), 'folder');
      assert.strictEqual(await js('state.folder.path'), single);
      assert.ok(!(await js('document.getElementById("toast").hidden')), 'shows an error toast');
    });

    await step('shows held files for a lock (sample data)', async () => {
      await waitFor('!state.locksLoading && state.locks');
      await js(`markLockScan(); state.locks = { ok: true, supported: true, elevated: false, scanMs: 900, processes: [
        { pid: 6256, name: 'node.exe', parentPid: 24904, commandLine: 'node react-scripts/scripts/start.js', ports: [3000], holdsFolder: false,
          handleCount: 3, moduleCount: 1, samples: [${JSON.stringify(single + path.sep + 'node_modules' + path.sep + 'a.js')}],
          moduleSamples: [${JSON.stringify(single + path.sep + 'node_modules' + path.sep + 'watcher.node')}], targets: [0] },
        { pid: 24904, name: 'powershell.exe', parentPid: 1, commandLine: 'powershell.exe', ports: [], holdsFolder: true, handleCount: 1, moduleCount: 0, samples: [], moduleSamples: [], targets: [0] }
      ] }; render();`);
      await sleep(200);
      const title = await js('document.querySelector(".tag-title").textContent');
      assert.match(title, /React dev server on localhost:3000/);
      assert.ok(await js('!!document.querySelector("details.held")'), 'has a held-files list');
      assert.match(await js('document.querySelector("details.held").textContent'), /loaded as a library/);
      await js('document.querySelector("details.held").open = true');
      await shot('03-locked');
      await js('state.locks = { ok: true, supported: false, processes: [] }; render();');
    });

    await step('wipes the folder and shows the done screen', async () => {
      await js('startWipe()');
      await waitFor('state.view === "done"');
      assert.strictEqual(fs.existsSync(single), false, 'folder is gone');
      await shot('04-done');
    });

    await step('navigation is blocked while a wipe runs', async () => {
      const big = path.join(base, 'big');
      makeProject(big, 400, 25, 900);
      await js(`loadFolder(${JSON.stringify(big)})`);
      await waitFor('state.view === "folder" && state.folder && state.folder.path.endsWith("big")');
      await js('startWipe()');
      await waitFor('state.view === "wiping"');
      const other = path.join(base, 'other');
      fs.mkdirSync(other);
      await js(`loadFolder(${JSON.stringify(other)})`);
      await sleep(100);
      const view = await js('state.view');
      const shown = await js('state.folder.path');
      assert.ok(view === 'wiping' || view === 'done', `still wiping, got ${view}`);
      assert.ok(shown.endsWith('big'), 'did not switch folders');
      await waitFor('state.view === "done"', 30000);
      assert.strictEqual(fs.existsSync(big), false);
    });

    await step('cancelling a wipe returns to the folder', async () => {
      const huge = path.join(base, 'huge');
      makeProject(huge, 600, 30, 900);
      await js(`loadFolder(${JSON.stringify(huge)})`);
      await waitFor('state.view === "folder" && state.folder && state.folder.path.endsWith("huge")');
      await js('startWipe()');
      await waitFor('state.view === "wiping" && state.wipeProgress && state.wipeProgress.phase === "delete"', 20000);
      await js('cancelWipe()');
      await waitFor('state.view === "folder" && state.folder && state.folder.path.endsWith("huge")');
      assert.ok(fs.existsSync(huge), 'folder still there after cancel');
    });

    await step('wiping a link removes only the link', async () => {
      const real = path.join(base, 'real');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'keep.txt'), 'keep');
      const link = path.join(base, 'link');
      fs.symlinkSync(real, link, 'junction');
      await js(`loadFolder(${JSON.stringify(link)})`);
      await waitFor('state.view === "folder" && state.folder && state.folder.link');
      await js('startWipe()');
      await waitFor('state.view === "done"');
      assert.strictEqual(fs.existsSync(link), false, 'link removed');
      assert.strictEqual(fs.readFileSync(path.join(real, 'keep.txt'), 'utf8'), 'keep', 'target untouched');
      assert.match(await js('document.querySelector(".done p").textContent'), /wasn't touched/);
    });

    await step('refuses protected folders', async () => {
      await js(`loadFolder(${JSON.stringify(os.homedir())})`);
      await waitFor('state.folder && state.folder.protectedReason');
      assert.ok(await js('document.querySelector(".hold").disabled'));
    });

    const projects = path.join(base, 'Projects');
    makeProject(path.join(projects, 'old-one'), 40, 10, 1700);
    makeProject(path.join(projects, 'old-two'), 30, 10, 2000);
    makeProject(path.join(projects, 'fresh'), 20, 10, 2);

    await step('batch: finds and measures node_modules, preselects old ones', async () => {
      await js(`startBatch(${JSON.stringify(projects)})`);
      await waitFor('state.batch && !state.batch.finding && state.batch.items.length === 3 && state.batch.items.every(x => x.bytes != null)');
      const selected = await js('state.batch.items.filter(x => x.selected).map(x => x.projectName).sort()');
      assert.deepStrictEqual(selected, ['old-one', 'old-two']);
      await shot('05-batch');
    });

    await step('batch: wipes only the selected folders', async () => {
      await js('startBatchWipe()');
      await waitFor('state.view === "batch-done"', 30000);
      assert.strictEqual(fs.existsSync(path.join(projects, 'old-one', 'node_modules')), false);
      assert.strictEqual(fs.existsSync(path.join(projects, 'old-two', 'node_modules')), false);
      assert.strictEqual(fs.existsSync(path.join(projects, 'fresh', 'node_modules')), true, 'recent project untouched');
      assert.strictEqual(fs.existsSync(path.join(projects, 'old-one', 'package.json')), true, 'project files untouched');
      await shot('06-batch-done');
    });

    await step('batch: refuses to delete anything but dependency folders', async () => {
      const err = await js(`api.wipeMany([${JSON.stringify(path.join(projects, 'fresh'))}]).then(() => null, (e) => e.message)`);
      assert.match(err || '', /Refusing to batch-delete/);
      assert.ok(fs.existsSync(path.join(projects, 'fresh', 'package.json')));
    });

    await step('settings close with Escape', async () => {
      await js('document.getElementById("settings-btn").click()');
      await sleep(200);
      assert.strictEqual(await js('document.getElementById("settings").hidden'), false);
      await js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
      assert.strictEqual(await js('document.getElementById("settings").hidden'), true);
    });

    await step('IPC rejects calls from other pages', async () => {
      // Navigation away is blocked, so the page URL stays ours.
      await js('location.href = "https://example.com"');
      await sleep(300);
      assert.match(win.webContents.getURL(), /index\.html$/);
    });

    fs.rmSync(base, { recursive: true, force: true });
    console.log(failures ? `\n${failures} flow(s) failed` : '\nAll flows passed.');
    app.exit(failures ? 1 : 0);
  });
});
