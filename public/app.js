/* ============================================================
   CCA-RECAI arayuzu
   Kanon tasarim: "RECAI Yeni" (Claude Design).
   Cerceve yok, paket yok: dogrudan DOM.
   ============================================================ */

const DILLER = [
  { kod: 'tr', yon: 'ltr' }, { kod: 'en', yon: 'ltr' }, { kod: 'de', yon: 'ltr' },
  { kod: 'fr', yon: 'ltr' }, { kod: 'ru', yon: 'ltr' }, { kod: 'bg', yon: 'ltr' },
  { kod: 'ar', yon: 'rtl' }, { kod: 'zh', yon: 'ltr' },
];

// Esikler src/rules.js ile ayni olmak zorunda; ayrisirlarsa arayuz yalan soyler.
const ESIK = {
  cpu: { uyari: 80, kritik: 90 },
  ram: { uyari: 82, kritik: 92 },
  disk: { uyari: 90, kritik: 95 },
  isi: { uyari: 82, kritik: 90 },
};

const EKRANLAR = {
  nabiz: { index: '{N}', baslikKey: 'nabiz', aciklamaKey: 'aciklamaNabiz' },
  sensor: { index: '{S}', baslikKey: 'sensor', aciklamaKey: 'aciklamaSensor' },
  temizlik: { index: '{T}', baslikKey: 'temizlik', aciklamaKey: 'aciklamaTemizlik' },
  proses: { index: '{P}', baslikKey: 'proses', aciklamaKey: 'aciklamaProses' },
  log: { index: '{L}', baslikKey: 'log', aciklamaKey: 'aciklamaLog' },
  lisans: { index: '{K}', baslikKey: 'lisans', aciklamaKey: 'aciklamaLisans' },
};

// Neden kodlari -> okunur etiket. `hot` olanlar dogrudan bir eylem onerir.
const NEDEN = {
  stale_test: { key: 'nStaleTest', hot: true },
  duplicate_bridge: { key: 'nDuplicateBridge', hot: true },
  high_cpu: { key: 'nHighCpu', hot: true },
  cpu_spike: { key: 'nCpuSpike', hot: true },
  high_ram: { key: 'nHighRam', hot: false },
  orphan_load: { key: 'nOrphanLoad', hot: false },
  many_copies: { key: 'nManyCopies', hot: false },
};

const GUVEN_SINIF = { high: 'acil', medium: 'uyari', review: 'sakin' };
const GUVEN_ETIKET = { high: 'guvenHigh', medium: 'guvenMedium', review: 'guvenReview' };

const KURAL_TAVSIYE = {
  'K-CPU-90': 'neCPU', 'K-CPU-80': 'neCPU',
  'K-RAM-92': 'neRAM', 'K-RAM-82': 'neRAM',
  'K-DSK-95': 'neDSK', 'K-DSK-90': 'neDSK',
  'K-ISI-90': 'neISI', 'K-ISI-82': 'neISI',
  'K-PRC-01': 'nePRC',
};

const SERI_LIMIT = 100;

/* ---------- durum ---------- */

const durum = {
  ekran: 'nabiz',
  dil: 'tr',
  tema: 'koyu',
  sozluk: {},
  yedekSozluk: {},
  state: null,
  guard: null,
  audit: null,
  ai: null,
  seciliTemizlik: new Set(),
  seciliProses: new Set(),
  onay: false,
  onayProses: false,
  olaylar: [],
  olaylarYuklendi: false,
  olayFiltre: 'hepsi',
  saglayici: 'codex',
  baglanti: 'baglaniyor',
  seri: { cpu: [], ram: [], disk: [], isi: [] },
};

/* ---------- kucuk yardimcilar ---------- */

const $ = (secici) => document.querySelector(secici);

function el(etiket, ozellik = {}, ...cocuklar) {
  const dugum = document.createElement(etiket);
  for (const [ad, deger] of Object.entries(ozellik)) {
    if (deger === null || deger === undefined || deger === false) continue;
    if (ad === 'class') dugum.className = deger;
    else if (ad === 'text') dugum.textContent = deger;
    // CSP `style-src 'self'` satir ici style NITELIGINI engeller; CSSOM'u
    // engellemez. setAttribute('style') kullanilirsa renkler sessizce dusper.
    else if (ad === 'style') dugum.style.cssText = deger;
    else if (ad.startsWith('on')) dugum.addEventListener(ad.slice(2).toLowerCase(), deger);
    else if (ad === 'dataset') Object.assign(dugum.dataset, deger);
    else dugum.setAttribute(ad, deger === true ? '' : deger);
  }
  for (const cocuk of cocuklar.flat()) {
    if (cocuk === null || cocuk === undefined || cocuk === false) continue;
    dugum.append(cocuk.nodeType ? cocuk : document.createTextNode(String(cocuk)));
  }
  return dugum;
}

function svgEl(etiket, ozellik = {}, ...cocuklar) {
  const dugum = document.createElementNS('http://www.w3.org/2000/svg', etiket);
  for (const [ad, deger] of Object.entries(ozellik)) {
    if (deger === null || deger === undefined) continue;
    dugum.setAttribute(ad, deger);
  }
  for (const cocuk of cocuklar.flat()) if (cocuk) dugum.append(cocuk);
  return dugum;
}

function t(anahtar) {
  return durum.sozluk[anahtar] ?? durum.yedekSozluk[anahtar] ?? anahtar;
}

function sinifla(deger, esik) {
  const sayi = Number(deger);
  if (!Number.isFinite(sayi)) return 'sakin';
  if (sayi >= esik.kritik) return 'acil';
  if (sayi >= esik.uyari) return 'uyari';
  return 'sakin';
}

function sinifAdi(sinif) {
  return t(sinif === 'acil' ? 'sinifAcil' : sinif === 'uyari' ? 'sinifUyari' : 'sinifSakin');
}

function sayi(deger, basamak = 0) {
  // Number(null) === 0 oldugu icin bos deger acikca elenir: RECAI olcum
  // yokken 0 gostermez.
  if (deger === null || deger === undefined || deger === '') return '--';
  const parsed = Number(deger);
  return Number.isFinite(parsed) ? parsed.toFixed(basamak) : '--';
}

