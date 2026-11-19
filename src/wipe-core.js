'use strict';

// Fast folder scanning and deleting with progress.
// Runs inside a utility process so a big node_modules never freezes the window.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const LONG_PATH = 260;

// Run fn over items with at most `limit` in flight.
async function pool(items, limit, fn) {
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
}

// Walk a tree breadth-first with parallel readdir.
// Symlinks and junctions are recorded as links and never followed, so nothing
// outside the folder can ever be touched.
async function walk(root, { withStats = false, onProgress, isCancelled } = {}) {
  const files = [];
  const links = [];
  const dirs = [{ p: root, depth: 0 }];
  const errors = [];
  let bytes = 0;
  let readOnly = 0;
  let longPaths = 0;

  let frontier = [{ p: root, depth: 0 }];
  while (frontier.length) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    const nextFrontier = [];
    await pool(frontier, 48, async (dir) => {
      let entries;
      try {
        entries = await fsp.readdir(dir.p, { withFileTypes: true });
      } catch (err) {
        errors.push({ path: dir.p, code: err.code, message: err.message });
        return;
      }
      for (const ent of entries) {
        const full = path.join(dir.p, ent.name);
        if (full.length >= LONG_PATH) longPaths++;
        if (ent.isSymbolicLink()) {
          links.push(full);
        } else if (ent.isDirectory()) {
          const d = { p: full, depth: dir.depth + 1 };
          dirs.push(d);
          nextFrontier.push(d);
        } else {
          files.push(full);
        }
      }
      if (onProgress) onProgress({ files: files.length, dirs: dirs.length, bytes, readOnly, longPaths });
    });
    frontier = nextFrontier;
  }

  if (withStats) {
    let done = 0;
    await pool(files, 64, async (f) => {
      if (isCancelled && isCancelled()) return;
      try {
        const st = await fsp.lstat(f);
        bytes += st.size;
        if (process.platform === 'win32' && (st.mode & 0o200) === 0) readOnly++;
      } catch { /* vanished or unreadable */ }
      done++;
      if (onProgress && done % 500 === 0) {
        onProgress({ files: files.length, dirs: dirs.length, bytes, readOnly, longPaths, statted: done });
      }
    });
  }

  return { files, links, dirs, errors, bytes, readOnly, longPaths };
}

async function linkStillThere(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

async function scan(root, opts = {}) {
  const t0 = Date.now();
  try {
    const st = await fsp.lstat(root);
    if (st.isSymbolicLink()) {
      return { files: 0, dirs: 0, bytes: 0, readOnly: 0, longPaths: 0, maxDepth: 0, unreadable: [], isLink: true, ms: 0 };
    }
  } catch { /* walk reports it */ }
  const r = await walk(root, { ...opts, withStats: true });
  const maxDepth = r.dirs.reduce((m, d) => Math.max(m, d.depth), 0);
  return {
    files: r.files.length + r.links.length,
    dirs: r.dirs.length,
    bytes: r.bytes,
    readOnly: r.readOnly,
    longPaths: r.longPaths,
    maxDepth,
    unreadable: r.errors.slice(0, 20),
    ms: Date.now() - t0,
  };
}

async function removeFile(f) {
  try {
    await fsp.unlink(f);
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      // Usually the read-only attribute. Clear it and try again.
      try {
        await fsp.chmod(f, 0o666);
        await fsp.unlink(f);
        return null;
      } catch (err2) {
        if (err2.code === 'ENOENT') return null;
        return err2;
      }
    }
    return err;
  }
}

async function removeLink(l) {
  // A directory junction/symlink is removed with rmdir on Windows, unlink elsewhere.
  try {
    await fsp.unlink(l);
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    try {
      await fsp.rmdir(l);
      return null;
    } catch (err2) {
      if (err2.code === 'ENOENT') return null;
      return err2;
    }
  }
}

async function removeDir(d) {
  try {
    await fsp.rmdir(d);
    return null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      try {
        await fsp.chmod(d, 0o777);
        await fsp.rmdir(d);
        return null;
      } catch (err2) {
        if (err2.code === 'ENOENT') return null;
        return err2;
      }
    }
    return err;
  }
}

