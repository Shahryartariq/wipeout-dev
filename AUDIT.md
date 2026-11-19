# Wipeout 1.0 audit

Audited Nov 15, 2026 against the 0.2 code base. Every finding below was fixed
in 1.0.0 unless marked **open**.

**How it was verified**
- **Unit:** `npm test`.
- **E2E:** `npm run e2e`, 14 flows driven through the real Electron app.
- **Pkg:** a real packaged build with fuses on, launched and screenshotted.
- **Lint:** ESLint, clean.
- **CI-Win:** checked only when GitHub Actions runs on `windows-latest`, because this audit ran on Linux. Those rows stay unproven until the first CI run is green.

Severity: **Critical** = data loss or harm to the system · **High** = wrong result or broken flow · **Medium** = confusing or degraded · **Low** = polish.

## 1. User flows: missing, incomplete or wrong

| # | Finding | Severity | Fix | Verified |
| --- | --- | --- | --- | --- |
| F1 | Dropping a junction or symlink and wiping it deleted the contents of the folder it pointed to | Critical | The engine `lstat`s the root and removes only the link; the UI says "This is a link" | Unit, E2E |
| F2 | "Choose another", drag-drop or right-click during a wipe abandoned the wipe silently and lost its progress | High | Every navigation path is blocked while busy, with a message; buttons are disabled | E2E |
| F3 | Closing the window mid-wipe killed the worker with no warning | High | Confirmation dialog: Keep wiping / Stop and quit | Manual (dialog) |
| F4 | Stop could kill an unrelated program if the original exited and Windows reused its PID | High | Before `taskkill`, the PID's name and start time must still match the scan | CI-Win (`--describe` tested) |
| F5 | "Restart as administrator": the new copy could lose the single-instance race and quit, so nothing opened; declining UAC gave no feedback | High | The lock is released before relaunch and re-taken if declined; failure is shown | Manual |
| F6 | Cancelling a wipe or a failed wipe got stuck: the reload was blocked by the "busy" guard | High | The view is reset before reload (found while fixing F2) | E2E |
| F7 | Dropping a file (not a folder) cleared the folder on screen | Medium | The new folder is validated before the screen changes | E2E |
| F8 | Overlapping lock scans (Stop, then Rescan) could show older results over newer ones | Medium | Sequence numbers; stale results are dropped | Code review |
| F9 | The lock list went stale after the user closed a terminal elsewhere | Medium | Auto-rescan when the window regains focus (throttled to 3 s) | Manual |
| F10 | Settings popover couldn't be closed with Escape or a click outside | Low | Both close it; focus returns to the gear | E2E |
| F11 | Running as admin silently breaks drag-drop from Explorer (Windows UIPI) | Low | A note explains it and points to "Choose another" | Code review |
| F12 | Scripts named like `send-invite.js` or `next-steps.js` were labelled Vite or Next.js dev servers | Medium | Tighter command-line patterns; unit tests for false positives | Unit |
| F13 | Turning the right-click entry off was undone by the next install or update | Medium | The choice is stored in `HKCU\Software\Wipeout`; the installer respects it | CI-Win (installer) |
| F14 | Uninstalling left the right-click entry pointing at a missing exe | Medium | The NSIS uninstall step removes it | CI-Win (installer) |
| F15 | The portable build registered its temporary extracted copy in the right-click menu | Medium | Uses `PORTABLE_EXECUTABLE_FILE` | Code review |
| F16 | A wipe event arriving before the job id was stored could be ignored | Low | Events for the current folder are accepted while wiping | E2E |

## 2. Security

| # | Finding | Severity | Fix | Verified |
| --- | --- | --- | --- | --- |
| S1 | F1 above (link following) | Critical | See F1 | Unit, E2E |
| S2 | The PowerShell scanner cached a compiled DLL in `%LOCALAPPDATA%`. Another program could swap it and have an *elevated* Wipeout load it (privilege escalation) | High | The cache is gone; compile happens in memory; the default scanner is now a shipped `.exe` | Code review |
| S3 | IPC handlers trusted any caller | High | Every handler checks the sender is our window and our `index.html` | E2E |
| S4 | No limits on navigation, new windows, webviews or permission prompts | Medium | All blocked or denied | E2E (navigation) |
| S5 | The CSP allowed inline styles | Medium | `style-src 'self'`; widths set through the DOM; also `object-src`, `base-uri` and `form-action` set to `'none'` | Lint, E2E |
| S6 | Electron's dangerous switches were available in the shipped app (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`) | Medium | Fuses off; only loads the integrity-checked `app.asar` | Pkg |
| S7 | The temporary target list was created with a predictable name | Low | Random name, exclusive create, mode 600; the helper now takes targets over stdin instead | Code review |
| S8 | "Restart as administrator" passed an unvalidated path to the elevated copy | Low | Validated as an existing folder first | Code review |
| S9 | The app, through Chromium, contacted Google services in the background, contradicting "sends nothing" | Medium | Component updates, background networking, pings and domain reliability are disabled | Pkg (no outbound connections seen) |
| S10 | The kill path had no log | Low | Every stop, wipe, refusal and failure is logged (paths only) | Code review |
| S11 | Updates aren't code-signed, so electron-updater can't verify the publisher | Medium, **open** | Needs a code-signing certificate; see `docs/LISTING.md` → Microsoft Store as the free route | n/a |
| S12 | `npm audit`: 6 moderate in build tooling (minimatch via electron-builder) | Low, **accepted** | Dev-only; not shipped; inputs are our own files. The shipped dependencies have 0 | `npm audit --omit=dev` |

