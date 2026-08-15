import crypto from 'node:crypto';

const PROTECTED_NAMES = new Set([
  'system',
  'registry',
  'smss',
  'csrss',
  'wininit',
  'services',
  'lsass',
  'winlogon',
  'svchost',
  'dwm',
  'fontdrvhost',
  'memory compression',
  'secure system',
]);

const NORMAL_MULTI_PROCESS = new Set([
  'chrome',
  'msedge',
  'firefox',
  'chatgpt',
  'codex',
  'code',
  'zcode',
  'msedgewebview2',
  'runtimebroker',
  'nvcontainer',
  'searchhost',
  'svchost',
]);

const TEST_PATTERN = /(?:^|\s)(?:-t\s+test_[^\s]*|pytest(?:\.exe)?|unittest|vitest|jest)(?:\s|$|\.)/i;
const GH_BRIDGE_PATTERN = /-m\s+grasshopper_mcp\.bridge/i;

function cleanName(name = '') {
  return String(name).replace(/\.exe$/i, '').trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ageMinutes(started, now = Date.now()) {
  const parsed = Date.parse(started);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, (now - parsed) / 60_000);
}

function candidateId(proc) {
  const signature = `${proc.pid}|${proc.started || ''}|${proc.name || ''}`;
  return `${proc.pid}-${crypto.createHash('sha256').update(signature).digest('hex').slice(0, 10)}`;
}

export function buildProcessCandidates(processes, baselines = new Map(), now = Date.now()) {
  const livePids = new Set(processes.map((proc) => Number(proc.pid)));
  const commandGroups = new Map();

  for (const proc of processes) {
    const name = cleanName(proc.name || proc.command);
    const command = `${proc.command || ''} ${proc.params || ''}`.trim();
    const key = `${name.toLowerCase()}|${command.toLowerCase()}`;
    const list = commandGroups.get(key) || [];
    list.push(proc);
    commandGroups.set(key, list);
  }

  const candidates = [];
  for (const proc of processes) {
    const pid = Number(proc.pid);
    const name = cleanName(proc.name || proc.command || `PID ${pid}`);
    const normalizedName = name.toLowerCase();
    const command = `${proc.command || ''} ${proc.params || ''}`.trim();
    const commandKey = `${normalizedName}|${command.toLowerCase()}`;
    const groupMembers = commandGroups.get(commandKey) || [];
    const duplicateCount = groupMembers.length;
    const cpu = Math.max(0, number(proc.cpu));
    const ramMb = Math.max(0, number(proc.memRss) / 1024);
    const age = ageMinutes(proc.started, now);
    const parentPid = Number(proc.parentPid || 0);
    const parentMissing = parentPid > 4 && !livePids.has(parentPid);
    const baseline = baselines.get(pid);
    const protectedProcess = PROTECTED_NAMES.has(normalizedName) || pid <= 4 || pid === process.pid;
    if (normalizedName === 'system idle process' || protectedProcess) continue;
    const reasons = [];
    let confidence = 'review';

    // Baslangic zamani okunamayan test prosesi "eski" sayilmaz: kanit yoksa
    // iddia yok. Aksi halde Auto Guard yeni baslamis bir testi kapatabilir.
    if (TEST_PATTERN.test(command) && age !== null && age >= 45) {
      reasons.push('stale_test');
      confidence = 'high';
    }
    if (GH_BRIDGE_PATTERN.test(command) && duplicateCount >= 3) {
      reasons.push('duplicate_bridge');
      confidence = duplicateCount >= 6 ? 'high' : 'medium';
    }
    if (cpu >= 25) {
      reasons.push('high_cpu');
      if (confidence === 'review') confidence = 'medium';
    }
    if (baseline?.samples >= 3 && cpu >= 20 && cpu >= baseline.ewma + 18) {
      reasons.push('cpu_spike');
      if (confidence === 'review') confidence = 'medium';
    }
    if (ramMb >= 2048) {
      reasons.push('high_ram');
    }
    if (parentMissing && age !== null && age >= 60 && cpu >= 5) {
      reasons.push('orphan_load');
      if (confidence === 'review') confidence = 'medium';
    }
    if (
      duplicateCount >= 5 &&
      command.length >= 8 &&
      !NORMAL_MULTI_PROCESS.has(normalizedName) &&
      !reasons.includes('duplicate_bridge')
    ) {
      reasons.push('many_copies');
    }

    if (reasons.length === 0) continue;
    const newestMember = [...groupMembers].sort((a, b) => {
      const aTime = Date.parse(a.started) || 0;
      const bTime = Date.parse(b.started) || 0;
      return bTime - aTime || Number(b.pid) - Number(a.pid);
    })[0];
    candidates.push({
      id: candidateId(proc),
      pid,
      parentPid,
      name,
      cpu: Number(cpu.toFixed(1)),
      ramMb: Number(ramMb.toFixed(1)),
      ageMinutes: age === null ? null : Number(age.toFixed(1)),
      duplicateCount,
      reasons: [...new Set(reasons)],
      confidence,
      canTerminate: !protectedProcess,
      protected: protectedProcess,
      newestInGroup: duplicateCount > 1 && Number(newestMember?.pid) === pid,
      command: command.slice(0, 500),
      started: proc.started || null,
    });
  }

  const rank = { high: 3, medium: 2, review: 1 };
  return candidates
    .sort((a, b) => rank[b.confidence] - rank[a.confidence] || b.cpu - a.cpu || b.ramMb - a.ramMb)
    .slice(0, 80);
}

