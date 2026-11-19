'use strict';

// Turns raw lock-scan results into what the UI shows: a plain-language name
// for each process ("Vite dev server on localhost:5173") and groups of related
// processes (terminal -> npm -> node) that can be stopped together.
// Loaded as a <script> in the window and required by the unit tests.

(function (root) {
  const lc = (s) => String(s || '').toLowerCase();

  // Apps that host other things. We never climb past them when grouping,
  // so stopping a dev server never takes VS Code or Explorer down with it.
  const CONTAINERS = new Set([
    'explorer.exe', 'code.exe', 'cursor.exe', 'windsurf.exe', 'devenv.exe', 'idea64.exe', 'webstorm64.exe',
    'pycharm64.exe', 'rider64.exe', 'windowsterminal.exe', 'openconsole.exe', 'conhost.exe', 'mintty.exe',
    'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'svchost.exe', 'msmpeng.exe',
  ]);

  const UNSTOPPABLE = {
    'explorer.exe': 'Close any File Explorer window that is showing this folder or something inside it, then rescan.',
    'msmpeng.exe': 'Windows Security is scanning these files. Wait a few seconds, then rescan.',
    'nissrv.exe': 'Windows Security is scanning these files. Wait a few seconds, then rescan.',
    'searchindexer.exe': 'Windows Search is indexing this folder. Wait a moment, then rescan.',
    'svchost.exe': 'A Windows service has this open. Wait a moment and rescan, or restart your PC.',
    'system': 'Windows itself has this open. Restarting your PC will release it.',
  };

  function npmScript(cmd) {
    const m = /npm(?:-cli\.js"?|\.cmd"?|\.exe"?|\.ps1"?)?\s+(?:run(?:-script)?\s+)?([\w:.-]+)/i.exec(cmd || '');
    if (!m) return null;
    const s = m[1].toLowerCase();
    if (['--', '-g', 'exec', 'x'].includes(s)) return null;
    return m[1];
  }

  function describe(p) {
    const name = lc(p.name);
    const cmd = lc(p.commandLine);
    const port = p.ports && p.ports.length ? p.ports[0] : null;
    const on = port ? ` on localhost:${port}` : '';
    const d = (title, rank, kind = 'process') => ({ title, rank, kind });

    if (name === 'node.exe' || name === 'bun.exe' || name === 'deno.exe') {
      if (cmd.includes('react-scripts')) return d(`React dev server${on}`, 10, 'server');
      if (/(^|[\\/\s"'])vite([\\/\s"']|\.m?js|$)/.test(cmd)) return d(`Vite dev server${on}`, 10, 'server');
      if (/[\\/]next[\\/]dist[\\/]|(^|[\s"'])next(\.cmd)?\s+(dev|start)\b/.test(cmd)) return d(`Next.js dev server${on}`, 10, 'server');
      if (cmd.includes('webpack')) return d(`Webpack dev server${on}`, 9, 'server');
      if (cmd.includes('nodemon')) return d(`nodemon watcher${on}`, 9, 'server');
      if (cmd.includes('npm-cli.js')) {
        const s = npmScript(p.commandLine);
        return d(s ? `npm ${s}${on}` : `npm${on}`, 7);
      }
      if (port) return d(`Node.js server${on}`, 8, 'server');
      return d('Node.js process', 5);
    }
    if (name === 'npm.exe' || name === 'npx.exe' || name === 'pnpm.exe' || name === 'yarn.exe') {
      const s = npmScript(p.commandLine);
      return d(s ? `${name.replace('.exe', '')} ${s}${on}` : name.replace('.exe', '') + on, 6);
    }
    if (name === 'python.exe' || name === 'pythonw.exe') return d(`Python${on}`, 6);
    if (name === 'bash.exe' || name === 'mintty.exe' || name === 'sh.exe') return d('Git Bash terminal', 3, 'terminal');
    if (name === 'powershell.exe' || name === 'pwsh.exe') return d('PowerShell window', 3, 'terminal');
    if (name === 'cmd.exe') return d('Command Prompt', 3, 'terminal');
    if (name === 'windowsterminal.exe' || name === 'openconsole.exe') return d('Windows Terminal', 3, 'terminal');
    if (name === 'code.exe') return d('VS Code', 4, 'editor');
    if (name === 'cursor.exe') return d('Cursor', 4, 'editor');
    if (name === 'explorer.exe') return d('File Explorer', 2, 'explorer');
    if (name === 'msmpeng.exe' || name === 'nissrv.exe') return d('Windows Security scan', 2, 'system');
    if (name === 'searchindexer.exe') return d('Windows Search indexer', 2, 'system');
    if (name === 'git.exe') return d('Git', 4);
    if (name === 'chrome.exe') return d('Chrome', 2);
    if (name === 'msedge.exe') return d('Edge', 2);
    const plain = (p.name || 'Unknown program').replace(/\.exe$/i, '');
    return d(plain + on, 1);
  }

  function groupLocks(procs) {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const rootOf = (p) => {
      let cur = p;
      const seen = new Set([cur.pid]);
      for (;;) {
        if (CONTAINERS.has(lc(cur.name))) return cur;
        const parent = byPid.get(cur.parentPid);
        if (!parent || seen.has(parent.pid) || CONTAINERS.has(lc(parent.name))) return cur;
        seen.add(parent.pid);
        cur = parent;
      }
    };

    const groups = new Map();
    for (const p of procs) {
      const root = rootOf(p);
      if (!groups.has(root.pid)) groups.set(root.pid, { root, members: [] });
      groups.get(root.pid).members.push(p);
    }

    return [...groups.values()].map(({ root, members }) => {
      const ranked = members.map((m) => ({ m, d: describe(m) })).sort((a, b) => b.d.rank - a.d.rank);
      const best = ranked[0];
      const rootD = describe(root);
      const ports = [...new Set(members.flatMap((m) => m.ports || []))];
      const unstoppable = UNSTOPPABLE[lc(root.name)] || (root.pid === 4 ? UNSTOPPABLE.system : null);
      const detail = [];
      if (best.m !== root && rootD.kind === 'terminal') detail.push(`Started from a ${rootD.title}`);
      else if (best.m !== root && root.name) detail.push(`Inside ${rootD.title}`);
      if (members.some((m) => m.runsFromFolder)) detail.push('Its program file is inside this folder');
      else if (members.some((m) => m.moduleCount > 0)) detail.push('It has a library from this folder loaded, such as a native add-on');
      else if (members.some((m) => m.holdsFolder) && rootD.kind === 'terminal' && members.length === 1) {
        detail.push('A terminal is sitting in this folder');
      }
      let warn = null;
      if (rootD.kind === 'editor') warn = `Stopping it closes ${rootD.title} completely. Closing the folder in ${rootD.title} also works.`;
      return {
        root,
        members,
        title: best.d.title,
        kind: best.d.kind,
        ports,
        detail: detail.join('. '),
        command: (best.m.commandLine || best.m.exe || '').trim(),
        pids: members.map((m) => m.pid),
        unstoppable,
        warn,
        files: members.reduce((n, m) => n + (m.handleCount || 0), 0),
        modules: members.reduce((n, m) => n + (m.moduleCount || 0), 0),
        targets: [...new Set(members.flatMap((m) => m.targets || [0]))],
      };
    }).sort((a, b) => (a.unstoppable ? 1 : 0) - (b.unstoppable ? 1 : 0));
  }

  const api = { CONTAINERS, UNSTOPPABLE, npmScript, describe, groupLocks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
