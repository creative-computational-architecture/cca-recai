import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function compactForAi(snapshot, events) {
  const windowsEventCounts = new Map();
  for (const row of events.filter((item) => item.type === 'windows_event')) {
    const event = row.event || {};
    const key = `${event.Provider || 'unknown'}:${event.Id || 'unknown'}`;
    windowsEventCounts.set(key, (windowsEventCounts.get(key) || 0) + 1);
  }
  return {
    capturedAt: snapshot.timestamp,
    cpu: snapshot.cpu,
    memory: snapshot.memory,
    disks: snapshot.disks,
    diskIo: snapshot.diskIo,
    temperature: snapshot.temperature,
    score: snapshot.score,
    alerts: snapshot.alerts,
    topProcesses: snapshot.processes
      .filter((item) => String(item.name).toLowerCase() !== 'system idle process')
      .slice(0, 15)
      .map(({ pid, name, cpu, ramMb }) => ({ pid, name, cpu, ramMb })),
    processCandidates: snapshot.candidates.slice(0, 20).map(({ pid, name, cpu, ramMb, ageMinutes, duplicateCount, reasons, confidence }) => ({ pid, name, cpu, ramMb, ageMinutes, duplicateCount, reasons, confidence })),
    windowsEventCounts: [...windowsEventCounts].map(([key, count]) => ({ key, count })),
  };
}

export function asciiText(value) {
  const turkish = {
    '\u00e7': 'c', '\u00c7': 'C',
    '\u011f': 'g', '\u011e': 'G',
    '\u0131': 'i', '\u0130': 'I',
    '\u00f6': 'o', '\u00d6': 'O',
    '\u015f': 's', '\u015e': 'S',
    '\u00fc': 'u', '\u00dc': 'U',
  };
  return String(value)
    .replace(/[\u00e7\u00c7\u011f\u011e\u0131\u0130\u00f6\u00d6\u015f\u015e\u00fc\u00dc]/g, (character) => turkish[character])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

export class AiDoctor {
  constructor({ store, rootDir }) {
    this.store = store;
    this.rootDir = rootDir;
    this.status = { state: 'idle', report: null, error: null, startedAt: null, finishedAt: null };
  }

  getStatus() {
    return this.status;
  }

  start(snapshot, events) {
    if (this.status.state === 'running') return false;
    this.status = { state: 'running', report: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
    void this.run(snapshot, events);
    return true;
  }

  async run(snapshot, events) {
    try {
      const payload = compactForAi(snapshot, events);
      const prompt = [
        'Sen CCA-RECAI icindeki Windows Doctor analiz motorusun.',
        'Asagidaki yerel sistem ozeti disinda veri arama ve arac kullanma.',
        'Turkce fakat tamamen ASCII karakterlerle yaz.',
        'Kisa, kanita dayali ve eyleme donuk ol.',
        'Sirayla: ACIL, SONRA, IZLE basliklarini kullan.',
        'Bir prosesi kapatmayi oneriyorsan PID ve kaniti yaz; Windows sistem proseslerini hedefleme.',
        'Sicaklik verisi yoksa sicaklik hakkinda tahmin yapma.',
        'Dosya silme veya program kaldirma icin otomatik komut verme; once inceleme oner.',
        '',
        JSON.stringify(payload, null, 2),
      ].join('\n');

      const codexScript = path.join(process.env.APPDATA || '', 'npm', 'codex.ps1');
      try {
        await fs.access(codexScript);
      } catch {
        throw new Error('Codex CLI PowerShell girisi bulunamadi.');
      }
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        codexScript,
        'exec',
        '--sandbox',
        'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ignore-rules',
        '--color',
        'never',
      ], {
        cwd: this.rootDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(prompt, 'utf8');

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
      });

      const exitCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          reject(new Error('AI analizi 3 dakika icinde tamamlanmadi.'));
        }, 180_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      if (exitCode !== 0 || !stdout.trim()) throw new Error(stderr.trim() || `Codex CLI cikis kodu: ${exitCode}`);

      const report = asciiText(stdout.trim());
      await this.store.saveAiReport(report);
      this.status = { state: 'done', report, error: null, startedAt: this.status.startedAt, finishedAt: new Date().toISOString() };
      await this.store.append('events', { type: 'ai_analysis_complete', severity: 'info' });
    } catch (error) {
      this.status = { state: 'error', report: null, error: String(error.message || error), startedAt: this.status.startedAt, finishedAt: new Date().toISOString() };
      await this.store.append('events', { type: 'ai_analysis_error', severity: 'warning', message: this.status.error });
    }
  }
}