// Ekranda ev dizini `~` ile kisaltilir: kullanici adi ekran goruntusune ve
// ekran paylasimina sizmaz, satir da okunur kalir. Tam yol JSONL kanitinda durur.
function kisaYol(metin) {
  return String(metin).replace(/[A-Za-z]:\\Users\\[^\\"\s]+/gi, '~');
}

function bayt(deger) {
  const v = Number(deger) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)} GB`;
  if (v >= 1024 ** 2) return `${Math.round(v / 1024 ** 2)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

function saat(deger, tarihli = false) {
  const d = new Date(deger);
  if (Number.isNaN(d.getTime())) return '--';
  return new Intl.DateTimeFormat(durum.dil === 'tr' ? 'tr-TR' : durum.dil, {
    ...(tarihli ? { day: '2-digit', month: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d);
}

let toastTimer = null;
function toast(mesaj) {
  const kutu = $('#toast');
  kutu.textContent = mesaj;
  kutu.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => kutu.classList.remove('show'), 4000);
}

async function api(url, secenek = {}) {
  const cevap = await fetch(url, {
    ...secenek,
    headers: { 'Content-Type': 'application/json', ...(secenek.headers || {}) },
  });
  const govde = await cevap.json();
  if (!cevap.ok || govde.ok === false) throw new Error(govde.error || `HTTP ${cevap.status}`);
  return govde;
}

/* ---------- olculen degerler ---------- */

function vitaller() {
  const s = durum.state;
  const sistemDisk = (s?.disks || []).find((d) => /^C:?\\?$/i.test(d.mount)) || s?.disks?.[0] || null;
  const isi = s?.temperature?.available ? s.temperature.max : null;
  return [
    {
      ad: 'cpu', key: 'cpu', esik: ESIK.cpu, birim: '%',
      deger: s ? Number(s.cpu?.load) : null,
      detay: s ? `${sayi(s.cpu?.user)} ${t('mKullanici')} · ${sayi(s.cpu?.system)} ${t('mSistem')}` : '—',
    },
    {
      ad: 'ram', key: 'ram', esik: ESIK.ram, birim: '%',
      deger: s ? Number(s.memory?.usedPercent) : null,
      detay: s ? `${sayi(s.memory?.usedGb, 1)} / ${sayi(s.memory?.totalGb, 1)} GB` : '—',
    },
    {
      ad: t('sistemDiski'), key: 'disk', esik: ESIK.disk, birim: '%',
      deger: sistemDisk ? Number(sistemDisk.usePercent) : null,
      detay: sistemDisk ? `${sayi(sistemDisk.freeGb, 1)} GB · ${sistemDisk.mount}` : '—',
    },
    {
      ad: t('sicaklik'), key: 'isi', esik: ESIK.isi, birim: 'C',
      deger: isi === null || isi === undefined ? null : Number(isi),
      detay: s?.temperature?.available ? (s.temperature.sensors[0]?.name || 'cpu') : t('sensorYok'),
    },
  ];
}

function bandSinifi() {
  const uyarilar = durum.state?.alerts || [];
  if (uyarilar.some((u) => u.severity === 'critical')) return 'acil';
  if (uyarilar.length) return 'uyari';
  return 'sakin';
}

/* ---------- seri (grafik gecmisi) ---------- */

function seriEkle(s) {
  const sistemDisk = (s.disks || []).find((d) => /^C:?\\?$/i.test(d.mount)) || s.disks?.[0];
  const ekle = (anahtar, deger) => {
    const dizi = durum.seri[anahtar];
    dizi.push(Number.isFinite(Number(deger)) ? Number(deger) : null);
    if (dizi.length > SERI_LIMIT) dizi.shift();
  };
  ekle('cpu', s.cpu?.load);
  ekle('ram', s.memory?.usedPercent);
  ekle('disk', sistemDisk?.usePercent);
  ekle('isi', s.temperature?.available ? s.temperature.max : null);
}

function seriTohumla(gecmis) {
  if (!Array.isArray(gecmis) || !gecmis.length) return;
  const son = gecmis.slice(-SERI_LIMIT);
  durum.seri.cpu = son.map((n) => (Number.isFinite(Number(n.cpu)) ? Number(n.cpu) : null));
  durum.seri.ram = son.map((n) => (Number.isFinite(Number(n.ram)) ? Number(n.ram) : null));
  durum.seri.isi = son.map((n) => (Number.isFinite(Number(n.temperature)) ? Number(n.temperature) : null));
  // Disk yuzdesi sunucu gecmisinde yok; istemci tarafinda birikir.
  durum.seri.disk = [];
}

function noktalar(dizi, genislik, yukseklik, ustBosluk = 0) {
  const veri = dizi.filter((v) => v !== null);
  if (veri.length < 2) return null;
  const alan = yukseklik - ustBosluk * 2;
  return dizi
    .map((v, i) => {
      if (v === null) return null;
      const x = (i / (dizi.length - 1)) * genislik;
      const y = ustBosluk + (1 - Math.max(0, Math.min(100, v)) / 100) * alan;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' ');
}

/* ---------- EKRAN 1: NABIZ ---------- */

function vitalSatiri(v) {
  const sinif = v.deger === null ? 'sakin' : sinifla(v.deger, v.esik);
  const renk = `var(--rc-${sinif === 'acil' ? 'crit' : sinif === 'uyari' ? 'warn' : 'ok'})`;
  const dolgu = `var(--rc-${sinif === 'acil' ? 'critf' : sinif === 'uyari' ? 'warnf' : 'okf'})`;

  const G = 400;
  const Y = 72;
  const pad = 6;
  const kritikY = Y * (1 - v.esik.kritik / 100);
  const seri = durum.seri[v.key] || [];
  const cizgi = noktalar(seri, G, Y, pad);

  const katmanlar = [
    svgEl('rect', { x: 0, y: 0, width: G, height: kritikY.toFixed(1), fill: 'var(--rc-critf)' }),
  ];
  if (cizgi) {
    katmanlar.push(svgEl('polygon', { points: `0,${Y} ${cizgi} ${G},${Y}`, fill: dolgu }));
  }
  katmanlar.push(svgEl('line', {
    x1: 0, y1: kritikY.toFixed(1), x2: G, y2: kritikY.toFixed(1),
    stroke: '#C8102E', 'stroke-width': 1, 'stroke-dasharray': '6 4',
  }));
  if (cizgi) {
    katmanlar.push(svgEl('polyline', { points: cizgi, fill: 'none', stroke: renk, 'stroke-width': 2 }));
  }

  return el('div', { class: 'vital-row' },
    el('div', { class: 'vital-label', style: `border-inline-start-color:${renk}` },
      el('span', { class: 'vital-name', text: v.ad }),
      el('span', { class: 'vital-detail', text: v.detay }),
      el('span', { class: 'vital-chip' },
        el('i', { class: `sev-square sev-${sinif}` }),
        el('span', { text: `${sinifAdi(sinif)} · ${t('esik')} ${v.esik.kritik}` }),
      ),
    ),
    el('div', { class: 'vital-chart' },
      svgEl('svg', { viewBox: `0 0 ${G} ${Y}`, preserveAspectRatio: 'none' }, katmanlar),
    ),
    el('div', { class: 'vital-value' },
      el('b', { class: `c-${sinif}`, text: v.deger === null ? '—' : sayi(v.deger) }),
      el('span', { text: v.birim }),
    ),
  );
}

function anaGrafik() {
  const G = 700;
  const Y = 260;
  const kritikY = Y * (1 - 90 / 100);   // 26
  const uyariY = Y * (1 - 80 / 100);    // 52
  const sinif = sinifla(durum.state?.cpu?.load, ESIK.cpu);
  const renk = `var(--rc-${sinif === 'acil' ? 'crit' : sinif === 'uyari' ? 'warn' : 'ok'})`;
  const dolgu = `var(--rc-${sinif === 'acil' ? 'critf' : sinif === 'uyari' ? 'warnf' : 'okf'})`;

  const cpu = noktalar(durum.seri.cpu, G, Y);
  const ram = noktalar(durum.seri.ram, G, Y);

  const katmanlar = [
    svgEl('rect', { x: 0, y: 0, width: G, height: kritikY, fill: 'var(--rc-critf)' }),
    svgEl('rect', { x: 0, y: kritikY, width: G, height: uyariY - kritikY, fill: 'var(--rc-warnf)' }),
    svgEl('rect', { x: 0, y: uyariY, width: G, height: Y - uyariY, fill: 'var(--rc-okf)' }),
    svgEl('g', { stroke: 'var(--rc-aux)', 'stroke-width': '.8', 'stroke-dasharray': '14 5 2 5' },
      svgEl('line', { x1: 0, y1: 130, x2: G, y2: 130 }),
      svgEl('line', { x1: 0, y1: 195, x2: G, y2: 195 }),
      [140, 280, 420, 560].map((x) => svgEl('line', { x1: x, y1: 0, x2: x, y2: Y })),
    ),
    svgEl('line', { x1: 0, y1: kritikY, x2: G, y2: kritikY, stroke: '#C8102E', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }),
    svgEl('line', { x1: 0, y1: uyariY, x2: G, y2: uyariY, stroke: 'var(--rc-warn)', 'stroke-width': 1, 'stroke-dasharray': '8 5' }),
  ];
  if (cpu) katmanlar.push(svgEl('polygon', { points: `0,${Y} ${cpu} ${G},${Y}`, fill: dolgu }));
  if (ram) katmanlar.push(svgEl('polyline', { points: ram, fill: 'none', stroke: 'var(--rc-t2)', 'stroke-width': 1.6, 'stroke-dasharray': '5 3.5' }));
  if (cpu) katmanlar.push(svgEl('polyline', { points: cpu, fill: 'none', stroke: renk, 'stroke-width': 2.2 }));
  katmanlar.push(
    svgEl('text', { x: G - 6, y: 14, 'text-anchor': 'end', fill: 'var(--rc-crit)', 'font-size': 9, 'font-family': 'var(--mono)' }, document.createTextNode(t('kritikBant'))),
    svgEl('text', { x: G - 6, y: 46, 'text-anchor': 'end', fill: 'var(--rc-warn)', 'font-size': 9, 'font-family': 'var(--mono)' }, document.createTextNode(t('uyariBant'))),
  );

  const v = vitaller();
  const okuma = `cpu ${sayi(v[0].deger)} · ram ${sayi(v[1].deger)} · disk ${sayi(v[2].deger)}`;

  return [
    el('div', { class: 'main-chart-head' },
      el('p', { class: 'mono-heading', text: `// ${t('canliNabiz')}` }),
      el('div', { class: 'chart-legend' },
        el('span', { style: `color:${renk}` }, el('i'), el('span', { text: 'cpu' })),
        el('span', {}, el('i', { style: 'border-top-style:dashed' }), el('span', { text: 'ram' })),
        el('span', { style: 'color:#C8102E' }, el('i', { style: 'border-top-style:dashed' }), el('span', { text: `${t('esik')} 90` })),
      ),
    ),
    el('div', { class: 'main-chart' }, svgEl('svg', { viewBox: `0 0 ${G} ${Y}`, preserveAspectRatio: 'none' }, katmanlar)),
    el('div', { class: 'main-chart-foot' },
      el('span', { text: `-5 ${t('dk')}` }),
      el('span', { text: okuma }),
      el('span', { text: t('simdi') }),
    ),
  ];
}

function triyajKarti(uyari) {
  const sinif = uyari.severity === 'critical' ? 'acil' : 'uyari';
  const kural = uyari.rule || '—';
  const tavsiye = t(KURAL_TAVSIYE[kural] || 'kanitYok');
  const hedef = kural.startsWith('K-DSK') ? 'temizlik' : kural.startsWith('K-ISI') ? 'sensor' : null;

  return el('article', { class: `triage-card ${sinif}` },
    el('div', { class: 'triage-strip' },
      el('span', { text: sinifAdi(sinif) }),
      el('span', { text: kural }),
    ),
    el('div', { class: 'triage-body' },
      el('h3', { text: uyari.title }),
      el('p', { class: 'triage-detail', text: uyari.detail || '' }),
      el('p', { class: 'triage-todo' },
        el('b', { text: `${t('neYapmali')} · ` }),
        el('span', { text: tavsiye }),
      ),
      hedef && el('button', {
        class: 'triage-link',
        text: `${hedef === 'temizlik' ? t('bandAcilDugme') : t('sensorHatti')} →`,
        onclick: () => ekranSec(hedef),
      }),
    ),
  );
}

function nabizEkrani() {
  const v = vitaller();
  const uyarilar = durum.state?.alerts || [];
  const sensorler = durum.state?.temperature?.sensors || [];

  const sol = el('div', { class: 'split-main' },
    ...v.map(vitalSatiri),
    ...anaGrafik(),
  );

  const triyaj = el('div', { class: 'side-block' },
    el('div', { class: 'side-head' },
      el('p', { class: 'mono-heading', text: `// ${t('triyaj')}` }),
      el('p', { class: 'mono-label', text: `${uyarilar.length} · ${t('triyaj')}` }),
    ),
    uyarilar.length
      ? el('div', { class: 'triage-list' }, ...uyarilar.map(triyajKarti))
      : el('p', { class: 'triage-empty', text: t('uyariYok') }),
  );

  const sensorOzet = el('div', { class: 'side-block' },
    el('p', { class: 'mono-heading', text: `// ${t('sensorKisa')}` }),
    sensorler.length
      ? el('div', { class: 'sensor-grid' }, ...sensorler.slice(0, 6).map((s) => {
        const sinif = sinifla(s.value, ESIK.isi);
        return el('div', {},
          el('i', { class: `sev-square sev-${sinif}` }),
          el('span', { text: String(s.name).toLowerCase().slice(0, 14) }),
          el('b', { text: sayi(s.value) }),
        );
      }))
      : el('p', { class: 'empty-line', text: t('sensorYokMetin') }),
  );

  const legend = el('div', { class: 'side-block' },
    el('div', { class: 'legend-chips' },
      el('span', {}, el('i', { class: 'sev-sakin' }), el('span', { text: t('sinifSakin') })),
      el('span', {}, el('i', { class: 'sev-uyari' }), el('span', { text: t('sinifUyari') })),
      el('span', {}, el('i', { class: 'sev-acil' }), el('span', { text: t('sinifAcil') })),
    ),
  );

  return el('div', { class: 'split pulse-split' }, sol, el('div', { class: 'split-side' }, triyaj, sensorOzet, legend));
}

/* ---------- EKRAN 2: TEMIZLIK ---------- */

const TEMIZLIK_GRUP = {
  'Chrome cache': 'gTarayici', 'Edge cache': 'gTarayici',
  'Chrome cerez ve site verisi': 'gTarayici', 'Edge cerez ve site verisi': 'gTarayici',
  'Kullanici gecici dosyalari': 'gSistem', 'Windows gecici dosyalari': 'gSistem',
  'Windows Update indirme artigi': 'gSistem', 'Crash dump kayitlari': 'gSistem',
  'DirectX shader cache': 'gSistem',
};

function temizlikSatiri(oge) {
  const secili = durum.seciliTemizlik.has(oge.id);
  const inceleme = oge.risk === 'review';
  return el('button', {
    class: `row pick cols-clean${secili ? ' selected' : ''}`,
    onclick: () => {
      if (secili) durum.seciliTemizlik.delete(oge.id);
      else durum.seciliTemizlik.add(oge.id);
      durum.onay = false;
      ekranCiz();
    },
  },
    el('span', { class: 'check' }),
    el('span', {},
      el('span', { class: 'row-name', text: oge.label }),
      el('p', { class: 'row-sub', text: `${kisaYol(oge.root)} · ${oge.files} ${t('dosya')}${oge.partial ? ` · ${t('kismi')}` : ''}. ${oge.note}` }),
    ),
    el('span', { class: 'row-num', text: bayt(oge.bytes) }),
    el('span', { class: 'row-tag' },
      el('i', { class: `sev-square ${inceleme ? 'sev-uyari' : 'sev-sakin'}` }),
      el('span', { text: inceleme ? t('incele') : t('dusukRisk') }),
    ),
  );
}

async function temizle() {
  const idler = [...durum.seciliTemizlik];
  const depolama = durum.audit?.result?.storage || [];
  const secilenler = depolama.filter((x) => idler.includes(x.id));
  const incelemeSayisi = secilenler.filter((x) => x.risk === 'review').length;
  try {
    const govde = await api('/api/audit/cleanup', {
      method: 'POST',
      body: JSON.stringify({ candidateIds: idler, includeReview: incelemeSayisi > 0 }),
    });
    durum.seciliTemizlik.clear();
    durum.onay = false;
    toast(`${bayt(govde.cleanup.deletedBytes)} · ${govde.cleanup.deletedFiles} ${t('dosya')}`);
    await taramaBaslat();
  } catch (hata) {
    toast(hata.message);
  }
}

async function taramaBaslat() {
  try {
    const govde = await api('/api/audit/start', { method: 'POST', body: '{}' });
    durum.audit = govde.audit;
    ekranCiz();
    const zamanlayici = setInterval(async () => {
      try {
        const guncel = await api('/api/audit');
        durum.audit = guncel.audit;
        if (guncel.audit.state !== 'running') clearInterval(zamanlayici);
        ekranCiz();
      } catch {
        clearInterval(zamanlayici);
      }
    }, 1500);
  } catch (hata) {
    toast(hata.message);
  }
}

function temizlikEkrani() {
  const sonuc = durum.audit?.result;
  const calisiyor = durum.audit?.state === 'running';
  const depolama = sonuc?.storage || [];
  const secilenler = depolama.filter((x) => durum.seciliTemizlik.has(x.id));
  const toplam = secilenler.reduce((a, x) => a + (x.bytes || 0), 0);
  const incelemeSayisi = secilenler.filter((x) => x.risk === 'review').length;

  const araclar = el('div', { class: 'clean-toolbar' },
    el('p', { class: 'mono-heading', text: `// ${t('secili')}` }),
    el('span', { class: 'clean-total', text: bayt(toplam) }),
    el('span', { class: 'clean-note', text: `${secilenler.length} · ${incelemeSayisi} ${t('incele')}` }),
    el('div', { class: 'clean-actions' },
      el('button', {
        class: 'text-button',
        text: t('guvenliSec'),
        onclick: () => {
          durum.seciliTemizlik = new Set(depolama.filter((x) => x.risk !== 'review').map((x) => x.id));
          durum.onay = false;
          ekranCiz();
        },
      }),
      el('button', {
        class: 'text-button',
        text: t('secimBirak'),
        onclick: () => { durum.seciliTemizlik.clear(); durum.onay = false; ekranCiz(); },
      }),
      el('button', {
        class: `text-button ${secilenler.length ? 'primary' : 'idle'}`,
        text: t('seciliTemizle'),
        onclick: () => { if (secilenler.length) { durum.onay = true; ekranCiz(); } },
      }),
    ),
  );

  const onayKutusu = durum.onay && secilenler.length
    ? el('div', { class: 'confirm' },
      el('p', { class: 'confirm-strip', text: t('onayGerekli') }),
      el('div', { class: 'confirm-body' },
        el('p', { style: 'margin:0', text: `${secilenler.map((x) => x.label).join(', ')} — ${bayt(toplam)}.${incelemeSayisi ? ` ${incelemeSayisi} ${t('incele')}.` : ''}` }),
        el('div', { class: 'confirm-actions' },
          el('button', { class: 'text-button', text: t('vazgec'), onclick: () => { durum.onay = false; ekranCiz(); } }),
          el('button', { class: 'text-button primary', text: t('sil'), onclick: temizle }),
        ),
      ),
    )
    : null;

  const gruplar = new Map();
  for (const oge of depolama) {
    const grup = TEMIZLIK_GRUP[oge.label] || 'gGelistirici';
    if (!gruplar.has(grup)) gruplar.set(grup, []);
    gruplar.get(grup).push(oge);
  }

  const liste = el('div', { class: 'list' },
    el('div', { class: 'row-head cols-clean' },
      el('span'), el('span', { text: t('aday') }), el('span', { style: 'text-align:end', text: t('boyut') }), el('span', { text: t('sinif') }),
    ),
    ...(depolama.length
      ? [...gruplar].flatMap(([grup, ogeler]) => [
        el('p', { class: 'group-label', text: `// ${t(grup)}` }),
        ...ogeler.map(temizlikSatiri),
      ])
      : [el('p', { class: 'empty-line', text: calisiyor ? `${t('taramaSuruyor')} — ${durum.audit.message}` : t('taramaYapilmadi') })]),
  );

  const yan = el('div', { class: 'split-side' },
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('tarama')}` }),
      el('p', { class: 'mono-meta', style: 'margin:6px 0 8px', text: sonuc ? `${t('sonTarama')} ${saat(sonuc.finishedAt, true)}` : t('taramaYapilmadi') }),
      el('button', { class: 'text-button solid', text: calisiyor ? t('taramaSuruyor') : t('taramaYenile'), onclick: taramaBaslat }),
    ),
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('silinmeyecek')}` }),
      el('ul', { class: 'promise-list' },
        ...['[01]', '[02]', '[03]', '[04]', '[05]'].map((n, i) => el('li', {},
          el('i', { text: n }),
          el('span', { text: [t('soz1'), t('soz2'), t('soz3'), t('soz4'), t('soz5')][i] }),
        )),
      ),
      el('p', { class: 'footnote', text: t('temizlikNot') }),
    ),
  );

  return el('div', { class: 'split clean-split' },
    el('div', { class: 'split-main' }, araclar, onayKutusu, liste),
    yan,
  );
}

/* ---------- EKRAN: PROSES ---------- */

function prosesSatiri(aday) {
  const secili = durum.seciliProses.has(aday.id);
  const sinif = GUVEN_SINIF[aday.confidence] || 'sakin';
  return el('button', {
    class: `row pick cols-proc${secili ? ' selected' : ''}`,
    onclick: () => {
      if (secili) durum.seciliProses.delete(aday.id);
      else durum.seciliProses.add(aday.id);
      durum.onayProses = false;
      ekranCiz();
    },
  },
    el('span', { class: 'check' }),
    el('span', { class: 'proc-cell' },
      el('span', { class: 'proc-line' },
        el('span', { class: 'row-name', text: aday.name }),
        el('span', { class: 'copies', text: `pid ${aday.pid}${aday.duplicateCount > 1 ? ` · ×${aday.duplicateCount}` : ''}` }),
        ...aday.reasons.map((kod) => {
          const tanim = NEDEN[kod] || { key: kod, hot: false };
          return el('span', { class: `reason${tanim.hot ? ' hot' : ''}`, text: t(tanim.key) });
        }),
      ),
      el('p', { class: 'row-sub one-line', text: kisaYol(aday.command) }),
    ),
    el('span', { class: 'row-num', text: `${sayi(aday.ramMb)} MB` }),
    el('span', { class: 'row-tag' },
      el('i', { class: `sev-square sev-${sinif}` }),
      el('span', { text: `${t(GUVEN_ETIKET[aday.confidence])} · ${sayi(aday.ageMinutes)} ${t('dk')}` }),
    ),
  );
}

async function prosesKapat() {
  const idler = [...durum.seciliProses];
  try {
    const govde = await api('/api/processes/terminate', {
      method: 'POST',
      body: JSON.stringify({ candidateIds: idler }),
    });
    const kapanan = govde.results.filter((x) => x.ok && x.result?.Success).length;
    durum.seciliProses.clear();
    durum.onayProses = false;
    toast(`${kapanan}/${idler.length}`);
    setTimeout(() => void olaylariYukle(), 1200);
  } catch (hata) {
    toast(hata.message);
  }
  ekranCiz();
}

function prosesEkrani() {
  const adaylar = (durum.state?.candidates || []).filter((a) => a.canTerminate);
  const gecerli = new Set(adaylar.map((a) => a.id));
  for (const id of durum.seciliProses) if (!gecerli.has(id)) durum.seciliProses.delete(id);
  const secilenler = adaylar.filter((a) => durum.seciliProses.has(a.id));

  const araclar = el('div', { class: 'clean-toolbar' },
    el('p', { class: 'mono-heading', text: `// ${t('secili')}` }),
    el('span', { class: 'clean-total', text: String(secilenler.length) }),
    el('span', { class: 'clean-note', text: `${adaylar.length} ${t('aday')}` }),
    el('div', { class: 'clean-actions' },
      el('button', {
        class: 'text-button',
        text: t('eskiKopyalar'),
        onclick: () => {
          durum.seciliProses = new Set(
            adaylar.filter((a) => !a.newestInGroup && a.duplicateCount >= 3).map((a) => a.id),
          );
          durum.onayProses = false;
          ekranCiz();
        },
      }),
      el('button', {
        class: `text-button ${secilenler.length ? 'primary' : 'idle'}`,
        text: t('seciliKapat'),
        onclick: () => { if (secilenler.length) { durum.onayProses = true; ekranCiz(); } },
      }),
    ),
  );

  const onayKutusu = durum.onayProses && secilenler.length
    ? el('div', { class: 'confirm' },
      el('p', { class: 'confirm-strip', text: t('kapatmaOnayi') }),
      el('div', { class: 'confirm-body' },
        el('p', { style: 'margin:0', text: `${secilenler.map((a) => `${a.name} (${a.pid})`).join(', ')} — ${t('pSoz4')}` }),
        el('div', { class: 'confirm-actions' },
          el('button', { class: 'text-button', text: t('vazgec'), onclick: () => { durum.onayProses = false; ekranCiz(); } }),
          el('button', { class: 'text-button primary', text: t('kapat'), onclick: prosesKapat }),
        ),
      ),
    )
    : null;

  // Guven seviyesi listenin kendi gercegidir: gruplar onu yansitir.
  const gruplar = ['high', 'medium', 'review']
    .map((seviye) => [seviye, adaylar.filter((a) => a.confidence === seviye)])
    .filter(([, liste]) => liste.length);

  const liste = el('div', { class: 'list' },
    el('div', { class: 'row-head cols-proc' },
      el('span'), el('span', { text: t('proses') }),
      el('span', { style: 'text-align:end', text: 'ram' }), el('span', { text: t('kanit') }),
    ),
    ...(adaylar.length
      ? gruplar.flatMap(([seviye, liste_]) => [
        el('p', { class: 'group-label', text: `// ${t(GUVEN_ETIKET[seviye])} · ${liste_.length}` }),
        ...liste_.sort((a, b) => b.ramMb - a.ramMb).map(prosesSatiri),
      ])
      : [el('p', { class: 'empty-line', text: t('adayYokProses') })]),
  );

  const yan = el('div', { class: 'split-side' },
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('kapatilmaz')}` }),
      el('ul', { class: 'promise-list' },
        ...['pSoz1', 'pSoz2', 'pSoz3', 'pSoz4'].map((anahtar, i) => el('li', {},
          el('i', { text: `[0${i + 1}]` }),
          el('span', { text: t(anahtar) }),
        )),
      ),
      el('p', { class: 'footnote', text: 'K-PRC-01' }),
    ),
  );

  return el('div', { class: 'split proc-split' },
    el('div', { class: 'split-main' }, araclar, onayKutusu, liste),
    yan,
  );
}

/* ---------- EKRAN: LOG ---------- */

// Ham tip adi ("ai_analysis_complete") baslik degildir: her tipin okunur
// bir etiketi vardir, sayilar ve mesajlar detaya duser.
const OLAY_ETIKET = {
  health_alert: 'oHealth', process_candidate: 'oCandidate', process_termination: 'oTermination',
  windows_event: 'oWindows', audit_complete: 'oAudit', cleanup_complete: 'oCleanup',
  ai_analysis_complete: 'oAiOk', ai_analysis_error: 'oAiErr', audit_error: 'oAuditErr',
  monitor_error: 'oMonitorErr', auto_guard_error: 'oGuardErr', guard_setting: 'oGuardSet',
};

const OLAY_DETAY = {
  health_alert: (o) => o.detail,
  audit_complete: (o) => `${bayt(o.reclaimableBytes)} · ${o.appCount} ${t('proses')}`,
  cleanup_complete: (o) => `${bayt(o.deletedBytes)} · ${o.deletedFiles} ${t('dosya')}`,
  process_candidate: (o) => `${o.name} · pid ${o.pid} · ${(o.reasons || []).map((r) => t(NEDEN[r]?.key || r)).join(', ')}`,
  process_termination: (o) => `${o.name} · pid ${o.pid} · ${o.success ? 'ok' : '—'}`,
  windows_event: (o) => `${o.event?.Provider || 'Windows'} ${o.event?.Id ?? ''} · ${String(o.event?.Message || '').replace(/\s+/g, ' ').slice(0, 180)}`,
};

function olayMetni(olay) {
  const baslik = olay.title || t(OLAY_ETIKET[olay.type] || olay.type);
  const detay = OLAY_DETAY[olay.type]?.(olay)
    ?? String(olay.message || '').replace(/\s+/g, ' ').slice(0, 200);
  return { baslik, detay };
}

async function olaylariYukle() {
  try {
    const govde = await api('/api/events?limit=300');
    durum.olaylar = govde.events;
    durum.olaylarYuklendi = true;
    if (durum.ekran === 'log') ekranCiz();
  } catch {
    // Log okunamazsa ekran bos kalir; uydurma kayit gosterilmez.
  }
}

function logEkrani() {
  const filtreler = [
    ['hepsi', 'hepsi'], ['critical', 'eAcil'], ['warning', 'eUyari'], ['info', 'eBilgi'],
  ];
  const gorunen = durum.olayFiltre === 'hepsi'
    ? durum.olaylar
    : durum.olaylar.filter((o) => (o.severity || 'info') === durum.olayFiltre);

  const araclar = el('div', { class: 'clean-toolbar' },
    el('p', { class: 'mono-heading', text: `// ${t('kayit')}` }),
    el('span', { class: 'clean-total', text: String(gorunen.length) }),
    el('div', { class: 'filters' }, ...filtreler.map(([deger, anahtar]) => el('button', {
      class: 'filter',
      'aria-pressed': durum.olayFiltre === deger ? 'true' : 'false',
      text: t(anahtar),
      onclick: () => { durum.olayFiltre = deger; ekranCiz(); },
    }))),
  );

  const liste = el('div', { class: 'list' },
    el('div', { class: 'row-head cols-log' },
      el('span', { text: t('simdi') }), el('span', { text: t('kayit') }), el('span', { text: t('tipler') }),
    ),
    ...(gorunen.length
      ? gorunen.map((olay) => {
        const sinif = olay.severity === 'critical' ? 'acil' : olay.severity === 'warning' ? 'uyari' : 'sakin';
        const { baslik, detay } = olayMetni(olay);
        return el('div', { class: 'row cols-log' },
          el('span', { class: 'row-time', text: saat(olay.timestamp, true) }),
          el('span', {},
            el('span', { class: 'log-title' },
              el('i', { class: `sev-square sev-${sinif}` }),
              el('b', { style: 'font-weight:600', text: baslik }),
            ),
            detay && el('p', { class: 'log-detail', text: detay }),
          ),
          // Kural kimligi ve tip adi kod tanimlayicisidir: Turkce buyuk harf
          // kurali uygulanmamali (ai_... -> "Aİ" olurdu).
          el('span', { class: 'row-tag', lang: 'en' }, el('span', { text: olay.rule || olay.type.replaceAll('_', ' ') })),
        );
      })
      : [el('p', { class: 'empty-line', text: durum.olaylarYuklendi ? t('kayitYok') : t('veriBekleniyor') })]),
  );

  const bugun = new Date().toISOString().slice(0, 10);
  const tipSayilari = [...durum.olaylar.reduce((harita, o) => harita.set(o.type, (harita.get(o.type) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]).slice(0, 6);

  const yan = el('div', { class: 'split-side' },
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('kaynakDosya')}` }),
      el('p', { class: 'row-sub', style: 'margin-top:8px', text: `events-${bugun}.jsonl` }),
      el('p', { class: 'footnote', text: '%APPDATA%\\works.caglarcelik.recai\\data' }),
      el('a', { class: 'text-button solid', style: 'margin-top:10px;display:block;text-align:center;text-decoration:none', href: '/api/report', target: '_blank', rel: 'noreferrer', text: t('hamRapor') }),
    ),
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('tipler')}` }),
      el('div', { class: 'sensor-grid stack' }, ...tipSayilari.map(([tip, adet]) => el('div', {},
        el('span', { text: tip.replaceAll('_', ' ') }),
        el('b', { text: String(adet) }),
      ))),
    ),
  );

  return el('div', { class: 'split log-split' },
    el('div', { class: 'split-main' }, araclar, liste),
    yan,
  );
}

