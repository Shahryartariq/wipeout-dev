# Listing copy

Everything you paste into GitHub, winget and the Microsoft Store, written for
the words people actually search for.

## GitHub repository

**Name:** `wipeout-dev`

**About (description, under 350 characters):**

> Delete folders Windows won't let you delete. Wipeout shows the dev server, terminal or app locking a folder, stops it, and wipes node_modules fast, even past the 260-character path limit. Free, open source, Windows 10/11.

**Website:** the Releases page, until there's a site.

**Topics (GitHub allows 20):**

`windows` `file-locking` `locked-files` `unlocker` `delete-folder` `file-in-use` `node-modules` `npkill` `ebusy` `long-paths` `developer-tools` `electron` `desktop-app` `windows-11` `cleanup` `disk-space` `process-manager` `handle` `nodejs` `open-source`

**Social preview image:** upload `docs/social-preview.png` (1280×640) under
Settings → General → Social preview. Links shared on LinkedIn, X or WhatsApp
show it.

**Release title pattern:** `Wipeout 1.0.0: delete locked folders on Windows`

## winget

Submit after the first public release (PR to `microsoft/winget-pkgs`), or run
`wingetcreate new <installer URL>` and use these values:

```yaml
PackageIdentifier: Shahryartariq.Wipeout
PackageName: Wipeout
Publisher: Shehryar Tariq
License: MIT
ShortDescription: Delete folders Windows won't let you delete. Shows what's locking them, stops it, and wipes node_modules fast.
Tags: [unlocker, locked-files, delete, node-modules, developer-tools, file-in-use]
InstallerType: nullsoft
Scope: user
```

Then `winget install Wipeout` works for everyone.

## Microsoft Store (optional, later)

The Store signs the app (no SmartScreen warning) and gives it the identity
the Windows 11 top-level right-click menu needs.

**Short description:**
Delete locked folders. See what's holding them, stop it, wipe them fast.

**Description:**
"The action can't be completed because the folder is open in another program."
Wipeout tells you exactly which program. Not node.exe and a number, but "React
dev server on localhost:3000, started from your PowerShell window". It stops
that program and the processes it started, then deletes the folder quickly,
including huge node_modules folders and paths longer than 260 characters. It
can also clean up every old node_modules under a projects folder in one go.

**Search terms:** unlock folder, delete locked file, file in use, node_modules
cleaner, folder in use, path too long
