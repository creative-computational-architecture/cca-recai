# ADR-002: Tauri as the desktop shell

**Status:** Accepted
**Date:** 2026-08-15

## Context

ADR-001 accepted a browser tab as the interface. In use that proved thin: RECAI
should be a program you double-click and that stays on watch, not a tab. When
the tab closes the monitoring becomes invisible, the app has no place on the
taskbar, and it does not feel like software.

The ADR-001 table already listed Tauri as the V1 packaging candidate.

## Decision

A Tauri 2 shell. The existing Node backend and the `public/` interface are
**unchanged**; the shell is only a carrier.

1. The Rust side picks a free TCP port (7331 when available).
2. The Node backend is started as a separate process via `std::process::Command`.
3. The shell waits for the port to listen, showing an embedded splash.
4. Once ready, the webview navigates to `http://127.0.0.1:<port>`.

## Options considered

| Option | Memory | Existing code | Sensor access | Decision |
|---|---:|---|---|---|
| Electron | 200–300 MB | Runs as is | Same | Rejected: the monitor becomes the patient |
| C# WPF rewrite | Low | All of it discarded | Best (LibreHardwareMonitorLib) | Next alternative |
| Tauri 2 shell | ~85 MB | Runs as is | Same | **Chosen** |

Measured: shell 31.7 MB + backend 53.8 MB.

## Decisions and why

- **`std::process::Command` instead of `tauri-plugin-shell`.** Two concrete
  gains: the `CREATE_NO_WINDOW` flag means no console window ever appears, and
  the `Child` handle stays in hand so the backend is killed for certain when the
  app exits.
- **Data directory under `%APPDATA%`.** An application installed under Program
  Files cannot write to its own folder. `RECAI_DATA_DIR` overrides it.
- **Closing minimises to the tray.** Watchdog logic: monitoring does not stop
  because a window closed. Real exit lives in the tray menu.
- **Single instance.** A second launch brings the existing window forward. Two
  monitors must never terminate processes at the same time.
- **Frameless window (`decorations: false`).** The interface has its own title
  bar: logo lockup, menu, language strip, theme and window buttons. With the
  native frame left on, two title bars stacked (seen in a screenshot on
  2026-08-15). Dragging uses `data-tauri-drag-region`; the buttons use
  `core:window` permissions. For that, webview IPC access is declared explicitly
  for the local address (`http://127.0.0.1:*`) in the capabilities file — and for
  no other origin.
- **The backend is attached to a Windows Job Object**
  (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`). A clean exit is already handled by
  `RunEvent::Exit`, but that never runs if the shell crashes or is force-killed
  from Task Manager, and the backend is orphaned. Exactly that happened in
  testing: the shell was closed with `Stop-Process -Force` and a 70 MB Node
  process stayed alive. A system-health tool producing the very orphan it exists
  to catch is not acceptable; a kernel guarantee is the only correct fix.
  Verified: force-killing the shell takes the backend count 1 → 0.
- **Backend output and errors are written to `backend.log` and `shell.log`**, so
  nothing fails silently. The trap below was found exactly this way.

## The Windows trap: the `\\?\` path prefix

On Windows, Tauri's `resource_dir()` returns the path in extended-length form
(`\\?\C:\...`). Rust and the Win32 APIs accept it. **Node's module resolver does
not**: parsing the path it reads `C:` as a directory and exits immediately with
`EISDIR: illegal operation on a directory, lstat 'C:'`.

The symptom is misleading: the backend runs fine when launched by hand and only
dies when started by the shell. Every path handed to Node is reduced to plain
form by `plain_path()`.

## Consequences

- The application has a place on the taskbar and in the tray; the tab dependency
  is gone.
- Roughly a third of Electron's memory.
- The Node backend is still a separate process. If it is later replaced by Rust
  `sysinfo`, the shell stays as it is and only the backend moves.
- Most of the package size is the embedded `node.exe` (86 MB). Removing the Node
  dependency removes that; it is an ADR-003 candidate.