export function evaluateHealth(snapshot) {
  const alerts = [];
  const cpu = number(snapshot.cpu?.load);
  const ram = number(snapshot.memory?.usedPercent);

  // `rule` alani arayuzde gorunur: her uyari bir kural kimligine izlenir.
  // Kimlikler degisirse arayuz metinleri de degismelidir.
  if (cpu >= 90) {
    alerts.push({ key: 'cpu-critical', rule: 'K-CPU-90', severity: 'critical', title: 'CPU tavanda', detail: `Toplam yuk %${cpu.toFixed(0)}.` });
  } else if (cpu >= 80) {
    alerts.push({ key: 'cpu-high', rule: 'K-CPU-80', severity: 'warning', title: 'CPU yuku yuksek', detail: `Toplam yuk %${cpu.toFixed(0)}.` });
  }

  if (ram >= 92) {
    alerts.push({ key: 'ram-critical', rule: 'K-RAM-92', severity: 'critical', title: 'RAM kritik', detail: `Bellek kullanimi %${ram.toFixed(0)}.` });
  } else if (ram >= 82) {
    alerts.push({ key: 'ram-high', rule: 'K-RAM-82', severity: 'warning', title: 'RAM yuku yuksek', detail: `Bellek kullanimi %${ram.toFixed(0)}.` });
  }

  for (const disk of snapshot.disks || []) {
    if (disk.usePercent >= 95 || disk.freeGb < 15) {
      alerts.push({ key: `disk-critical-${disk.mount}`, rule: 'K-DSK-95', severity: 'critical', title: `${disk.mount} diski kritik`, detail: `${disk.freeGb.toFixed(1)} GB bos alan.` });
    } else if (disk.usePercent >= 90 || disk.freeGb < 50) {
      alerts.push({ key: `disk-low-${disk.mount}`, rule: 'K-DSK-90', severity: 'warning', title: `${disk.mount} diski dolu`, detail: `${disk.freeGb.toFixed(1)} GB bos alan.` });
    }
  }

  const maxTemperature = number(snapshot.temperature?.max, -1);
  if (maxTemperature >= 90) {
    alerts.push({ key: 'temperature-critical', rule: 'K-ISI-90', severity: 'critical', title: 'Sicaklik kritik', detail: `En yuksek sensor ${maxTemperature.toFixed(0)} C.` });
  } else if (maxTemperature >= 82) {
    alerts.push({ key: 'temperature-high', rule: 'K-ISI-82', severity: 'warning', title: 'Sicaklik yuksek', detail: `En yuksek sensor ${maxTemperature.toFixed(0)} C.` });
  }

  const highCandidates = (snapshot.candidates || []).filter((item) => item.confidence === 'high');
  if (highCandidates.length) {
    alerts.push({
      key: 'high-confidence-processes',
      rule: 'K-PRC-01',
      severity: 'warning',
      title: `${highCandidates.length} guclu proses adayi`,
      detail: highCandidates.slice(0, 3).map((item) => `${item.name} (${item.pid})`).join(', '),
    });
  }

  return alerts;
}

export function healthScore(snapshot, alerts) {
  let score = 100;
  score -= Math.max(0, number(snapshot.cpu?.load) - 65) * 0.45;
  score -= Math.max(0, number(snapshot.memory?.usedPercent) - 70) * 0.35;
  for (const alert of alerts) score -= alert.severity === 'critical' ? 14 : 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function isProtectedProcessName(name) {
  return PROTECTED_NAMES.has(cleanName(name).toLowerCase());
}
