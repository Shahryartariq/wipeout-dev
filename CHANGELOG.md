# Changelog

## 1.0.0 (2026-11-15)

First production release.

**New**
- Compiled lock scanner (`wipeout-locks.exe`). There's no runtime PowerShell compile, it's much faster, and it reads command lines, parents and ports natively. PowerShell remains a fallback.
- Installer (with auto-update from GitHub Releases) and a portable `.exe`.
- The right-click "Wipe out" entry is added on install and removed on uninstall. Turning it off is remembered across updates.
- Settings show the version and an *Open log folder* button. A rotating log file and crash reporting are added.
- Lock list refreshes when you switch back to Wipeout (say, after closing a terminal).
- Ctrl+O to choose a folder; Escape closes settings.
- Remembers the window's size and position.

**Fixed**
- Dropping a junction or symlink no longer risks deleting what it points to: only the link is removed.
- Stopping a program now confirms its PID wasn't reused by another process.
- You can't switch folders or start another job while a wipe runs. Closing the window mid-wipe asks first.
- "Restart as administrator" no longer races the single-instance lock, and says so when UAC is declined.
- A file dropped by mistake no longer clears the folder on screen.
- Scripts like `send-invite.js` or `next-steps.js` were mislabelled as Vite or Next.js dev servers.
- Overlapping lock scans can no longer overwrite newer results with older ones.
- Batch progress no longer rebuilds the whole list ten times a second.

**Security**
- IPC calls are accepted only from the app's own page. Navigation, new windows, webviews and permission requests are blocked.
- The Content-Security-Policy no longer allows inline styles.
- Electron fuses are set: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no inspector flags, and the app loads only from its integrity-checked archive.
- The PowerShell fallback no longer loads a cached DLL from a user-writable folder.
- Temporary target lists are created with unpredictable names and exclusive access.

## 0.2.0
- DLL and native add-on lock detection, batch clean-up of old `node_modules`, "What it's holding" details.

## 0.1.0
- First MVP: lock finder, process-tree stop, fast delete, git check, hold to wipe.
