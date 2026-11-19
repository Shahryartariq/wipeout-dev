# Security

Wipeout deletes files and stops programs, so safety bugs matter. If you find
a way to make it delete something it shouldn't, stop a process it shouldn't,
or run code it shouldn't, please report it privately through
[GitHub security advisories](https://github.com/Shahryartariq/wipeout-dev/security/advisories/new)
instead of opening a public issue.

What Wipeout guarantees, and what the tests check:

- It never deletes a whole drive, Windows, Program Files, your user folder,
  any folder that contains those, or its own install folder.
- It never follows a junction or symlink: wiping one removes only the link.
- Batch mode only deletes folders named `node_modules` or `target`.
- It never stops Explorer, Windows Security or core Windows processes. Before
  stopping anything, it confirms the PID still belongs to the same program
  (same name and start time).
- The window can only load its own page; every IPC call is checked to come
  from it; it can't open other windows or navigate away.
