'use strict';

// Unit tests for how lock-scan results are named and grouped.
const assert = require('assert');
const { describe, groupLocks, npmScript } = require('../src/renderer/locks-logic');

const p = (pid, name, parentPid, commandLine = '', extra = {}) => ({
  pid, name, parentPid, commandLine, ports: [], samples: [], moduleSamples: [], targets: [0], handleCount: 1, moduleCount: 0, ...extra,
});

// Naming
assert.strictEqual(describe(p(1, 'node.exe', 0, '"node" "D:\\a\\node_modules\\react-scripts\\scripts\\start.js"', { ports: [3000] })).title, 'React dev server on localhost:3000');
assert.strictEqual(describe(p(1, 'node.exe', 0, 'node D:\\a\\node_modules\\vite\\bin\\vite.js', { ports: [5173] })).title, 'Vite dev server on localhost:5173');
assert.strictEqual(describe(p(1, 'node.exe', 0, 'node node_modules/next/dist/bin/next dev')).title, 'Next.js dev server');
assert.strictEqual(describe(p(1, 'node.exe', 0, 'node send-invite.js')).title, 'Node.js process', '"invite" is not vite');
assert.strictEqual(describe(p(1, 'node.exe', 0, '"node" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" start')).title, 'npm start');
assert.strictEqual(describe(p(1, 'bash.exe', 0, 'bash --login -i')).title, 'Git Bash terminal');
assert.strictEqual(describe(p(1, 'Code.exe', 0)).title, 'VS Code');
assert.strictEqual(describe(p(1, 'mystery.exe', 0)).title, 'mystery');
assert.strictEqual(describe(p(1, 'node.exe', 0, 'node scripts/next-steps.js')).title, 'Node.js process', 'next-steps is not Next.js');
assert.strictEqual(describe(p(1, 'node.exe', 0, '"C:\\nodejs\\node.exe" "D:\\app\\node_modules\\.bin\\..\\vite\\bin\\vite.js"')).kind, 'server');
assert.strictEqual(npmScript('npm.cmd run dev'), 'dev');
assert.strictEqual(npmScript('npm run-script build:prod'), 'build:prod');
assert.strictEqual(npmScript('npm exec foo'), null);

// Grouping: a terminal -> npm -> node -> node chain becomes one stoppable group.
let groups = groupLocks([
  p(10, 'powershell.exe', 1),
  p(11, 'npm.exe', 10, 'npm start'),
  p(12, 'node.exe', 11, 'node npm-cli.js start'),
  p(13, 'node.exe', 12, 'node react-scripts/scripts/start.js', { ports: [3000] }),
]);
assert.strictEqual(groups.length, 1);
assert.strictEqual(groups[0].root.pid, 10, 'stops from the terminal');
assert.strictEqual(groups[0].title, 'React dev server on localhost:3000', 'named after the most telling member');
assert.match(groups[0].detail, /Started from a PowerShell window/);
assert.ok(!groups[0].unstoppable);

// Never climb into VS Code or Explorer: stopping a terminal must not close them.
groups = groupLocks([
  p(20, 'Code.exe', 1),
  p(21, 'powershell.exe', 20),
  p(22, 'node.exe', 21, 'node server.js', { ports: [8080] }),
  p(30, 'explorer.exe', 1),
]);
const byRoot = Object.fromEntries(groups.map((g) => [g.root.name, g]));
assert.ok(byRoot['powershell.exe'], 'terminal is its own group');
assert.ok(byRoot['Code.exe'], 'VS Code is separate');
assert.match(byRoot['Code.exe'].warn, /closes VS Code/);
assert.ok(byRoot['explorer.exe'].unstoppable, 'Explorer is never stopped');
assert.strictEqual(groups[groups.length - 1].root.name, 'explorer.exe', 'unstoppable groups sort last');

// Libraries and programs inside the folder are explained.
groups = groupLocks([p(40, 'node.exe', 1, 'node x.js', { moduleCount: 2, handleCount: 0 })]);
assert.match(groups[0].detail, /library from this folder loaded/);
groups = groupLocks([p(41, 'electron.exe', 1, '', { runsFromFolder: true })]);
assert.match(groups[0].detail, /program file is inside this folder/);

// Targets are merged across a group (batch mode).
groups = groupLocks([p(50, 'cmd.exe', 1, '', { targets: [0] }), p(51, 'node.exe', 50, 'node a', { targets: [2] })]);
assert.deepStrictEqual(groups[0].targets.sort(), [0, 2]);

// A parent loop can't hang the grouping.
groups = groupLocks([p(60, 'a.exe', 61), p(61, 'b.exe', 60)]);
assert.strictEqual(groups.length >= 1, true);

console.log('All locks-logic tests passed.');
