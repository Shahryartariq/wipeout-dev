'use strict';
// Dev-only harness: launches Wipeout, injects sample lock data and saves screenshots.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
require('../src/main.js');

const out = process.env.SHOTS || require('os').tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = {
  ok: true, supported: true, elevated: false, scanMs: 1840,
  processes: [
    { pid: 24904, name: 'powershell.exe', parentPid: 7980, commandLine: 'powershell.exe', holdsFolder: true, handleCount: 1, ports: [3000] },
    { pid: 10180, name: 'npm.exe', parentPid: 24904, commandLine: '"C:\\Program Files\\nodejs\\npm.exe" start', holdsFolder: true, handleCount: 1, ports: [3000] },
    { pid: 6256, name: 'node.exe', parentPid: 10180, commandLine: '"node" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" start', holdsFolder: true, handleCount: 1, ports: [3000] },
    { pid: 14352, name: 'node.exe', parentPid: 6256, commandLine: '"node" "D:\\Projects\\days_counter\\node_modules\\react-scripts\\scripts\\start.js"', holdsFolder: true, handleCount: 12, ports: [3000] },
    { pid: 25232, name: 'bash.exe', parentPid: 22268, commandLine: '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i', holdsFolder: true, handleCount: 1, ports: [] },
    { pid: 5120, name: 'explorer.exe', parentPid: 1000, commandLine: 'C:\\Windows\\explorer.exe', holdsFolder: true, handleCount: 1, ports: [] },
  ],
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const shot = async (name) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    };
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      await sleep(2500);
      await shot('1-folder-real');
      await js(`state.locks = ${JSON.stringify(mock)}; state.stats = { files: 24310, bytes: 327155712, readOnly: 142, longPaths: 37, unreadable: [] }; state.folder.git = { isRepo: true, available: true, changes: 0, lastCommit: '3 years ago', remote: 'https://github.com/x/y', unpushed: 0 }; render();`);
      await sleep(300);
      await shot('2-folder-locked');
      await js(`document.getElementById('hold').style.setProperty('--p', '0.55')`);
      await sleep(100);
      await shot('3-holding');
      await js(`state.view = 'wiping'; state.wipeProgress = { phase: 'delete', done: 12400, total: 24310, elapsedMs: 9000, failed: 0 }; render();`);
      await sleep(300);
      await shot('4-wiping');
      await js(`state.view = 'done'; state.doneInfo = { name: state.folder.name, files: 24310, bytes: 327155712, ms: 17400 }; render();`);
      await sleep(300);
      await shot('5-done');
      await js(`state.view = 'empty'; render();`);
      await sleep(300);
      await shot('6-empty');
    } catch (e) {
      console.error('HARNESS ERROR', e);
    }
    app.quit();
  });
});
