# CCA-RECAI — working notes for contributors

Evidence-first local health monitor for Windows. A Node backend bound to
`127.0.0.1` inside a Tauri desktop shell. No cloud, no telemetry, no account.

## Layout

| Path | What lives here |
|---|---|
| `src/server.js` | HTTP + SSE server, API routes, Auto Guard tick |
| `src/monitor.js` | 3-second sampling loop, snapshot assembly, Windows events |
| `src/rules.js` | Thresholds, rule ids, process-candidate detection, health score |
| `src/audit.js` | Storage audit and the cleanup allowlist |
| `src/windows.js` | PowerShell bridge: sensors, event log, process termination |
| `src/store.js` | JSONL evidence writer |
| `public/` | UI: `index.html` shell, `app.js` screens, `i18n/*.json` |
| `src-tauri/src/main.rs` | Desktop shell: spawns the backend, tray, window |
| `scripts/` | Build staging and the portable packager |

## Architecture rules — do not undo

1. **The backend never binds anywhere but `127.0.0.1`.** Requests with a foreign
   `Host` header are rejected; mutating requests need a local `Origin`.
2. **The backend is bound to a Windows Job Object** (`KILL_ON_JOB_CLOSE`) so it
   can never outlive the shell, even if the shell is force-killed.
3. **Never invent a number.** If a sensor cannot be read, the UI shows `—`.
   `Number(null)` is `0`, so empty values are filtered explicitly.
4. **Cleanup only touches the hard-coded allowlist** in `audit.js`, re-validated
   at delete time. Root directories, the user profile and the Windows folder are
   refused; symlinks are never followed.
5. **Process termination re-checks the PID** against the expected process name
   before killing. Windows core processes never enter the candidate list.
6. **Thresholds in `public/app.js` (`ESIK`) must match `src/rules.js`.** If they
   drift, the interface lies about what it measured.
7. **AI analysis is opt-in per click** and receives only a compact metric
   summary — never file paths or log bodies. No API key lives in this app.

## Two traps that cost real time

- **CSP blocks the inline `style` attribute.** `style-src 'self'` means
  `setAttribute('style', …)` is silently dropped — the attribute shows in the
  DOM but the declaration never applies. Use CSSOM (`element.style.cssText`),
  which CSP does not cover. The `el()` helper already does this.
- **Tauri's `resource_dir()` returns an extended-length path** (`\\?\C:\…`).
  Rust and Win32 accept it; Node's module resolver does not — it reads `C:` as a
  directory and exits with `EISDIR`. `plain_path()` in `main.rs` strips it.

## Language and casing

- UI strings live in `public/i18n/*.json`. Turkish is the primary voice; missing
  keys fall back to `en.json`.
- `text-transform: uppercase` under `lang="tr"` turns `i` into `İ`. Write foreign
  brands and acronyms already capitalised (`GitHub`, `CLI`, `AI`) or mark the
  element `lang="en"`. This bites every time someone forgets.
- Home directories are shortened to `~` in the UI so screenshots and screen
  shares do not leak a username. The full path stays in the JSONL evidence.

## House rules

- No secrets, no session logs, no chat transcripts in this repository.
- English only in code, comments, docs and commit messages.
- Credit tools in the README; never paste tool or session output as content.
- Verify before claiming: run the app, read the log, check the artifact.

## Commands

```bash
npm start          # backend + browser UI on http://127.0.0.1:7331
npm run app        # desktop window (Tauri dev)
npm run app:build  # installer + release binaries
npm test           # unit tests
npm run check      # syntax check
```
