<a href="LICENSE"><img align="right" src="docs/media/license-mark.png" width="210" alt="MIT Lisansı"></a>

# CCA-RECAI

*[🇬🇧 English](README.md) · 🇹🇷 Türkçe*

![Kod: MIT](https://img.shields.io/badge/kod-MIT-3fb950)
![Platform: Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%2F11-1f6feb)
![Durum: çalışıyor](https://img.shields.io/badge/durum-%C3%A7al%C4%B1%C5%9F%C4%B1yor-1f6feb)
![Yapıldığı araçlar: Node + Tauri](https://img.shields.io/badge/yap%C4%B1m-Node%20%2B%20Tauri-6e7681)

<p align="center">
  <img src="docs/media/screen-app-window.png" width="820" alt="Windows 11 üzerinde çalışan CCA-RECAI masaüstü penceresi">
</p>

> **Bu depodaki kod MIT Lisansı ile açık kaynaktır.**

Windows için tahmin yürütmeyi reddeden bir yerel sağlık izleyicisi. Üç saniyede
bir CPU, RAM, disk ve sıcaklığı ölçer; gördüğünü düz JSONL dosyalarına yazar ve
her hükmün arkasındaki kanıtı gösterir. Tamamen `127.0.0.1` üzerinde çalışır —
bulut yok, telemetri yok, hesap yok, ücretli paket yok.

Her özelliğin altındaki kural aynı: **kanıt olmadan eylem yok.** Sensör
okunamıyorsa satır boş kalır, sayı uydurulmaz. Bir proses kapatma adayıysa
hiçbir şey olmadan önce nedenini görürsün. Bir klasör temizlenebiliyorsa yolunu,
boyutunu ve risk sınıfını görürsün — ve sen demeden hiçbir şey silinmez.

Bu iş kişisel bir sinir bozukluğu olarak başladı: makine yavaşladı, Görev
Yöneticisi bir duvar dolusu aynı `node.exe` satırı gösterdi ve hangisinin önemli
olduğunu hiçbir şey açıklamadı. İlk sürüm bir tarayıcı sekmesiydi; o yazılım
değildi, bu yüzden gerçek bir masaüstü uygulamasına dönüştü. Yol boyunca üç
arayüz yeniden inşası, yalnızca uygulama kendini başlattığında ortaya çıkan bir
Windows yol hatası ve her rengi sessizce yutan bir güvenlik politikası yaşandı.
Bunlar unutulmak yerine `docs/` altına yazıldı. Gerçekten kullanılıyor ve
katkıya açık — eşikler, kurallar ve temizlik allowlist'i tartışılmak için var.

> **Yazarlar / Bağlam**
> **Creative Computational Architecture — Caglar Celik Architects (CCA)**, 2026.
> Claude (Anthropic) ve Codex ile eşli geliştirildi; arayüz Claude Design'da
> tasarlandı ve elle sade JavaScript ile yeniden yazıldı.
> *Redefining space through computation.* Analiz, matematik, sanat, geometri,
> felsefe, estetik, mimarlık ve teknoloji arasında çalışan bir tasarım praksis
> stüdyosu.
> 📷 [@caglarcelikarchitects](https://instagram.com/caglarcelikarchitects) · [caglarcelik.works](https://caglarcelik.works)

---

## Nasıl çalışır

Bir Rust kabuğu Node arka ucunu taşır. Kabuk boş bir port seçer, arka ucu alt
süreç olarak başlatır, kabuktan uzun yaşayamasın diye bir Windows Job Object'e
bağlar, portu bekler ve webview'ı yerel sayfaya yönlendirir. Aynı arka uç
`npm start` ile tek başına da çalışır.

```
   ölç                   kanıt                    karar               temizle
 ───────                ────────                 ──────               ───────
 monitor.js  ──────►    rules.js    ──────►      app.js     ──────►   audit.js
 3 sn ölçüm             eşikler                  ekran                yalnız
 systeminformation      + kural kimliği          + senin tıkın        allowlist
 PowerShell sensör      store.js → JSONL
```

Her uyarı bir kural kimliği taşır (`K-CPU-90`, `K-DSK-95`, `K-ISI-82`,
`K-PRC-01`) ve `events-YYYY-MM-DD.jsonl` dosyasına satır olarak düşer. Ekrandaki
sayı ile diskteki satır aynı olgudur.

## Altı ekran

Arayüz sabit bir masa-ve-kâğıt düzenidir: çerçeve geride durur, sayfa çalışma
yüzeyidir. Renk anlamı tek başına taşımaz — her durum kelimeyle de adlandırılır
ve palet mavi → turuncu → kırmızı gider, renk körlüğünde de okunur.

| Nabız — makineyi tek bakışta oku | Proses — eylemden önce kanıt |
|---|---|
| ![Dört vital satırı, eşik bantlı beş dakikalık grafik ve triyaj kolonu](docs/media/screen-nabiz.png) | ![Güven seviyesine göre gruplanmış kapatma adayları, her satırda neden listede olduğu](docs/media/screen-proses.png) |
| Dört vital, her biri kendi severity renkli grafiği ve eşik çizgisiyle, canlı beş dakikalık nabzın üstünde. Triyaj kolonu her aşımı bir kural kimliğine ve ne yapılacağını söyleyen düz bir cümleye çevirir. | Adaylar güven seviyesine göre gruplu, onları listeye sokan neden rozetleriyle. `eski kopyaları seç` her kopya grubunun en yenisini korur. Windows çekirdek prosesleri listeye hiç girmez. |

| Temizlik — sensiz hiçbir şey gitmez | Log — her sayı bir dosyaya iner |
|---|---|
| ![Gruplu önbellek adayları, boyut ve risk sınıfı, silinmeyecekler listesi](docs/media/screen-temizlik.png) | ![Kural kimlikleri, severity filtresi ve kaynak JSONL dosyasıyla kanıt defteri](docs/media/screen-log.png) |
| Önbellek ve geçici dosya adayları ölçülüp gruplanır, her biri boyutu ve risk sınıfıyla. İnceleme sınıfı ikinci bir onay ister. Sağ kolon neye hiç dokunulmadığını sayar. | Kanıt defteri. Severity'ye göre filtrele, kural kimliğini oku, ham raporu aç. Kaynak JSONL dosya adı ekranda — iddia denetlenebilir. |

| Sensör — veri yokken dürüst | Lisans · kaynak — baştan açık |
|---|---|
| ![Sıcaklık tablosu, 82 °C uyarı ve 90 °C kritik işaretleri, kaynak zinciri](docs/media/screen-sensor.png) | ![MIT banneri, kaynak bağlantıları ve AI anahtar sınırı](docs/media/screen-lisans.png) |
| Windows birçok masaüstünde CPU sıcaklığını sunmaz. RECAI üç kaynağı sırayla okur; üçü de başarısız olursa hattı boş bırakır ve hangi adımın düştüğünü söyler. Asla değer uydurmaz. | Ne aldığın ve AI anahtarının nerede durduğu. Anahtar depoya, `.env` dosyasına ve loglara yazılmaz. |

Uygulama sekiz dille gelir (`tr en de fr ru bg ar zh`, Arapça sağdan sola) ve iki
tema da birinci sınıftır:

<p align="center">
  <img src="docs/media/screen-light.png" width="720" alt="Açık temada nabız ekranı">
</p>

## Kurulum

Windows 10/11, x64. İki paket de imzasızdır, SmartScreen ilk açılışta uyarır.

- **Taşınabilir** — aç, `cca-recai.exe` dosyasına çift tıkla. Üç öğe
  (`cca-recai.exe`, `recai-node.exe`, `app/`) birlikte durmalıdır.
- **Installer** — `CCA-RECAI_x64-setup.exe`, yalnız geçerli kullanıcıya kurar.

Pencereyi kapatmak tepsiye küçültür, izleme sürer. Çıkış tepsi menüsündedir.
Kayıtlar: `%APPDATA%\works.caglarcelik.recai\data`

## Kaynaktan derleme

Node.js ≥ 22 ve Rust ≥ 1.77.

```bash
npm install
npm start          # arka uç + tarayıcı arayüzü: http://127.0.0.1:7331
npm run app        # masaüstü penceresi (Tauri dev)
npm run app:build  # installer + sürüm ikilileri
node scripts/make-portable.mjs   # dist/ altına taşınabilir klasör
```

`npm run app:build`, çalıştırdığın Node ikilisini masaüstü sidecar'ı olarak
`src-tauri/binaries/` altına kopyalar; böylece derlenen uygulama kendi çalışma
zamanını taşır ve sistemde kurulu Node'a bağımlı olmaz.

## Güvenlik modeli

| Sınır | Garanti |
|---|---|
| Ağ | Yalnız `127.0.0.1` dinler. Yabancı `Host` başlığı reddedilir (DNS rebinding kalkanı); değiştiren istekler yerel `Origin` ister. |
| Prosesler | Kapatmadan önce PID beklenen proses adına karşı yeniden doğrulanır. Windows çekirdek prosesleri aday olarak hiç görünmez. |
| Temizlik | Yalnız `audit.js` içindeki sabit allowlist, silme anında yeniden doğrulanır. Kök dizinler, kullanıcı profili ve Windows klasörü reddedilir. Sembolik bağlantılar izlenmez. |
| Arka uç ömrü | Windows Job Object'e bağlıdır (`KILL_ON_JOB_CLOSE`) — kabuk zorla kapatılsa bile ondan uzun yaşayamaz. |
| AI | Tıklama başına isteğe bağlı, salt-okunur kum havuzu, senin kendi hesabın. Yalnız özet metrik alır — dosya yolu ya da log gövdesi almaz. Bu uygulamada API anahtarı bulunmaz. |
| Gizlilik | Telemetri yok, otomatik güncelleme yok, dışarı çağrı yok. Ev dizinleri ekranda `~` ile kısaltılır; ekran görüntüsü kullanıcı adı sızdırmaz. |

## Kurallar ve eşikler

Eşikler `src/rules.js` içinde yaşar ve arayüzde birebir yansıtılır. Ayrışırlarsa
arayüz yalan söyler; bu yüzden birlikte değiştirilmek üzere tasarlandılar.

| Ölçüm | Uyarı | Kritik |
|---|---:|---:|
| CPU yükü | 80 | 90 |
| RAM kullanımı | 82 | 92 |
| Disk doluluğu | 90 | 95 (ya da boş < 15 GB) |
| Sıcaklık | 82 °C | 90 °C |

Bir proses yedi nedenden biriyle aday olur: eski test koşucusu, birikmiş kopya
köprü, yüksek CPU, kendi öğrenilmiş ortalamasına karşı sıçrama, yüksek RAM,
yetim yük, ya da çok sayıda aynı kopya.

## Dosyalar

| Yol | İçerik |
|---|---|
| `src/monitor.js` | 3 saniyelik ölçüm döngüsü, anlık görüntü, Windows olayları |
| `src/rules.js` | Eşikler, kural kimlikleri, aday tespiti, sağlık skoru |
| `src/audit.js` | Depolama taraması ve temizlik allowlist'i |
| `src/windows.js` | PowerShell köprüsü: sensör, olay günlüğü, kapatma |
| `src/store.js` | JSONL kanıt yazıcısı |
| `public/` | Arayüz: kabuk, ekranlar, sekiz dil dosyası |
| `src-tauri/src/main.rs` | Masaüstü kabuğu: sidecar, tepsi, çerçevesiz pencere |
| `docs/` | Mimari karar kayıtları |

## Yol haritası

- ✅ ~~Tepsi ve tek-kopya destekli masaüstü kabuğu~~
- ✅ ~~Altı ekranlı arayüz, sekiz dil, iki tema~~
- ✅ ~~Kural kimlikli kanıt defteri~~
- Başlangıç girdileri ekranı (`{B}`) ve ayrı AI doktor ekranı (`{A}`)
- Sıcaklık API'si olmayan makineler için gömülü LibreHardwareMonitor okuması
- OFL fontların paketlenmesi; uygulama font CDN'ine hiç gitmesin
- İmzalı ikililer

Katkı beklenir — özellikle eşikler ve temizlik allowlist'i üzerine itiraz.

## Araçlar ve krediler

| Araç | Ne için |
|---|---|
| [Node.js](https://nodejs.org) | Arka uç çalışma zamanı, masaüstü sidecar'ı olarak paketlenir |
| [systeminformation](https://github.com/sebhildebrandt/systeminformation) | CPU, bellek, disk ve grafik metrikleri |
| [Tauri 2](https://tauri.app) | Masaüstü kabuğu, tepsi, installer |
| PowerShell / WMI | Sıcaklık sensörleri, Windows olay günlüğü, proses kontrolü |
| [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) | İsteğe bağlı sıcaklık kaynağı, kuruluysa çalışma anında okunur |
| Claude (Anthropic) · Codex | Eşli programlama ve arayüz yeniden inşası |
| Space Grotesk · JetBrains Mono | Tipografi |

## Lisans

<p align="left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/recai-wordmark-dark.svg">
    <img src="docs/media/recai-wordmark.svg" width="150" alt="RECAI">
  </picture>
</p>

Kod [MIT Lisansı](LICENSE) ile yayınlanmıştır. CCA ve RECAI işaretleri, wordmark
ve arayüz görselleri MIT kapsamında **değildir** ve yazarına aittir. Paketlenen
üçüncü taraf yazılımlar [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
dosyasında listelidir.

Copyright (c) 2026 Creative Computational Architecture — Caglar Celik Architects (CCA)