/* ---------- EKRAN 3: SENSOR ---------- */

function sensorEkrani() {
  const sicaklik = durum.state?.temperature;
  const var_ = Boolean(sicaklik?.available);
  const sensorler = sicaklik?.sensors || [];

  const basliklar = el('div', { class: 'sensor-head' },
    el('span', { text: t('sensor') }), el('span', { text: t('kaynak') }),
    el('span'), el('span', { style: 'text-align:end', text: t('deger') }),
  );

  const satirlar = (var_ ? sensorler : [{ name: 'CPU Package', source: '—', value: null }, { name: 'CPU Core Max', source: '—', value: null }])
    .map((s) => {
      const sinif = s.value === null ? 'sakin' : sinifla(s.value, ESIK.isi);
      return el('div', { class: `sensor-row ${s.value === null ? '' : sinif}` },
        el('span', { class: 'sensor-cell-name' },
          el('i', { class: `sev-square sev-${sinif}` }),
          el('span', { text: s.name }),
        ),
        el('span', { class: 'sensor-source', text: String(s.source || '—').toLowerCase() }),
        el('span', { class: `gauge${s.value === null ? ' empty' : ''}` },
          s.value !== null && el('i', { class: 'gauge-crit' }),
          s.value !== null && el('i', {
            class: 'gauge-fill',
            style: `width:${Math.max(0, Math.min(100, s.value))}%;background:var(--rc-${sinif === 'acil' ? 'crit' : sinif === 'uyari' ? 'warn' : 'ok'})`,
          }),
          s.value !== null && el('i', { class: 'gauge-tick' }),
        ),
        el('span', { class: 'sensor-value' },
          el('b', { class: `c-${sinif}`, text: s.value === null ? '—' : sayi(s.value) }),
          el('span', { text: 'C' }),
        ),
      );
    });

  const yokKutusu = var_ ? null : el('div', { class: 'nodata' },
    el('p', { class: 'nodata-strip', text: t('veriYok') }),
    el('div', { class: 'nodata-body' },
      el('p', { text: t('sensorYokMetin') }),
      el('p', { class: 'chain' },
        el('i', { text: '[01] ' }), el('span', { text: `${t('kSistem')} → ${t('kOkunamadi')}` }), el('br'),
        el('i', { text: '[02] ' }), el('span', { text: `${t('kLhm')} → ${t('kServisYok')}` }), el('br'),
        el('i', { text: '[03] ' }), el('span', { text: `${t('kOhm')} → ${t('kBulunamadi')}` }),
      ),
      el('a', {
        class: 'triage-link',
        style: 'display:inline-block;margin-top:10px',
        href: 'https://github.com/LibreHardwareMonitor/LibreHardwareMonitor',
        target: '_blank',
        rel: 'noreferrer noopener',
        text: `${t('lhmKurulum')} →`,
      }),
    ),
  );

  const enYuksek = var_ && sensorler.length ? Math.max(...sensorler.map((s) => s.value)) : null;

  const yan = el('div', { class: 'split-side' },
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('hatNotu')}` }),
      el('p', { style: 'margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--rc-t2)', text: var_ ? t('sensorEsikNot') : t('sensorYokMetin') }),
    ),
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('kaynakSirasi')}` }),
      el('div', { class: 'sensor-grid stack' },
        ...[t('kSistem'), t('kLhm'), t('kOhm')].map((ad, i) => el('div', {},
          el('i', { class: `sev-square ${var_ && i === 0 ? 'sev-sakin' : var_ ? 'sev-uyari' : 'sev-acil'}` }),
          el('span', { text: ad }),
        )),
      ),
    ),
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('kimlik')}` }),
      kimlikListesi(),
    ),
  );

  return el('div', { class: 'split sensor-split' },
    el('div', { class: 'split-main' },
      yokKutusu,
      el('div', { class: 'sensor-table' }, basliklar, ...satirlar,
        el('p', { class: 'footnote', text: t('sensorEsikNot') }),
        el('div', { class: 'sensor-foot' },
          el('span', {}, el('span', { text: `${t('enYuksek')}: ` }), el('b', { text: enYuksek === null ? '—' : `${sayi(enYuksek)} C` })),
          el('span', { text: `${t('okumaAraligi')} 3 ${t('sn')}` }),
        ),
      ),
    ),
    yan,
  );
}

function kimlikListesi() {
  const s = durum.state?.static || {};
  const gun = durum.state ? Math.floor(durum.state.uptimeSeconds / 86400) : 0;
  const saatSayisi = durum.state ? Math.floor((durum.state.uptimeSeconds % 86400) / 3600) : 0;
  const satirlar = [
    ['cpu', s.cpu || '—'],
    [t('cekirdek'), `${s.physicalCores ?? '?'} / ${s.cores ?? '?'}`],
    ['windows', `${s.platform || ''} ${s.release || ''}`.trim() || '—'],
    ['uptime', durum.state ? `${gun}${t('gunKisa')} ${saatSayisi}${t('saatKisa')}` : '—'],
    [t('proses'), String(durum.state?.processCount ?? '—')],
  ];
  return el('dl', { class: 'kv' }, ...satirlar.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: v }))));
}

/* ---------- EKRAN 4: LISANS ---------- */

function lisansEkrani() {
  const saglayicilar = [
    // Marka/kisaltmalar buyuk yazilir; Turkce uppercase "cli" -> "CLİ" yapar.
    { kod: 'codex', ad: 'Codex CLI', alt: t('sYerel'), durum: durum.ai?.state === 'error' ? t('sYok') : t('sBulundu') },
    { kod: 'claude', ad: 'Claude CLI', alt: t('sYerel'), durum: t('sYok') },
    { kod: 'endpoint', ad: 'OpenAI uyumlu uç nokta', alt: t('sKendi'), durum: t('sElle') },
  ];

  // Depo agaci ve dosya sorumluluklari gelistirici belgesidir; yeri README.
  // Bu ekran kullaniciya yalnizca "ne aldigini" ve "anahtarin nerede
  // durdugunu" soyler.
  const sol = el('div', { class: 'split-main lisans-main' },
    el('div', { class: 'oss-banner' },
      el('p', { class: 'oss-strip', text: t('acikBaslik') }),
      el('div', { class: 'oss-body' },
        el('p', { text: t('acikMetin') }),
        el('div', { class: 'oss-mit' },
          el('b', { class: 'c-sakin', text: 'MIT' }),
          el('span', { text: t('tumOzellikler') }),
        ),
      ),
    ),
    el('div', { class: 'block' },
      el('a', {
        class: 'support-link',
        lang: 'en',
        href: 'https://github.com/creative-computational-architecture/cca-recai',
        target: '_blank',
        rel: 'noreferrer noopener',
      }, el('span', { text: 'GitHub' }), el('span', { class: 'arrow', text: '→' })),
      el('a', {
        class: 'support-link',
        href: '/api/report',
        target: '_blank',
        rel: 'noreferrer',
      }, el('span', { text: t('hamRapor') }), el('span', { class: 'arrow', text: '→' })),
      el('p', { class: 'footnote', text: t('ucuncuTaraf') }),
    ),
  );

  const aiRapor = durum.ai?.state === 'done' && durum.ai.report
    ? el('pre', { class: 'ai-report', text: durum.ai.report })
    : null;

  const yan = el('div', { class: 'split-side' },
    el('div', { class: 'side-block' },
      el('p', { class: 'mono-heading', text: `// ${t('aiBaglanti')}` }),
      el('p', { style: 'margin:8px 0 10px;font-size:12px;line-height:1.5;color:var(--rc-t2)', text: t('aiMetin') }),
      el('div', { class: 'radio-list' }, ...saglayicilar.map((s) => el('button', {
        class: `radio-row${durum.saglayici === s.kod ? ' on' : ''}`,
        onclick: () => { durum.saglayici = s.kod; ekranCiz(); },
      },
        el('span', { class: 'radio-box' }),
        el('span', {}, el('span', { class: 'radio-name', text: s.ad }), el('p', { class: 'radio-sub', text: s.alt })),
        el('span', { class: 'radio-state', text: s.durum }),
      ))),
      el('button', {
        class: 'text-button solid',
        style: 'margin-top:10px',
        text: durum.ai?.state === 'running' ? t('aiCalisiyor') : t('aiCalistir'),
        onclick: aiBaslat,
      }),
      durum.ai?.state === 'error' && el('p', { class: 'footnote', style: 'color:var(--rc-crit)', text: durum.ai.error }),
      aiRapor,
    ),
    el('div', { class: 'side-block' },
      el('div', { class: 'warn-box', style: 'margin-top:0' },
        el('p', { class: 'warn-strip', text: t('anahtarKurali') }),
        el('p', { class: 'warn-body', text: t('anahtarMetin') }),
      ),
    ),
  );

  return el('div', { class: 'split lisans-split' }, sol, yan);
}

