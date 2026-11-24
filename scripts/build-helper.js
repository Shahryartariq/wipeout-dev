'use strict';

// Builds resources/wipeout-locks.exe from scripts/*.cs, and Wipeout Lite
// (lite/wipeout-lite.exe, the no-window right-click version) from the same
// lock scanner plus lite/WipeoutLite.cs.
// Windows: uses the C# compiler that ships with .NET Framework 4 (no SDK needed).
// Elsewhere: uses Mono's mcs if installed, otherwise keeps the committed binary.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'resources', 'wipeout-locks.exe');
const sources = ['WipeoutLocks.cs', 'LocksProgram.cs'].map((f) => path.join(__dirname, f));
const lite = path.join(root, 'lite', 'wipeout-lite.exe');
const liteSources = [...sources, path.join(root, 'lite', 'WipeoutLite.cs')];
const icon = path.join(root, 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });

function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  const c = path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  return fs.existsSync(c) ? c : null;
}

function has(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

if (process.platform === 'win32') {
  const csc = findCsc();
  if (!csc) throw new Error('csc.exe from .NET Framework 4 was not found.');
  execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/langversion:5',
    '/r:System.Core.dll', `/out:${out}`, ...sources], { stdio: 'inherit' });
  execFileSync(csc, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/langversion:5',
    '/main:WipeoutLite', `/win32icon:${icon}`, '/r:System.Core.dll', `/out:${lite}`, ...liteSources], { stdio: 'inherit' });
} else if (has('mcs')) {
  execFileSync('mcs', ['-langversion:5', '-target:exe', '-platform:x64', '-optimize+', '-r:System.Core',
    `-out:${out}`, ...sources], { stdio: 'inherit' });
  execFileSync('mcs', ['-langversion:5', '-target:winexe', '-platform:x64', '-optimize+', '-r:System.Core',
    '-main:WipeoutLite', `-win32icon:${icon}`, `-out:${lite}`, ...liteSources], { stdio: 'inherit' });
} else if (fs.existsSync(out)) {
  console.log('No C# compiler here; keeping the committed wipeout-locks.exe.');
  process.exit(0);
} else {
  throw new Error('No C# compiler found and no prebuilt wipeout-locks.exe.');
}
console.log('Built', path.relative(root, out), 'and', path.relative(root, lite));