async function wipe(root, { onProgress, isCancelled } = {}) {
  const t0 = Date.now();

  // A junction or symlink: remove the link itself, never what it points to.
  let rootStat;
  try {
    rootStat = await fsp.lstat(root);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, cancelled: false, removed: 0, total: 0, failures: [], walkErrors: [], ms: 0 };
    throw err;
  }
  if (rootStat.isSymbolicLink()) {
    const err = await removeLink(root);
    return {
      ok: !fs.existsSync(root) && !(await linkStillThere(root)),
      cancelled: false,
      removed: err ? 0 : 1,
      total: 1,
      linkOnly: true,
      failures: err ? [{ path: root, code: err.code || 'ERROR', message: err.message }] : [],
      walkErrors: [],
      ms: Date.now() - t0,
    };
  }
  const failures = [];
  const fail = (p, err) => {
    if (failures.length < 200) failures.push({ path: p, code: err.code || 'ERROR', message: err.message });
  };

  const tree = await walk(root, {
    isCancelled,
    onProgress: (s) => onProgress && onProgress({ phase: 'scan', found: s.files, dirsFound: s.dirs }),
  });

  const leaves = tree.files.concat(tree.links);
  const total = leaves.length + tree.dirs.length;
  let done = 0;
  let lastReport = 0;
  const report = (force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastReport < 80)) return;
    lastReport = now;
    onProgress({ phase: 'delete', done, total, failed: failures.length, elapsedMs: now - t0 });
  };

  const linkSet = new Set(tree.links);
  await pool(leaves, 128, async (f) => {
    if (isCancelled && isCancelled()) return;
    const err = linkSet.has(f) ? await removeLink(f) : await removeFile(f);
    if (err) fail(f, err);
    done++;
    report(false);
  });

  // Folders deepest first, one depth level at a time.
  const byDepth = new Map();
  for (const d of tree.dirs) {
    if (!byDepth.has(d.depth)) byDepth.set(d.depth, []);
    byDepth.get(d.depth).push(d.p);
  }
  const depths = [...byDepth.keys()].sort((a, b) => b - a);
  for (const depth of depths) {
    if (isCancelled && isCancelled()) break;
    await pool(byDepth.get(depth), 64, async (d) => {
      const err = await removeDir(d);
      // A folder that still has a stuck child is not interesting on its own.
      if (err && err.code !== 'ENOTEMPTY') fail(d, err);
      done++;
      report(false);
    });
  }
  report(true);

  const gone = !(await linkStillThere(root));
  return {
    ok: gone,
    cancelled: !!(isCancelled && isCancelled()),
    removed: done - failures.length,
    total,
    failures,
    walkErrors: tree.errors.slice(0, 20),
    ms: Date.now() - t0,
  };
}

// ---------- batch: find dependency folders under a parent folder ----------

// Folders never worth descending into while looking for projects.
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'appdata', 'windows', 'program files', 'program files (x86)', 'programdata']);

// Find node_modules (and Rust target) folders. Never descends into one it found,
// into hidden folders, or through links.
async function findArtifacts(root, { maxDepth = 8, onFound, onProgress, isCancelled } = {}) {
  const found = [];
  let visited = 0;
  let frontier = [{ p: root, depth: 0 }];
  while (frontier.length) {
    if (isCancelled && isCancelled()) break;
    const next = [];
    await pool(frontier, 32, async (dir) => {
      if (isCancelled && isCancelled()) return;
      let entries;
      try {
        entries = await fsp.readdir(dir.p, { withFileTypes: true });
      } catch {
        return;
      }
      visited++;
      const names = new Set(entries.map((e) => e.name.toLowerCase()));
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
        const lname = ent.name.toLowerCase();
        const full = path.join(dir.p, ent.name);
        let kind = null;
        if (lname === 'node_modules') kind = 'node';
        else if (lname === 'target' && names.has('cargo.toml')) kind = 'rust';
        if (kind) {
          const item = { path: full, kind, project: dir.p, projectName: path.basename(dir.p) || dir.p };
          item.lastTouched = await lastTouched(dir.p, ent.name);
          found.push(item);
          if (onFound) onFound(item);
          continue;
        }
        if (lname.startsWith('.') || SKIP_DIRS.has(lname)) continue;
        if (dir.depth + 1 <= maxDepth) next.push({ p: full, depth: dir.depth + 1 });
      }
      if (onProgress) onProgress({ visited, found: found.length });
    });
    frontier = next;
  }
  return found;
}

// Newest modification time among a project's own top-level entries,
// ignoring the dependency folder itself (installs touch that, not you).
async function lastTouched(projectDir, skipName) {
  let newest = 0;
  try {
    const entries = await fsp.readdir(projectDir, { withFileTypes: true });
    const picks = entries.filter((e) => e.name !== skipName).slice(0, 200);
    await pool(picks, 16, async (e) => {
      try {
        const st = await fsp.lstat(path.join(projectDir, e.name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  if (!newest) {
    // Nothing but the dependency folder: fall back to the project folder's own date.
    try { newest = (await fsp.stat(projectDir)).mtimeMs; } catch { /* ignore */ }
  }
  return newest || null;
}

// Wipe several folders one after another.
async function wipeMany(targets, { onProgress, isCancelled } = {}) {
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    if (isCancelled && isCancelled()) break;
    const target = targets[i];
    if (!fs.existsSync(target)) {
      results.push({ path: target, ok: true, removed: 0, total: 0, failures: [], ms: 0 });
      continue;
    }
    const r = await wipe(target, {
      isCancelled,
      onProgress: (p) => onProgress && onProgress({ ...p, index: i, count: targets.length, path: target }),
    });
    results.push({ path: target, ...r });
    if (onProgress) onProgress({ phase: 'folder-done', index: i, count: targets.length, path: target, ok: r.ok });
  }
  return results;
}

module.exports = { scan, wipe, walk, findArtifacts, wipeMany, LONG_PATH };
