// Paketleme oncesi calisma dosyalarini src-tauri/app/ altina toplar.
// Tauri kaynak desenleri proje kokunun disina (../) cikinca Windows'ta
// cakisiyor; staging bunu tek ve tahmin edilebilir bir agaca indirger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'src-tauri', 'app');

// Tauri sidecar: the desktop build ships its own Node runtime so the app does
// not depend on a system install. The binary is not committed (86 MB), so it is
// copied from the Node running this script. Target triple must match the build.
const sidecar = path.join(root, 'src-tauri', 'binaries', 'recai-node-x86_64-pc-windows-msvc.exe');
try {
  await fs.access(sidecar);
} catch {
  await fs.mkdir(path.dirname(sidecar), { recursive: true });
  await fs.copyFile(process.execPath, sidecar);
  console.log(`sidecar created from ${process.execPath}`);
}

const items = [
  { from: 'src', to: 'src' },
  { from: 'public', to: 'public' },
  { from: 'package.json', to: 'package.json' },
  { from: path.join('node_modules', 'systeminformation'), to: path.join('node_modules', 'systeminformation') },
];

await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });

for (const item of items) {
  const source = path.join(root, item.from);
  const target = path.join(stage, item.to);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  console.log(`staged: ${item.to}`);
}

// Kurulu surumde veri dizini kullanici profiline gider; bos data/ tasinmaz.
console.log(`Hazir: ${stage}`);
