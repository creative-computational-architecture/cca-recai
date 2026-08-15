// Tasinabilir surum: kurulum gerektirmeyen, kopyalanip calistirilabilen klasor.
// `npm run app:build` sonrasi calistirilir.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'src-tauri', 'target', 'release');
const out = path.join(root, 'dist', 'CCA-RECAI-portable');

const items = ['cca-recai.exe', 'recai-node.exe', 'app'];

for (const item of items) {
  try {
    await fs.access(path.join(release, item));
  } catch {
    console.error(`Eksik: ${item} - once "npm run app:build" calistir.`);
    process.exit(1);
  }
}

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

for (const item of items) {
  await fs.cp(path.join(release, item), path.join(out, item), { recursive: true });
  console.log(`kopyalandi: ${item}`);
}

// Lisans metinleri dagitimin parcasidir (MIT + Node sidecar bildirimi).
for (const legal of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  await fs.cp(path.join(root, legal), path.join(out, legal));
  console.log(`kopyalandi: ${legal}`);
}

await fs.writeFile(
  path.join(out, 'OKU.txt'),
  [
    'CCA-RECAI - tasinabilir surum',
    '',
    'cca-recai.exe dosyasina cift tikla. Kurulum gerekmez.',
    'Bu klasoru oldugu gibi kopyalayabilirsin; ucu birlikte tasinmalidir:',
    '  cca-recai.exe   - uygulama penceresi ve tepsi ikonu',
    '  recai-node.exe  - izleme motoru (uygulama kendisi baslatir)',
    '  app\\            - sunucu kodu ve arayuz',
    '',
    'Pencere kapatma tusu uygulamayi kapatmaz, tepsiye kucultur.',
    'Cikis icin tepsi ikonuna sag tikla > Cikis.',
    '',
    'Kayitlar: %APPDATA%\\works.caglarcelik.recai\\data',
    '',
  ].join('\r\n'),
  'utf8',
);

console.log(`Hazir: ${out}`);
