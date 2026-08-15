import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSoftwareInventory } from './windows.js';

const GB = 1024 ** 3;

function candidateRoots() {
  const home = process.env.USERPROFILE || '';
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const windows = process.env.WINDIR || 'C:\\Windows';
  return [
    { label: 'Kullanici gecici dosyalari', root: process.env.TEMP, risk: 'safe', note: 'Acik programlarin kullandigi dosyalar silinmemeli.' },
    { label: 'Windows gecici dosyalari', root: path.join(windows, 'Temp'), risk: 'safe', note: 'Yonetici izni gereken dosyalar olabilir.' },
    { label: 'Windows Update indirme artigi', root: path.join(windows, 'SoftwareDistribution', 'Download'), risk: 'review', note: 'Yalnizca guncelleme tamamlandiysa temizlenir.' },
    { label: 'Crash dump kayitlari', root: path.join(local, 'CrashDumps'), risk: 'review', note: 'Hata teshisi bittiyse temizlenebilir.' },
    { label: 'DirectX shader cache', root: path.join(local, 'D3DSCache'), risk: 'safe', note: 'Gerekirse yeniden olusur.' },
    { label: 'NPM cache', root: path.join(local, 'npm-cache'), risk: 'review', note: 'Paketler gerekirse yeniden indirilir.' },
    { label: 'Pip cache', root: path.join(local, 'pip', 'Cache'), risk: 'review', note: 'Python paketleri gerekirse yeniden indirilir.' },
    { label: 'Genel gelistirici cache', root: path.join(home, '.cache'), risk: 'review', note: 'Alt klasorler tek tek incelenmeli.' },
    { label: 'Chrome cache', root: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), risk: 'safe', note: 'Chrome kapaliyken temizlenir.' },
    { label: 'Edge cache', root: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), risk: 'safe', note: 'Edge kapaliyken temizlenir.' },
    // Cerez/site verisi her zaman inceleme sinifidir: silinince oturumlar
    // kapanir ve kayitli girisler gider. Onay olmadan asla temizlenmez.
    { label: 'Chrome cerez ve site verisi', root: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Network'), risk: 'review', note: 'Oturumlar kapanir, kayitli girisler silinir. Chrome kapaliyken temizlenir.' },
    { label: 'Edge cerez ve site verisi', root: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Network'), risk: 'review', note: 'Oturumlar kapanir, kayitli girisler silinir. Edge kapaliyken temizlenir.' },
    { label: 'VS Code cache', root: path.join(roaming, 'Code', 'Cache'), risk: 'safe', note: 'VS Code kapaliyken temizlenir.' },
    { label: 'NuGet paket cache', root: path.join(home, '.nuget', 'packages'), risk: 'review', note: 'Build sirasinda paketler yeniden indirilir.' },
    { label: 'Gradle cache', root: path.join(home, '.gradle', 'caches'), risk: 'review', note: 'Build sirasinda cache yeniden olusur.' },
  ].filter((item) => item.root).map((item) => ({
    ...item,
    id: crypto.createHash('sha256').update(path.resolve(item.root).toLowerCase()).digest('hex').slice(0, 12),
  }));
}

function isBroadOrUnsafeRoot(root) {
  const resolved = path.resolve(root);
  const forbidden = [
    path.parse(resolved).root,
    process.env.USERPROFILE,
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.WINDIR,
    process.cwd(),
  ].filter(Boolean).map((item) => path.resolve(item).toLowerCase());
  return forbidden.includes(resolved.toLowerCase());
}

