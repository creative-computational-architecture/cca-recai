import fs from 'node:fs/promises';
import path from 'node:path';

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export class JsonlStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  append(stream, payload) {
    const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`;
    const filename = path.join(this.dataDir, `${stream}-${dayKey()}.jsonl`);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => fs.appendFile(filename, line, 'utf8'));
    return this.writeQueue;
  }

  async recent(stream, limit = 100) {
    const names = (await fs.readdir(this.dataDir))
      .filter((name) => name.startsWith(`${stream}-`) && name.endsWith('.jsonl'))
      .sort()
      .reverse();

    const rows = [];
    for (const name of names) {
      const raw = await fs.readFile(path.join(this.dataDir, name), 'utf8');
      const lines = raw.trim().split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // Keep reading if a previous run ended during a write.
        }
        if (rows.length >= limit) return rows;
      }
    }
    return rows;
  }

  async saveAiReport(report) {
    const filename = path.join(this.dataDir, `ai-${dayKey()}.md`);
    const block = `\n## ${new Date().toISOString()}\n\n${report.trim()}\n`;
    await fs.appendFile(filename, block, 'utf8');
    return filename;
  }

  async readSettings(defaults) {
    try {
      const raw = await fs.readFile(path.join(this.dataDir, 'settings.json'), 'utf8');
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return { ...defaults };
    }
  }

  async saveSettings(settings) {
    const filename = path.join(this.dataDir, 'settings.json');
    const temp = `${filename}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await fs.rename(temp, filename);
  }
}