async function aiBaslat() {
  try {
    const govde = await api('/api/ai/start', { method: 'POST', body: '{}' });
    durum.ai = govde.ai;
    ekranCiz();
    const zamanlayici = setInterval(async () => {
      try {
        const guncel = await api('/api/ai');
        durum.ai = guncel.ai;
        if (guncel.ai.state !== 'running') clearInterval(zamanlayici);
        ekranCiz();
      } catch {
        clearInterval(zamanlayici);
      }
    }, 2000);
  } catch (hata) {
    toast(hata.message);
  }
}

/* ---------- kabuk cizimi ---------- */

function ekranSec(ekran) {
  if (!EKRANLAR[ekran]) return;
  durum.ekran = ekran;
  if (location.hash.slice(1) !== ekran) history.replaceState(null, '', `#${ekran}`);
  ciz();
  // Kanit defteri acildiginda taze okunur.
  if (ekran === 'log') void olaylariYukle();
}

function basligiCiz() {
  const tanim = EKRANLAR[durum.ekran];
  const sinif = bandSinifi();
  $('#sheet-index').textContent = tanim.index;
  $('#sheet-eyebrow').textContent = t(tanim.baslikKey);
  $('#sheet-title').textContent = t(tanim.baslikKey);
  $('#sheet-machine').textContent = durum.state?.static?.computer || '—';
  $('#sheet-time').textContent = durum.state ? saat(durum.state.timestamp, true) : '—';
  $('#sheet-explain').textContent = t(tanim.aciklamaKey);

  const skor = $('#score-value');
  const birim = $('#score-unit');
  const etiket = $('#score-label');
  skor.className = 'score';
  if (durum.ekran === 'lisans') {
    etiket.textContent = t('skorLisans');
    skor.textContent = 'MIT';
    skor.classList.add('c-sakin');
    birim.textContent = '';
  } else if (durum.ekran === 'temizlik') {
    etiket.textContent = t('skorToplam');
    const toplam = (durum.audit?.result?.storage || []).reduce((a, x) => a + (x.bytes || 0), 0);
    skor.textContent = bayt(toplam);
    skor.classList.add('wide');
    birim.textContent = '';
  } else {
    etiket.textContent = t('skorSaglik');
    const s = durum.state?.score;
    skor.textContent = s ?? '--';
    skor.classList.add(s === undefined || s === null ? 'c-sakin' : s < 60 ? 'c-acil' : s < 80 ? 'c-uyari' : 'c-sakin');
    birim.textContent = '/100';
  }

  const band = $('#band');
  band.className = `band ${sinif}`;
  $('#band-word').textContent = sinifAdi(sinif);
  const uyarilar = durum.state?.alerts || [];
  $('#band-copy').textContent = uyarilar.length
    ? uyarilar.slice(0, 2).map((u) => `${u.title}: ${u.detail}`).join(' ')
    : t('bandSakinCumle');
  const dugme = $('#band-action');
  dugme.textContent = sinif === 'sakin' ? t('bandSakinDugme') : t('bandAcilDugme');
  dugme.onclick = () => {
    if (sinif === 'sakin') window.open('/api/report', '_blank', 'noreferrer');
    else ekranSec('temizlik');
  };
}

