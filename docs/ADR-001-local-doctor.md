# ADR-001: A full-scope local Windows doctor

**Status:** Accepted
**Date:** 2026-08-14

## Context

CCA-RECAI watches CPU, RAM, disk, temperature, process spikes and critical
Windows events. It keeps the findings that matter, reports on storage and
software inventory, and — on request — has a CLI AI interpret the summary.
The feature scope is deliberately not narrowed. Even so, the monitor must not
become the thing that slows the machine down: that is a baseline quality
condition, not a nice-to-have.

## Decision

A Node.js service bound to `127.0.0.1` only, with a browser dashboard. No
Electron. Live metrics come from `systeminformation`, durable records are
human-readable JSONL, and Windows events are collected through narrowly scoped
PowerShell queries.

Cleanup and uninstalling are not automatic. The first version shows evidence,
risk and estimated gain. AI analysis is bound to a user button, runs in an
ephemeral Codex CLI session and uses a read-only sandbox.

## Options considered

| Option | Resource cost | Packaging | Sensor access | Decision |
|---|---:|---:|---:|---|
| Electron | High | Easy | Medium | Rejected |
| Python + Qt | Medium | Medium | Good | Next alternative |
| Node + local web | Low | Easy | Good | **Chosen** |
| Tauri | Low | More involved | Good | V1 packaging candidate |

## Consequences

- Low overhead while the application is open.
- A browser tab acts as the interface; no separate Chromium copy is launched.
- If a sensor cannot be read, no fake temperature is produced — the line reads
  "no sensor".
- JSONL evidence is easy for both a human and an AI to review.
- A Windows service, a tray icon and a packaged EXE are later delivery layers of
  the same product.
