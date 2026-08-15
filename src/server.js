import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JsonlStore } from './store.js';
import { DoctorMonitor } from './monitor.js';
import { SystemAudit } from './audit.js';
import { AiDoctor } from './ai.js';
import { terminateProcess } from './windows.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = process.env.RECAI_DATA_DIR
  ? path.resolve(process.env.RECAI_DATA_DIR)
  : path.join(rootDir, 'data');
const host = '127.0.0.1';
const port = Number(process.env.RECAI_PORT || 7331);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const store = new JsonlStore(dataDir);
await store.init();
const monitor = new DoctorMonitor({ store });
const audit = new SystemAudit({ monitor, store });
const ai = new AiDoctor({ store, rootDir });
let guard = await store.readSettings({
  autoGuard: false,
  autoRules: ['stale_test'],
  autoObservationSeconds: 60,
});
const autoAttempts = new Map(); // aday id -> son deneme (ms); 10 dk sonra yeniden denenebilir
const AUTO_RETRY_MS = 10 * 60_000;
const streamClients = new Set();

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function sendError(response, status, message) {
  sendJson(response, status, { ok: false, error: message });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw new Error('Istek govdesi cok buyuk.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validMutationOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://${host}:${port}` || origin === `http://localhost:${port}`;
}

// DNS rebinding kalkani: sunucu yalnizca 127.0.0.1'i dinler ama rebind edilmis
// bir alan adi uzerinden gelen istekte Host basligi saldirganin alan adini tasir.
function validHost(request) {
  const value = String(request.headers.host || '');
  return value === `${host}:${port}` || value === `localhost:${port}` || value === host || value === 'localhost';
}

async function stopCandidate(candidate, source = 'manual') {
  if (!candidate || !candidate.canTerminate) throw new Error('Bu proses guvenli kapatma adayi degil.');
  const result = await terminateProcess({ pid: candidate.pid, expectedName: candidate.name });
  await store.append('events', {
    type: 'process_termination',
    severity: result.Success ? 'info' : 'warning',
    source,
    pid: candidate.pid,
    name: candidate.name,
    reasons: candidate.reasons,
    success: Boolean(result.Success),
  });
  setTimeout(() => void monitor.sample(), 700);
  return { candidate, result };
}

async function autoGuardTick() {
  const now = Date.now();
  for (const [id, attemptedAt] of autoAttempts) {
    if (now - attemptedAt > AUTO_RETRY_MS) autoAttempts.delete(id);
  }
  if (!guard.autoGuard) return;
  const state = monitor.getState();
  for (const candidate of state?.candidates || []) {
    if (!candidate.canTerminate || candidate.confidence !== 'high') continue;
    if (candidate.observedForSeconds < guard.autoObservationSeconds) continue;
    if (!candidate.reasons.some((reason) => guard.autoRules.includes(reason))) continue;
    if (autoAttempts.has(candidate.id)) continue;
    autoAttempts.set(candidate.id, now);
    try {
      await stopCandidate(candidate, 'auto_guard');
    } catch (error) {
      await store.append('events', {
        type: 'auto_guard_error',
        severity: 'warning',
        pid: candidate.pid,
        name: candidate.name,
        message: String(error.message || error),
      });
    }
  }
}

async function serveStatic(request, response, pathname) {
  let relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filename = path.resolve(publicDir, relative);
  if (!filename.startsWith(`${publicDir}${path.sep}`) && filename !== path.join(publicDir, 'index.html')) {
    sendError(response, 403, 'Gecersiz dosya yolu.');
    return;
  }
  try {
    const body = await fs.readFile(filename);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(filename).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // Yerel sunucuda onbellek kazanci yok; buna karsilik surum yukseltmesinden
      // sonra eski varlik servis etme riski gercek. Her istek yeniden okunur.
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    response.end(body);
  } catch {
    sendError(response, 404, 'Bulunamadi.');
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${host}:${port}`);
    const { pathname } = url;

    if (!validHost(request)) {
      sendError(response, 403, 'Gecersiz Host basligi.');
      return;
    }
    if (request.method === 'POST' && !validMutationOrigin(request)) {
      sendError(response, 403, 'Yerel olmayan istek reddedildi.');
      return;
    }

    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { ok: true, service: 'CCA-RECAI', version: '0.1.0', monitoring: Boolean(monitor.getState()) });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/state') {
      sendJson(response, 200, { ok: true, state: monitor.getState(), guard, audit: audit.getStatus(), ai: ai.getStatus() });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      streamClients.add(response);
      request.on('close', () => streamClients.delete(response));
      return;
    }
    if (request.method === 'GET' && pathname === '/api/events') {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
      sendJson(response, 200, { ok: true, events: await store.recent('events', limit) });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/audit') {
      sendJson(response, 200, { ok: true, audit: audit.getStatus() });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/audit/start') {
      sendJson(response, audit.start() ? 202 : 409, { ok: true, audit: audit.getStatus() });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/audit/cleanup') {
      const body = await readJson(request);
      const candidateIds = Array.isArray(body.candidateIds) ? body.candidateIds : [];
      if (!candidateIds.length) {
        sendError(response, 400, 'Temizleme adayi secilmedi.');
        return;
      }
      const result = await audit.cleanup(candidateIds, { includeReview: Boolean(body.includeReview) });
      sendJson(response, 200, { ok: true, cleanup: result, audit: audit.getStatus() });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/ai') {
      sendJson(response, 200, { ok: true, ai: ai.getStatus() });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/ai/start') {
      const state = monitor.getState();
      if (!state) {
        sendError(response, 503, 'Henuz olcum yok.');
        return;
      }
      const events = await store.recent('events', 150);
      sendJson(response, ai.start(state, events) ? 202 : 409, { ok: true, ai: ai.getStatus() });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/processes/terminate') {
      const body = await readJson(request);
      const ids = Array.isArray(body.candidateIds) ? [...new Set(body.candidateIds)].slice(0, 100) : [];
      if (!ids.length) {
        sendError(response, 400, 'Kapatma adayi secilmedi.');
        return;
      }
      const results = [];
      for (const id of ids) {
        const candidate = monitor.getCandidate(String(id));
        if (!candidate) {
          results.push({ id, ok: false, error: 'Aday artik guncel degil.' });
          continue;
        }
        try {
          results.push({ id, ok: true, ...(await stopCandidate(candidate, 'manual')) });
        } catch (error) {
          results.push({ id, ok: false, error: String(error.message || error) });
        }
      }
      sendJson(response, 200, { ok: results.some((item) => item.ok), results });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/guard') {
      sendJson(response, 200, { ok: true, guard });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/guard') {
      const body = await readJson(request);
      guard = {
        ...guard,
        autoGuard: Boolean(body.autoGuard),
        autoRules: ['stale_test'],
        autoObservationSeconds: Math.max(30, Math.min(600, Number(body.autoObservationSeconds) || 60)),
      };
      await store.saveSettings(guard);
      await store.append('events', { type: 'guard_setting', severity: 'info', autoGuard: guard.autoGuard, autoRules: guard.autoRules });
      sendJson(response, 200, { ok: true, guard });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/report') {
      sendJson(response, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        state: monitor.getState(),
        audit: audit.getStatus().result,
        ai: ai.getStatus(),
        recentEvents: await store.recent('events', 250),
      });
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(request, response, pathname);
      return;
    }
    sendError(response, 404, 'Bulunamadi.');
  } catch (error) {
    sendError(response, 500, String(error.message || error));
  }
});

monitor.on('snapshot', (snapshot) => {
  // Tam gecmis (600 nokta) yalnizca /api/state'te durur; canli akista her
  // 3 saniyede bir yeniden gondermek gereksiz agirliktir. Istemci son
  // noktayi kendisi ekler.
  const { history, ...lean } = snapshot;
  const payload = `event: snapshot\ndata: ${JSON.stringify(lean)}\n\n`;
  for (const client of streamClients) client.write(payload);
});
monitor.on('windows-event', (event) => {
  const payload = `event: windows-event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of streamClients) client.write(payload);
});

const heartbeat = setInterval(() => {
  for (const client of streamClients) client.write(': pulse\n\n');
}, 20_000);
heartbeat.unref?.();

const guardTimer = setInterval(() => void autoGuardTick(), 10_000);
guardTimer.unref?.();

server.listen(port, host, async () => {
  await monitor.start();
  const url = `http://${host}:${port}`;
  console.log(`CCA-RECAI calisiyor: ${url}`);
  if (process.env.RECAI_OPEN_BROWSER === '1') {
    const opener = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    opener.unref();
  }
});

function shutdown() {
  monitor.stop();
  clearInterval(heartbeat);
  clearInterval(guardTimer);
  for (const client of streamClients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