function ekranCiz() {
  const govde = $('#screen-body');
  govde.replaceChildren();
  const cizici = {
    nabiz: nabizEkrani, temizlik: temizlikEkrani, sensor: sensorEkrani,
    proses: prosesEkrani, log: logEkrani, lisans: lisansEkrani,
  }[durum.ekran];
  govde.append(cizici());
  basligiCiz();
}

function durumCubugu() {
  const sinif = bandSinifi();
  const kare = $('#status-square');
  kare.className = `status-square sev-${sinif}${durum.baglanti === 'canli' ? ' blink' : ''}`;
  $('#status-recai').textContent = durum.state?.recai || `recai: ${t('veriBekleniyor')}.`;
  const v = vitaller();
  const baglantiAd = durum.baglanti === 'canli' ? t('canli') : durum.baglanti === 'baglaniyor' ? t('baglaniyor') : t('baglantiYok');
  $('#status-readout').textContent = `cpu ${sayi(v[0].deger)} · ram ${sayi(v[1].deger)} · disk ${sayi(v[2].deger)} · ${baglantiAd}`;
}

function rayiCiz() {
  for (const dugme of document.querySelectorAll('.rail-item[data-goto]')) {
    dugme.classList.toggle('active', dugme.dataset.goto === durum.ekran);
  }
}

