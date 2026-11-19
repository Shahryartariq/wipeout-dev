'use strict';

// Tiny file logger for the main process: %APPDATA%\Wipeout\logs\wipeout.log,
// rotated at 1 MB (one previous file kept). Paths and errors only, no file contents.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 1024 * 1024;
let file = null;

function logFile() {
  if (file) return file;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'wipeout.log');
  } catch {
    file = null;
  }
  return file;
}

function logsDir() {
  const f = logFile();
  return f ? path.dirname(f) : null;
}

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function write(level, args) {
  const line = `${new Date().toISOString()} ${level} ${args.map(fmt).join(' ')}\n`;
  if (!app.isPackaged) process.stdout.write(line);
  const f = logFile();
  if (!f) return;
  try {
    const st = fs.existsSync(f) ? fs.statSync(f) : null;
    if (st && st.size > MAX_BYTES) fs.renameSync(f, f + '.1');
    fs.appendFileSync(f, line);
  } catch { /* logging must never break the app */ }
}

module.exports = {
  info: (...a) => write('INFO ', a),
  warn: (...a) => write('WARN ', a),
  error: (...a) => write('ERROR', a),
  logsDir,
};