Already in place and re-checked: `contextIsolation`, `sandbox`, no
`nodeIntegration`, narrow preload API, `execFile` with argument arrays (no
shell), batch deletes limited to `node_modules`/`target`, protected-folder
refusals, never stopping Explorer, Defender or core Windows processes.

## 3. Performance

| # | Finding | Severity | Fix | Result |
| --- | --- | --- | --- | --- |
| P1 | Each lock scan started PowerShell, compiled C# and queried WMI: several seconds every time | High | A compiled `wipeout-locks.exe` does handles, modules, command lines, parents and ports natively | Timed in CI-Win (`test:windows` prints ms) |
| P2 | Batch mode rebuilt the whole list on every progress tick (about 10 per second) | Medium | Progress updates only the bar; the list re-renders only when a folder finishes | E2E |
| P3 | Rescans fired on every focus change | Low | Throttled to one per 3 s and skipped while busy | Code review |
| P4 | Delete engine: 106,002 items scanned in 2.0 s and wiped in 2.4 s on a 2-core Linux sandbox (`rm -rf`: 1.2 s). Windows numbers come from `npm run bench` in CI | Info | Kept parallel deletion; on Windows NTFS it has measured faster than sequential tools | `npm run bench` |
| P5 | Peak memory for a 100k-file wipe: 190 MB RSS (all paths held in memory) | Low, **open** | Fine up to about 1M files; stream the walk if that ever matters | Measured |
| P6 | Installer size is dominated by Electron (about 360 MB unpacked) | Low, **open** | Tauri port later (see research doc) | Pkg |

## 4. Workflows (development, CI, release)

| # | Finding | Severity | Fix | Verified |
| --- | --- | --- | --- | --- |
| W1 | No automated tests of the UI flows | High | `test/e2e.js` runs 14 flows in Electron, on Windows and on Linux (xvfb) | E2E |
| W2 | The lock scanner had never run on Windows | High | `test/windows-locks.test.js` starts real processes holding a folder three ways and checks both scanners find them | CI-Win |
| W3 | No CI, no lockfile, no lint | Medium | `package-lock.json`, ESLint, `ci.yml` (Windows + Linux) | Lint |
| W4 | No release path | Medium | Tag `vX.Y.Z` → `release.yml` checks the tag matches `package.json`, tests, builds the installer and portable exe, and creates a draft release; installed copies auto-update once it's published | CI-Win |
| W5 | The helper binary had no build step | Medium | `npm run build:helper` (Windows' own `csc.exe`, or Mono); CI rebuilds it from source | Unit (Mono build) |
| W6 | No changelog, license or security policy | Low | `CHANGELOG.md`, `LICENSE` (MIT), `SECURITY.md` | n/a |

## 5. SEO / discoverability

There is no website yet, so this covers where people will find the app:
GitHub, search results, winget and the Store.

| # | Finding | Severity | Fix |
| --- | --- | --- | --- |
| SEO1 | The README didn't contain the phrases people search for | High | New "Fixes these errors" section with the exact Windows and npm messages (`EBUSY`, "open in another program", "Source Path Too Long") |
| SEO2 | No package metadata (keywords, homepage, repository) | Medium | Added to `package.json`; the repository is set to `Shahryartariq/wipeout-dev` |
| SEO3 | No GitHub description, topics or social preview | Medium | Ready to paste in `docs/LISTING.md`; preview image at `docs/social-preview.png` (1280×640) |
| SEO4 | Not installable from a package manager | Medium, **open** | winget manifest values in `docs/LISTING.md`, to submit after the first public release |
| SEO5 | The name "Wipeout" competes with a PlayStation game on GitHub and Google | Medium | Handle `wipeout-dev` and title "Wipeout: delete locked folders on Windows" put the purpose in every listing |
| SEO6 | The screenshots didn't show the main value | Low | New screenshots: a dev server holding a folder, batch clean-up |

## What still needs a Windows machine

1. Push to GitHub and let `ci.yml` run. Then `test:windows`, the Windows e2e run and the installer build are proven, along with F4, F13, F14, P1 and W2.
2. Install the built `Wipeout-Setup-1.0.0.exe` once. Check the right-click entry, then uninstall and check that it's gone.
3. Decide on code signing (S11) before announcing it widely.