function ciz() {
  rayiCiz();
  ekranCiz();
  durumCubugu();
}

/* ---------- i18n ---------- */

async function dilYukle(kod) {
  const cevap = await fetch(`/i18n/${kod}.json`);
  if (!cevap.ok) throw new Error(`i18n ${kod}`);
  return cevap.json();
}

async function dilSec(kod) {
  const tanim = DILLER.find((d) => d.kod === kod) || DILLER[0];
  try {
    durum.sozluk = await dilYukle(kod);
  } catch {
    durum.sozluk = durum.yedekSozluk;
  }
  durum.dil = kod;
  document.documentElement.lang = kod;
  document.documentElement.dir = tanim.yon;
  localStorage.setItem('recai-dil', kod);
  metinleriUygula();
  dilSeridi();
  ciz();
}

function metinleriUygula() {
  for (const dugum of document.querySelectorAll('[data-i18n]')) {
    dugum.textContent = t(dugum.dataset.i18n);
  }
  $('#tema-toggle').textContent = durum.tema === 'koyu' ? t('tema') : t('temaKoyu');
  guardNotu();
}

function dilSeridi() {
  const serit = $('#lang-strip');
  serit.replaceChildren();
  for (const d of DILLER) {
    serit.append(el('button', {
      text: d.kod,
      'aria-pressed': durum.dil === d.kod ? 'true' : 'false',
      onclick: () => void dilSec(d.kod),
    }));
  }
}

