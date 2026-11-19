'use strict';

// Utility process: runs one scan or wipe job and reports back to the main process.

const { scan, wipe, findArtifacts, wipeMany } = require('./wipe-core');

let cancelled = false;
const isCancelled = () => cancelled;

function send(msg) {
  process.parentPort.postMessage(msg);
}

let lastProgress = 0;
function progress(job, p) {
  const now = Date.now();
  if (now - lastProgress < 100) return;
  lastProgress = now;
  send({ type: 'progress', job, ...p });
}

process.parentPort.on('message', async (e) => {
  const msg = e.data || {};
  if (msg.cmd === 'cancel') {
    cancelled = true;
    return;
  }
  try {
    if (msg.cmd === 'scan') {
      const result = await scan(msg.target, {
        isCancelled,
        onProgress: (p) => progress('scan', p),
      });
      send({ type: 'done', job: 'scan', result });
    } else if (msg.cmd === 'find') {
      // Stream folders as they're found, then measure each one.
      const items = await findArtifacts(msg.root, {
        isCancelled,
        onFound: (item) => send({ type: 'found', job: 'find', item }),
        onProgress: (p) => progress('find', p),
      });
      for (const item of items) {
        if (cancelled) break;
        const s = await scan(item.path, { isCancelled });
        send({ type: 'measured', job: 'find', path: item.path, bytes: s.bytes, files: s.files });
      }
      send({ type: 'done', job: 'find', result: { count: items.length } });
    } else if (msg.cmd === 'wipe-many') {
      const results = await wipeMany(msg.targets, {
        isCancelled,
        onProgress: (p) => (p.phase === 'folder-done' ? send({ type: 'progress', job: 'wipe-many', ...p }) : progress('wipe-many', p)),
      });
      send({ type: 'done', job: 'wipe-many', result: { results } });
    } else if (msg.cmd === 'wipe') {
      const result = await wipe(msg.target, {
        isCancelled,
        onProgress: (p) => progress('wipe', p),
      });
      send({ type: 'done', job: 'wipe', result });
    }
  } catch (err) {
    send({ type: 'error', job: msg.cmd, message: err.message });
  }
});
