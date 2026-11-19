'use strict';

// Exercises the delete engine on a throwaway tree:
// many files, deep nesting, read-only files, long paths, and a symlink that
// points OUTSIDE the folder (which must survive).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, wipe, findArtifacts, wipeMany } = require('../src/wipe-core');

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wipeout-test-'));
  const target = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'do not delete me');

  // A fake node_modules: 300 packages x 20 files, 3 levels deep.
  let fileCount = 0;
  for (let i = 0; i < 300; i++) {
    const pkg = path.join(target, 'node_modules', `pkg-${i}`, 'lib', 'sub');
    fs.mkdirSync(pkg, { recursive: true });
    for (let j = 0; j < 20; j++) {
      fs.writeFileSync(path.join(pkg, `f${j}.js`), 'x'.repeat(100));
      fileCount++;
    }
  }
  // Read-only files and a read-only folder.
  const ro = path.join(target, 'readonly');
  fs.mkdirSync(ro);
  for (let j = 0; j < 5; j++) {
    const f = path.join(ro, `ro${j}.txt`);
    fs.writeFileSync(f, 'ro');
    fs.chmodSync(f, 0o444);
    fileCount++;
  }
  // A very deep path (over 260 characters).
  let deep = path.join(target, 'deep');
  while (deep.length < 400) deep = path.join(deep, 'abcdefghij');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'leaf.txt'), 'deep');
  fileCount++;
  // Symlinks pointing outside the folder: one to a dir, one to a file.
  fs.symlinkSync(outside, path.join(target, 'link-to-outside'), 'dir');
  fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(target, 'link-to-file'), 'file');

  const s = await scan(target);
  console.log('scan:', { files: s.files, dirs: s.dirs, bytes: s.bytes, longPaths: s.longPaths, maxDepth: s.maxDepth, ms: s.ms });
  assert.strictEqual(s.files, fileCount + 2, 'scan counts files and links');
  assert.ok(s.longPaths > 0, 'scan notices long paths');
  assert.ok(s.bytes > 0, 'scan sums sizes');

  let progressCalls = 0;
  let lastDone = 0;
  const r = await wipe(target, {
    onProgress: (p) => {
      progressCalls++;
      if (p.phase === 'delete') {
        assert.ok(p.done >= lastDone, 'progress only moves forward');
        lastDone = p.done;
      }
    },
  });
  console.log('wipe:', { ok: r.ok, removed: r.removed, total: r.total, failures: r.failures.length, ms: r.ms, progressCalls });

  assert.strictEqual(r.ok, true, 'folder is gone');
  assert.strictEqual(fs.existsSync(target), false, 'folder no longer exists');
  assert.strictEqual(r.failures.length, 0, 'no failures');
  assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'do not delete me', 'symlink targets survive');
  assert.ok(progressCalls > 0, 'progress was reported');

  // Cancelling stops early and leaves the folder in place.
  const t2 = path.join(base, 'cancel-me');
  for (let i = 0; i < 50; i++) {
    const d = path.join(t2, `d${i}`);
    fs.mkdirSync(d, { recursive: true });
    for (let j = 0; j < 50; j++) fs.writeFileSync(path.join(d, `f${j}`), 'x');
  }
  let calls = 0;
  const r2 = await wipe(t2, { isCancelled: () => ++calls > 20 });
  assert.strictEqual(r2.ok, false, 'cancelled wipe reports not ok');
  assert.strictEqual(fs.existsSync(t2), true, 'cancelled folder still exists');

  // A file that can't be removed is reported, not thrown.
  if (process.getuid && process.getuid() !== 0) {
    const t3 = path.join(base, 'stuck');
    const locked = path.join(t3, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, 'a.txt'), 'a');
    fs.chmodSync(locked, 0o555); // can't delete inside it
    const r3 = await wipe(t3);
    fs.chmodSync(locked, 0o755);
    assert.strictEqual(r3.ok, false);
    assert.ok(r3.failures.length >= 1, 'stuck file is listed');
    console.log('stuck:', r3.failures[0]);
  }

  // Wiping a symlink/junction removes only the link, never the target's contents.
  const realDir = path.join(base, 'real-target');
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, 'precious.txt'), 'keep');
  const linkDir = path.join(base, 'link-to-real');
  fs.symlinkSync(realDir, linkDir, 'dir');
  const rl = await wipe(linkDir);
  assert.strictEqual(rl.ok, true, 'link wipe ok');
  assert.strictEqual(rl.linkOnly, true, 'reported as link-only');
  assert.strictEqual(fs.existsSync(linkDir), false, 'link removed');
  assert.strictEqual(fs.readFileSync(path.join(realDir, 'precious.txt'), 'utf8'), 'keep', 'target untouched');
  const sl = await scan(realDir);
  assert.ok(sl.files === 1);

  // Batch: finds node_modules and Rust target folders, skips nested and hidden ones.
  const projects = path.join(base, 'projects');
  const mk = (rel, files = 3) => {
    const d = path.join(projects, rel);
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(d, `f${i}.js`), 'x');
  };
  mk('app-one/node_modules/react');
  mk('app-one/node_modules/react/node_modules/inner'); // nested: must not be listed separately
  fs.writeFileSync(path.join(projects, 'app-one', 'package.json'), '{}');
  mk('group/app-two/node_modules/lodash', 10);
  mk('rusty/target/debug', 4);
  fs.writeFileSync(path.join(projects, 'rusty', 'Cargo.toml'), '[package]');
  mk('not-rust/target/x'); // a "target" folder without Cargo.toml: leave it alone
  mk('.hidden/node_modules/x'); // hidden folders are skipped
  const found = [];
  const items = await findArtifacts(projects, { onFound: (i) => found.push(i) });
  const rels = items.map((i) => path.relative(projects, i.path).replace(/\\/g, '/')).sort();
  console.log('found:', rels);
  assert.deepStrictEqual(rels, ['app-one/node_modules', 'group/app-two/node_modules', 'rusty/target']);
  assert.strictEqual(found.length, 3, 'onFound fires per folder');
  assert.ok(items.every((i) => i.lastTouched > 0), 'project age is measured');
  assert.strictEqual(items.find((i) => i.kind === 'rust').projectName, 'rusty');

  const results = await wipeMany(items.map((i) => i.path));
  assert.ok(results.every((r) => r.ok), 'all batch folders wiped');
  assert.ok(items.every((i) => !fs.existsSync(i.path)), 'batch folders are gone');
  assert.ok(fs.existsSync(path.join(projects, 'app-one', 'package.json')), 'project files survive');
  assert.ok(fs.existsSync(path.join(projects, 'not-rust', 'target')), 'unrelated target folder survives');

  fs.rmSync(base, { recursive: true, force: true });
  console.log('All wipe-core tests passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