/* ---------- tema + guard ---------- */

function temaSec(tema) {
  durum.tema = tema;
  document.documentElement.dataset.tema = tema;
  localStorage.setItem('recai-tema', tema);
  $('#tema-toggle').textContent = tema === 'koyu' ? t('tema') : (t('temaKoyu'));
}

function guardNotu() {
  const acik = Boolean(durum.guard?.autoGuard);
  $('#guard-note').textContent = acik ? t('guardAcik') : t('guardKapali');
  $('#guard-toggle').setAttribute('aria-checked', acik ? 'true' : 'false');
}

async function guardDegistir() {
  const yeni = !durum.guard?.autoGuard;
  if (yeni && !window.confirm(t('guardOnay'))) return;
  try {
    const govde = await api('/api/guard', { method: 'POST', body: JSON.stringify({ autoGuard: yeni, autoObservationSeconds: 60 }) });
    durum.guard = govde.guard;
    guardNotu();
  } catch (hata) {
    toast(hata.message);
  }
}

/* ---------- veri ---------- */

function stateAl(s) {
  if (!s) return;
  if (Array.isArray(s.history)) seriTohumla(s.history);
  durum.state = s;
  seriEkle(s);
}

async function ilkYukleme() {
  try {
    const govde = await api('/api/state');
    stateAl(govde.state);
    durum.guard = govde.guard;
    durum.audit = govde.audit;
    durum.ai = govde.ai;
    durum.baglanti = 'canli';
  } catch {
    durum.baglanti = 'kapali';
  }
  guardNotu();
  ciz();
  // Kanit defteri ilk boyamayi bekletmez: geldiginde kendi ekranini tazeler.
  void olaylariYukle();
}