export async function removeDirectoryContents(root, { deadlineMs = 60_000, entryLimit = 500_000 } = {}) {
  const resolvedRoot = path.resolve(root);
  if (isBroadOrUnsafeRoot(resolvedRoot)) throw new Error('Genis veya guvensiz temizleme kok dizini reddedildi.');
  const rootPrefix = `${resolvedRoot}${path.sep}`.toLowerCase();
  const started = Date.now();
  let deletedFiles = 0;
  let deletedFolders = 0;
  let deletedBytes = 0;
  let errors = 0;
  let skippedLinks = 0;
  let visited = 0;
  let partial = false;

  async function visit(directory, removeDirectory) {
    if (Date.now() - started > deadlineMs || visited >= entryLimit) {
      partial = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      errors += 1;
      return;
    }
    for (const entry of entries) {
      if (Date.now() - started > deadlineMs || visited >= entryLimit) {
        partial = true;
        break;
      }
      visited += 1;
      const target = path.resolve(directory, entry.name);
      if (!target.toLowerCase().startsWith(rootPrefix)) {
        errors += 1;
        continue;
      }
      let stat;
      try {
        stat = await fs.lstat(target);
      } catch {
        errors += 1;
        continue;
      }
      if (stat.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      if (stat.isDirectory()) {
        await visit(target, true);
        continue;
      }
      try {
        await fs.unlink(target);
        deletedFiles += 1;
        deletedBytes += stat.size;
      } catch {
        errors += 1;
      }
    }
    if (removeDirectory && !partial) {
      try {
        await fs.rmdir(directory);
        deletedFolders += 1;
      } catch {
        // Locked or non-empty directories stay in place.
      }
    }
  }

  await visit(resolvedRoot, false);
  return { root: resolvedRoot, deletedFiles, deletedFolders, deletedBytes, errors, skippedLinks, partial };
}

async function scanTree(root, { deadlineMs = 15_000, entryLimit = 250_000, collectLarge = false } = {}) {
  const started = Date.now();
  const stack = [root];
  let bytes = 0;
  let files = 0;
  let folders = 0;
  let errors = 0;
  let partial = false;
  const largeFiles = [];

  while (stack.length) {
    if (Date.now() - started > deadlineMs || files + folders >= entryLimit) {
      partial = true;
      break;
    }
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      errors += 1;
      continue;
    }
    folders += 1;
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(full);
        files += 1;
        bytes += stat.size;
        if (collectLarge && stat.size >= GB) {
          largeFiles.push({ path: full, sizeBytes: stat.size, modified: stat.mtime.toISOString() });
        }
      } catch {
        errors += 1;
      }
    }
  }

  return { root, bytes, files, folders, errors, partial, largeFiles };
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function installAgeDays(raw) {
  if (!/^\d{8}$/.test(raw || '')) return null;
  const parsed = Date.parse(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00`);
  return Number.isFinite(parsed) ? Math.floor((Date.now() - parsed) / 86_400_000) : null;
}

export class SystemAudit {
  constructor({ monitor, store }) {
    this.monitor = monitor;
    this.store = store;
    this.status = { state: 'idle', progress: 0, message: 'Tarama hazir.', result: null, error: null };
    this.cleanupRunning = false;
  }

  getStatus() {
    return this.status;
  }

  start() {
    if (this.status.state === 'running' || this.cleanupRunning) return false;
    this.status = { state: 'running', progress: 0, message: 'Depolama adaylari taraniyor.', result: null, error: null };
    void this.run();
    return true;
  }

  async cleanup(candidateIds, { includeReview = false } = {}) {
    if (this.cleanupRunning) throw new Error('Baska bir temizlik halen calisiyor.');
    if (!this.status.result) throw new Error('Once agirlik taramasi yapilmali.');
    const ids = [...new Set(candidateIds.map(String))].slice(0, 20);
    const currentById = new Map(this.status.result.storage.map((item) => [item.id, item]));
    const approvedById = new Map(candidateRoots().map((item) => [item.id, item]));
    const selected = ids.map((id) => currentById.get(id)).filter(Boolean);
    if (!selected.length) throw new Error('Guncel temizleme adayi secilmedi.');
    this.cleanupRunning = true;
    const results = [];
    try {
      for (const item of selected) {
        const approved = approvedById.get(item.id);
        if (!approved || path.resolve(approved.root).toLowerCase() !== path.resolve(item.root).toLowerCase()) {
          results.push({ id: item.id, label: item.label, ok: false, error: 'Path allowlist dogrulamasi basarisiz.' });
          continue;
        }
        if (item.risk === 'review' && !includeReview) {
          results.push({ id: item.id, label: item.label, ok: false, error: 'Inceleme sinifi icin ek onay gerekli.' });
          continue;
        }
        try {
          const result = await removeDirectoryContents(approved.root);
          results.push({ id: item.id, label: item.label, ok: true, risk: item.risk, ...result });
          const stored = currentById.get(item.id);
          if (stored) stored.bytes = Math.max(0, stored.bytes - result.deletedBytes);
        } catch (error) {
          results.push({ id: item.id, label: item.label, ok: false, error: String(error.message || error) });
        }
      }
      const summary = {
        finishedAt: new Date().toISOString(),
        deletedBytes: results.reduce((sum, item) => sum + (item.deletedBytes || 0), 0),
        deletedFiles: results.reduce((sum, item) => sum + (item.deletedFiles || 0), 0),
        errors: results.reduce((sum, item) => sum + (item.errors || 0) + (item.ok ? 0 : 1), 0),
        results,
      };
      await this.store.append('events', {
        type: 'cleanup_complete',
        severity: summary.errors ? 'warning' : 'info',
        deletedBytes: summary.deletedBytes,
        deletedFiles: summary.deletedFiles,
        errors: summary.errors,
        categories: results.map((item) => item.label),
      });
      return summary;
    } finally {
      this.cleanupRunning = false;
    }
  }

  async run() {
    try {
      const roots = candidateRoots();
      const storage = [];
      for (let index = 0; index < roots.length; index += 1) {
        const item = roots[index];
        this.status = {
          ...this.status,
          progress: Math.round((index / (roots.length + 2)) * 100),
          message: `${item.label} olculuyor.`,
        };
        try {
          await fs.access(item.root);
          const scan = await scanTree(item.root);
          storage.push({ ...item, ...scan, root: item.root });
        } catch {
          // Missing cache directories are normal.
        }
      }

      this.status = { ...this.status, progress: 80, message: 'Kurulu programlar ve baslangic girdileri okunuyor.' };
      const inventory = await readSoftwareInventory();
      const running = new Set(
        (this.monitor.getState()?.processes || []).map((proc) => proc.name.toLowerCase()),
      );
      const startupText = normalizeArray(inventory.Startup).map((row) => `${row.Name || ''} ${row.Command || ''}`.toLowerCase()).join('\n');
      const apps = normalizeArray(inventory.Apps)
        .filter((app) => app.Name && !app.SystemComponent)
        .map((app) => {
          const sizeGb = Number(app.EstimatedSizeKB || 0) / 1024 / 1024;
          const simple = String(app.Name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const runningNow = [...running].some((name) => simple.includes(name) || name.includes(simple));
          const startup = simple.length > 3 && startupText.includes(simple);
          const ageDays = installAgeDays(app.InstallDate);
          const reasons = [];
          if (sizeGb >= 1) reasons.push('buyuk_kurulum');
          if (!runningNow && !startup) reasons.push('su_an_pasif');
          if (ageDays !== null && ageDays >= 365) reasons.push('eski_kurulum');
          return {
            ...app,
            sizeGb,
            sizeSource: 'windows_registry_estimate',
            estimateSuspect: sizeGb > 100,
            ageDays,
            runningNow,
            startup,
            reasons,
          };
        })
        .sort((a, b) => b.sizeGb - a.sizeGb || a.Name.localeCompare(b.Name));

      this.status = { ...this.status, progress: 90, message: 'Downloads icindeki buyuk dosyalar bulunuyor.' };
      let largeFiles = [];
      const downloads = path.join(process.env.USERPROFILE || '', 'Downloads');
      try {
        const scan = await scanTree(downloads, { deadlineMs: 20_000, collectLarge: true });
        largeFiles = scan.largeFiles.sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 100);
      } catch {
        // Downloads can be redirected or unavailable.
      }

      const result = {
        finishedAt: new Date().toISOString(),
        storage: storage.sort((a, b) => b.bytes - a.bytes),
        reclaimableBytes: storage.reduce((sum, item) => sum + item.bytes, 0),
        apps,
        startup: normalizeArray(inventory.Startup),
        largeFiles,
        warning: 'Hicbir oge otomatik olarak gereksiz kabul edilmez. Program boyutlari Windows registry tahminidir; gercek klasor boyutu olmayabilir. Silme ve kaldirma bu surumde yapilmaz.',
      };
      this.status = { state: 'done', progress: 100, message: 'Tarama tamamlandi.', result, error: null };
      await this.store.append('events', {
        type: 'audit_complete',
        severity: 'info',
        reclaimableBytes: result.reclaimableBytes,
        appCount: apps.length,
        startupCount: result.startup.length,
        largeFileCount: largeFiles.length,
      });
    } catch (error) {
      this.status = { state: 'error', progress: 100, message: 'Tarama tamamlanamadi.', result: null, error: String(error.message || error) };
      await this.store.append('events', { type: 'audit_error', severity: 'warning', message: this.status.error });
    }
  }
}
