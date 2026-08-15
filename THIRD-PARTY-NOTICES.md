# Third-Party Notices

CCA-RECAI is licensed under the MIT License (see [LICENSE](LICENSE)).
Built distributions (the installer and the portable folder) bundle the
following third-party software:

## Node.js runtime (bundled as `recai-node.exe`)

The desktop build ships an unmodified copy of the official Node.js
executable, renamed to `recai-node.exe`, to run the monitoring backend.

- License: MIT (with additional component licenses listed in the Node.js
  LICENSE file)
- Source and license text: https://github.com/nodejs/node/blob/main/LICENSE

## systeminformation (npm dependency)

System metrics library used by the backend.

- Copyright (c) Sebastian Hildebrandt
- License: MIT
- Source: https://github.com/sebhildebrandt/systeminformation

## Tauri (desktop shell, compiled into `cca-recai.exe`)

- License: MIT OR Apache-2.0
- Source: https://github.com/tauri-apps/tauri

Also from the Tauri ecosystem: `tauri-plugin-single-instance`
(MIT OR Apache-2.0).

## windows-sys (Rust dependency)

Windows API bindings used by the desktop shell.

- Copyright (c) Microsoft Corporation
- License: MIT OR Apache-2.0
- Source: https://github.com/microsoft/windows-rs

## Runtime integrations (not bundled)

At runtime CCA-RECAI can *read* data from software that is already
installed on the user's machine. None of the following is included in
this repository or in the built distributions:

- LibreHardwareMonitor / OpenHardwareMonitor WMI namespaces (temperature
  sensors, read-only)
- Codex CLI (optional AI analysis; launched with the user's own account,
  read-only sandbox)