let akis = null;
let yedekZamanlayici = null;

function akisBagla() {
  akis?.close();
  akis = new EventSource('/api/stream');
  akis.addEventListener('ready', () => { durum.baglanti = 'canli'; durumCubugu(); });
  akis.addEventListener('snapshot', (olay) => {
    durum.baglanti = 'canli';
    stateAl(JSON.parse(olay.data));
    ciz();
  });
  akis.onopen = () => {
    durum.baglanti = 'canli';
    clearInterval(yedekZamanlayici);
    yedekZamanlayici = null;
  };
  akis.onerror = () => {
    durum.baglanti = 'kapali';
    durumCubugu();
    clearInterval(yedekZamanlayici);
    yedekZamanlayici = setInterval(() => void ilkYukleme(), 10_000);
  };
}

/* ---------- baslangic ---------- */

document.addEventListener('click', (olay) => {
  const ray = olay.target.closest('.rail-item[data-goto]');
  if (ray) ekranSec(ray.dataset.goto);
});

$('#tema-toggle').addEventListener('click', () => {
  temaSec(durum.tema === 'koyu' ? 'acik' : 'koyu');
});
$('#guard-toggle').addEventListener('click', () => void guardDegistir());
$('#iban-copy').addEventListener('click', () => toast('IBAN kopyalama henüz bağlı değil.'));
// Pencere dugmeleri yalnizca masaustu kabugunda anlamli; tarayicida
// Tauri API'si yoktur ve kullaniciya neden calismadigi soylenir.
function pencere() {
  return window.__TAURI__?.window?.getCurrentWindow?.() ?? null;
}
const pencereEylemleri = [
  ['#win-min', (p) => p.minimize()],
  ['#win-max', (p) => p.toggleMaximize()],
  ['#win-close', (p) => p.close()],
];
for (const [secici, eylem] of pencereEylemleri) {
  $(secici).addEventListener('click', () => {
    const p = pencere();
    if (!p) { toast(t('pencereNot')); return; }
    Promise.resolve(eylem(p)).catch((hata) => toast(String(hata.message || hata)));
  });
}

window.addEventListener('hashchange', () => ekranSec(location.hash.slice(1)));

const acilisEkrani = location.hash.slice(1);
if (EKRANLAR[acilisEkrani]) durum.ekran = acilisEkrani;

durum.yedekSozluk = await dilYukle('en').catch(() => ({}));

// ?dil= ve ?tema= derin baglanti icin: kayitli tercihi gecersiz kilar.
const sorgu = new URLSearchParams(location.search);
const sorguTema = sorgu.get('tema');
const sorguDil = sorgu.get('dil');

temaSec(sorguTema === 'acik' || sorguTema === 'koyu'
  ? sorguTema
  : localStorage.getItem('recai-tema') === 'acik' ? 'acik' : 'koyu');
await dilSec(DILLER.some((d) => d.kod === sorguDil) ? sorguDil : localStorage.getItem('recai-dil') || 'tr');
await ilkYukleme();
akisBagla();
setInterval(() => { if (durum.state) $('#sheet-time').textContent = saat(new Date(), true); }, 1000);
