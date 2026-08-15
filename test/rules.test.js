import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProcessCandidates, evaluateHealth, healthScore } from '../src/rules.js';

test('eski test prosesini yuksek guvenli aday yapar', () => {
  const now = Date.parse('2026-08-14T23:00:00Z');
  const rows = buildProcessCandidates([
    {
      pid: 1200,
      parentPid: 999,
      name: 'freecad.exe',
      cpu: 8,
      memRss: 102_400,
      started: '2026-08-14T20:00:00Z',
      command: 'freecad.exe',
      params: '-P tests -t test_gui_smoke',
    },
  ], new Map(), now);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].confidence, 'high');
  assert.equal(rows[0].canTerminate, true);
  assert.ok(rows[0].reasons.includes('stale_test'));
});

test('baslangic zamani bilinmeyen test prosesini eski saymaz', () => {
  const rows = buildProcessCandidates([
    {
      pid: 1300,
      parentPid: 999,
      name: 'python.exe',
      cpu: 30,
      memRss: 102_400,
      started: null,
      command: 'python.exe',
      params: '-m pytest tests',
    },
  ], new Map(), Date.parse('2026-08-14T23:00:00Z'));

  // Yuksek CPU nedeniyle aday olabilir ama stale_test kaniti olmadan
  // yuksek guven alamaz; Auto Guard bu prosese dokunamaz.
  assert.ok(rows.every((row) => !row.reasons.includes('stale_test')));
  assert.ok(rows.every((row) => row.confidence !== 'high'));
});

test('birikmis Grasshopper koprulerini tek tek aday yapar', () => {
  const processes = Array.from({ length: 5 }, (_, index) => ({
    pid: 2000 + index,
    parentPid: 100,
    name: 'python3.13.exe',
    cpu: 0.1,
    memRss: 24_000,
    started: '2026-08-14T22:00:00Z',
    command: 'python.exe',
    params: '-m grasshopper_mcp.bridge',
  }));
  const rows = buildProcessCandidates(processes, new Map(), Date.parse('2026-08-14T23:00:00Z'));

  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.reasons.includes('duplicate_bridge')));
  assert.ok(rows.every((row) => row.duplicateCount === 5));
});

test('Windows cekirdek prosesini aday listesine hic koymaz', () => {
  const rows = buildProcessCandidates([
    { pid: 800, parentPid: 4, name: 'svchost.exe', cpu: 45, memRss: 80_000, command: 'svchost.exe', params: '' },
  ]);

  assert.equal(rows.length, 0);
});

test('CPU, disk ve sicaklik esiklerini birlikte raporlar', () => {
  const snapshot = {
    cpu: { load: 96 },
    memory: { usedPercent: 73 },
    disks: [{ mount: 'C:', usePercent: 97, freeGb: 10 }],
    temperature: { max: 91 },
    candidates: [],
  };
  const alerts = evaluateHealth(snapshot);

  assert.deepEqual(alerts.map((row) => row.severity), ['critical', 'critical', 'critical']);
  assert.ok(healthScore(snapshot, alerts) < 50);
});
