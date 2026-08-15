import { EventEmitter } from 'node:events';
import os from 'node:os';
import si from 'systeminformation';
import { buildProcessCandidates, evaluateHealth, healthScore } from './rules.js';
import { readHardwareSensors, readImportantWindowsEvents } from './windows.js';

const SAMPLE_MS = 3_000;
const HISTORY_LIMIT = 600;

function settledValue(result, fallback) {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function processRamMb(proc) {
  return Math.max(0, finite(proc.memRss) / 1024);
}

function compactProcess(proc) {
  return {
    pid: Number(proc.pid),
    parentPid: Number(proc.parentPid || 0),
    name: String(proc.name || proc.command || 'unknown').replace(/\.exe$/i, ''),
    cpu: Number(Math.max(0, finite(proc.cpu)).toFixed(1)),
    ramMb: Number(processRamMb(proc).toFixed(1)),
    started: proc.started || null,
    command: `${proc.command || ''} ${proc.params || ''}`.trim().slice(0, 500),
  };
}

function temperatureState(cpuTemperature, graphics, sensorRows) {
  const sensors = [];
  if (finite(cpuTemperature?.main, -1) > 0) {
    sensors.push({ name: 'CPU', value: finite(cpuTemperature.main), source: 'systeminformation' });
  }
  for (const [index, value] of (cpuTemperature?.cores || []).entries()) {
    if (finite(value, -1) > 0) sensors.push({ name: `CPU Core ${index + 1}`, value: finite(value), source: 'systeminformation' });
  }
  for (const controller of graphics?.controllers || []) {
    if (finite(controller.temperatureGpu, -1) > 0) {
      sensors.push({ name: controller.model || 'GPU', value: finite(controller.temperatureGpu), source: 'GPU' });
    }
  }
  for (const row of sensorRows || []) {
    if (finite(row.Value, -1) > 0) sensors.push({ name: row.Name || 'Sensor', value: finite(row.Value), source: row.Source || 'WMI' });
  }

  const unique = [];
  const seen = new Set();
  for (const sensor of sensors) {
    const key = `${sensor.name}|${Math.round(sensor.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...sensor, value: Number(sensor.value.toFixed(1)) });
  }
  const max = unique.length ? Math.max(...unique.map((sensor) => sensor.value)) : null;
  return { available: unique.length > 0, max, sensors: unique.slice(0, 24) };
}

function recaiLine(snapshot) {
  const critical = snapshot.alerts.find((item) => item.severity === 'critical');
  if (critical) return `Recai: ${critical.title.toLowerCase()}; once bunu cozuyoruz.`;
  const stale = snapshot.candidates.find((item) => item.reasons.includes('stale_test'));
  if (stale) return `Recai: ${stale.name} testi eve gitmeyi unutmus.`;
  const duplicate = snapshot.candidates.find((item) => item.reasons.includes('duplicate_bridge'));
  if (duplicate) return `Recai: ayni kopruden ${duplicate.duplicateCount} tane olmus; trafik var.`;
  if (snapshot.cpu.load >= 75) return 'Recai: motor bagiriyor; yuk dagilimini izliyorum.';
  return 'Recai: sistem sakin. Nobetteyim.';
}

export class DoctorMonitor extends EventEmitter {
  constructor({ store, sampleMs = SAMPLE_MS } = {}) {
    super();
    this.store = store;
    this.sampleMs = sampleMs;
    this.timer = null;
    this.sampling = false;
    this.tick = 0;
    this.history = [];
    this.state = null;
    this.staticInfo = null;
    this.processList = [];
    this.disks = [];
    this.diskIo = {};
    this.cpuTemperature = {};
    this.graphics = {};
    this.sensorRows = [];
    this.baselines = new Map();
    this.candidateSeen = new Map();
    this.candidateMap = new Map();
    this.alertCooldown = new Map();
    this.windowsEventKeys = new Set();
    this.lastSnapshotWrite = 0;
  }

  async init() {
    const [cpu, system, osInfo] = await Promise.allSettled([si.cpu(), si.system(), si.osInfo()]);
    this.staticInfo = {
      computer: os.hostname(),
      model: settledValue(system, {}).model || '',
      manufacturer: settledValue(system, {}).manufacturer || '',
      cpu: settledValue(cpu, {}).brand || '',
      cores: settledValue(cpu, {}).cores || os.cpus().length,
      physicalCores: settledValue(cpu, {}).physicalCores || null,
      platform: settledValue(osInfo, {}).distro || 'Windows',
      release: settledValue(osInfo, {}).release || '',
    };
  }

  async start() {
    if (this.timer) return;
    if (!this.staticInfo) await this.init();
    await this.sample();
    this.timer = setInterval(() => void this.sample(), this.sampleMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState() {
    return this.state;
  }

  getCandidate(id) {
    return this.candidateMap.get(id) || null;
  }

  async sample() {
    if (this.sampling) return;
    this.sampling = true;
    this.tick += 1;
    try {
      const jobs = [si.currentLoad(), si.mem()];
      const indexes = { load: 0, mem: 1 };
      if (this.tick === 1 || this.tick % 2 === 0) {
        indexes.processes = jobs.push(si.processes()) - 1;
      }
      if (this.tick > 1 && this.tick % 5 === 0) {
        indexes.disks = jobs.push(si.fsSize()) - 1;
        indexes.diskIo = jobs.push(si.fsStats()) - 1;
      }
      if (this.tick > 1 && this.tick % 4 === 0) {
        indexes.temperature = jobs.push(si.cpuTemperature()) - 1;
        indexes.graphics = jobs.push(si.graphics()) - 1;
      }

      const results = await Promise.allSettled(jobs);
      const load = settledValue(results[indexes.load], {});
      const mem = settledValue(results[indexes.mem], {});
      if (indexes.processes !== undefined) this.processList = settledValue(results[indexes.processes], {}).list || this.processList;
      if (indexes.disks !== undefined) this.disks = settledValue(results[indexes.disks], this.disks) || this.disks;
      if (indexes.diskIo !== undefined) this.diskIo = settledValue(results[indexes.diskIo], this.diskIo) || this.diskIo;
      if (indexes.temperature !== undefined) this.cpuTemperature = settledValue(results[indexes.temperature], this.cpuTemperature) || this.cpuTemperature;
      if (indexes.graphics !== undefined) this.graphics = settledValue(results[indexes.graphics], this.graphics) || this.graphics;

      const initialTemperature = temperatureState(this.cpuTemperature, this.graphics, this.sensorRows);
      if (!initialTemperature.available && this.tick > 1 && this.tick % 10 === 0) {
        this.sensorRows = await readHardwareSensors();
      }

      const now = Date.now();
      const rawCandidates = buildProcessCandidates(this.processList, this.baselines, now);
      const liveCandidateIds = new Set();
      const candidates = rawCandidates.map((candidate) => {
        liveCandidateIds.add(candidate.id);
        const seen = this.candidateSeen.get(candidate.id) || { firstSeen: now, lastSeen: now };
        seen.lastSeen = now;
        this.candidateSeen.set(candidate.id, seen);
        return { ...candidate, observedForSeconds: Math.round((now - seen.firstSeen) / 1000) };
      });
      for (const [id, seen] of this.candidateSeen) {
        if (!liveCandidateIds.has(id) && now - seen.lastSeen > 60_000) {
          this.candidateSeen.delete(id);
          this.alertCooldown.delete(`process:${id}`);
        }
      }

      this.updateBaselines(this.processList, now);
      this.candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));

      const topCpu = [...this.processList].sort((a, b) => finite(b.cpu) - finite(a.cpu)).slice(0, 24);
      const topRam = [...this.processList].sort((a, b) => finite(b.memRss) - finite(a.memRss)).slice(0, 16);
      const topMap = new Map([...topCpu, ...topRam].map((proc) => [Number(proc.pid), compactProcess(proc)]));
      const disks = (this.disks || [])
        .filter((disk) => finite(disk.size) > 0)
        .map((disk) => ({
          fs: disk.fs,
          mount: disk.mount,
          type: disk.type,
          sizeGb: finite(disk.size) / 1024 ** 3,
          usedGb: finite(disk.used) / 1024 ** 3,
          freeGb: finite(disk.available) / 1024 ** 3,
          usePercent: finite(disk.use),
        }))
        .sort((a, b) => a.mount.localeCompare(b.mount));

      const snapshot = {
        timestamp: new Date(now).toISOString(),
        uptimeSeconds: os.uptime(),
        static: this.staticInfo,
        cpu: {
          load: Number(finite(load.currentLoad).toFixed(1)),
          user: Number(finite(load.currentLoadUser).toFixed(1)),
          system: Number(finite(load.currentLoadSystem).toFixed(1)),
        },
        memory: {
          totalGb: finite(mem.total) / 1024 ** 3,
          usedGb: finite(mem.active || mem.used) / 1024 ** 3,
          availableGb: finite(mem.available || mem.free) / 1024 ** 3,
          usedPercent: finite(mem.total) ? ((finite(mem.active || mem.used) / finite(mem.total)) * 100) : 0,
          swapUsedGb: finite(mem.swapused) / 1024 ** 3,
        },
        disks,
        diskIo: {
          readMbSec: finite(this.diskIo.rx_sec) / 1024 ** 2,
          writeMbSec: finite(this.diskIo.wx_sec) / 1024 ** 2,
        },
        temperature: temperatureState(this.cpuTemperature, this.graphics, this.sensorRows),
        processes: [...topMap.values()].sort((a, b) => b.cpu - a.cpu),
        processCount: this.processList.length,
        candidates,
      };
      snapshot.alerts = evaluateHealth(snapshot);
      snapshot.score = healthScore(snapshot, snapshot.alerts);
      snapshot.recai = recaiLine(snapshot);
      this.history.push({
        timestamp: snapshot.timestamp,
        cpu: snapshot.cpu.load,
        ram: Number(snapshot.memory.usedPercent.toFixed(1)),
        diskRead: Number(snapshot.diskIo.readMbSec.toFixed(2)),
        diskWrite: Number(snapshot.diskIo.writeMbSec.toFixed(2)),
        temperature: snapshot.temperature.max,
      });
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      snapshot.history = this.history;
      this.state = snapshot;

      await this.recordAlerts(snapshot, now);
      if (now - this.lastSnapshotWrite >= 60_000) {
        this.lastSnapshotWrite = now;
        void this.store.append('snapshots', {
          cpu: snapshot.cpu,
          memory: snapshot.memory,
          disks: snapshot.disks,
          diskIo: snapshot.diskIo,
          temperature: snapshot.temperature,
          score: snapshot.score,
          topProcesses: snapshot.processes.slice(0, 8).map(({ pid, name, cpu, ramMb }) => ({ pid, name, cpu, ramMb })),
        });
      }
      this.emit('snapshot', snapshot);

      if (this.tick === 1 || this.tick % 20 === 0) void this.collectWindowsEvents();
    } catch (error) {
      const payload = { type: 'monitor_error', severity: 'warning', message: String(error.message || error) };
      void this.store.append('events', payload);
      this.emit('monitor-error', payload);
    } finally {
      this.sampling = false;
    }
  }

  updateBaselines(processes, now) {
    const live = new Set();
    for (const proc of processes) {
      const pid = Number(proc.pid);
      live.add(pid);
      const cpu = Math.max(0, finite(proc.cpu));
      const current = this.baselines.get(pid) || { ewma: cpu, samples: 0, lastSeen: now };
      current.ewma = current.samples === 0 ? cpu : current.ewma * 0.75 + cpu * 0.25;
      current.samples += 1;
      current.lastSeen = now;
      this.baselines.set(pid, current);
    }
    for (const [pid, current] of this.baselines) {
      if (!live.has(pid) && now - current.lastSeen > 60_000) this.baselines.delete(pid);
    }
  }

  async recordAlerts(snapshot, now) {
    for (const alert of snapshot.alerts) {
      const last = this.alertCooldown.get(alert.key) || 0;
      if (now - last < 5 * 60_000) continue;
      this.alertCooldown.set(alert.key, now);
      await this.store.append('events', { type: 'health_alert', ...alert });
    }
    for (const candidate of snapshot.candidates.filter((item) => item.confidence === 'high')) {
      const key = `process:${candidate.id}`;
      if (this.alertCooldown.has(key)) continue;
      this.alertCooldown.set(key, now);
      await this.store.append('events', {
        type: 'process_candidate',
        severity: 'warning',
        pid: candidate.pid,
        name: candidate.name,
        cpu: candidate.cpu,
        ramMb: candidate.ramMb,
        reasons: candidate.reasons,
        confidence: candidate.confidence,
      });
    }
  }

  async collectWindowsEvents() {
    const rows = await readImportantWindowsEvents(this.tick === 1 ? 15 : 5);
    for (const row of rows) {
      const key = `${row.LogName}|${row.RecordId}`;
      if (this.windowsEventKeys.has(key)) continue;
      this.windowsEventKeys.add(key);
      if (this.windowsEventKeys.size > 2_000) this.windowsEventKeys.delete(this.windowsEventKeys.values().next().value);
      await this.store.append('events', {
        type: 'windows_event',
        severity: String(row.Level).toLowerCase().includes('critical') ? 'critical' : 'warning',
        event: row,
      });
      this.emit('windows-event', row);
    }
  }
}
