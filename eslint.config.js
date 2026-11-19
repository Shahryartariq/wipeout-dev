'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/*.js', 'scripts/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // The window's scripts share one global scope (classic <script> tags).
    files: ['src/renderer/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, module: 'readonly', globalThis: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^(markLockScan|onBatchJob|renderBatch|batchAction|startBatch|refreshBatchLocks|startBatchWipe|applyWidths|holdFaces|isBusy|tagHtml|relPath)$' }],
      'no-redeclare': 'off',
    },
  },
];
