# Rejim Taksonomisi — Multi-Market Otonom Sistem

Bu doküman, sistemin piyasa rejimi tespit mantığının **anayasasıdır**. Tüm
sinyal üretimi, strateji seçimi ve risk yönetimi bu taksonomiye referans
vererek çalışır.

- **Versiyon**: 1.0 (ilk kurulum)
- **Kapsam**: Kripto, ABD hisse, BIST, Emtia
- **Felsefe**: "Önce rejim → sonra strateji → sonra sinyal".
  Oylama asla rejimden önce koşmaz.
- **Eşikler**: Başlangıç değerleri literatürden ve mevcut sistemden tahmin.
  Shadow-mode 4 haftasından sonra canlı veriyle kalibre edilir.
- **Eşlik dokümanı**: `docs/risk-matrix.md`

---

## 1. Ortak rejim adları

Her piyasa aşağıdaki 6 rejimden birinde olmalı (exhaustive, mutually exclusive):

| Rejim | Kısa tanım |
|--|--|
| `trending_up` | Yukarı yönlü net trend, güçlü momentum, pullback entry uygun |
| `trending_down` | Aşağı yönlü net trend, short fırsatları, long dondurulmuş |
| `ranging` | Net support/resistance arası yatay hareket, mean-reversion uygun |
| `breakout_pending` | Düşük volatilite sıkışma; patlama beklenir, momentum entry hazırlığı |
| `high_vol_chaos` | Haber sonrası, gap, liquidation cascade — **sinyal üretme yok** |
| `low_vol_drift` | Sessiz seans/hafta-sonu benzeri düşük oynama — **sinyal üretme yok** |

Ek (session-bound piyasalar için): `market_closed` — sinyal/pozisyon yok.

### Histerezis kuralı (tüm rejimler, tüm piyasalar)

- Rejim değişikliği **N=3 ardışık bar** aynı rejimi işaret etmeden
  gerçekleşmez.
- Rejim geçişi sırasında (3 bar doğrulama dönemi) **yeni pozisyon açılmaz**;
  mevcut pozisyonlar devam eder.
- Maksimum 4 rejim değişimi / gün / sembol; üstündeyse sembol "unstable" log'u
  ile işaretlenir, o gün o sembolde sinyal kesilir.

---

## 2. Kripto

**Karakteristik**: 24/7, BTC dominance + likidite olayları + funding rate
sinyalleri, altcoin'ler BTC'ye güçlü korele.

### Girdiler

| Girdi | Kaynak | Rol |
|--|--|--|
| ADX(14) | KhanSaab study | Trend gücü |
| ADX türevi (son 5 bar eğim) | Hesaplanmış | Trend yaşı |
| BB genişliği (20,2) / median(BBW, 50) | Hesaplanmış | Sıkışma ölçüsü |
| BTC.D (bitcoin dominance) | TradingView | Altcoin rejim etkisi |
| USDT.D | TradingView | Risk-off göstergesi |
| Funding rate (8h) | Exchange API | Aşırı kalabalık pozisyon sinyali |
| 24h return | OHLCV | Cascade tespiti |

### Eşikler

| Rejim | Koşul |
|--|--|
| `trending_up` | ADX > 25 AND ADX türevi ≥ 0 AND BB genişliği ≥ medyan AND fiyat 20EMA üstünde |
| `trending_down` | ADX > 25 AND ADX türevi ≥ 0 AND fiyat 20EMA altında |
| `ranging` | ADX < 20 AND BB genişliği 50-150% medyan arası AND fiyat son 50 bar içinde net H/L aralığında |
| `breakout_pending` | ADX < 20 AND BB genişliği < %70 medyan (2+ bar) |
| `high_vol_chaos` | 24h \|return\| > 8% OR 1h \|return\| > 4% OR funding rate \|abs\| > 0.1% |
| `low_vol_drift` | Haftasonu (Cmt 00:00 UTC – Pzr 22:00 UTC) VE günlük range < %1.5 |

### Ek risk kuralları

- BTC rejimi `high_vol_chaos` ise **tüm kripto'da yeni sinyal kesilir**
  (alt-coin'ler BTC'yi takip eder, chaos yayılır).
- Funding rate abs > 0.1% (long side veya short side overcrowded) → o yönde
  yeni pozisyon yok.

---

## 3. ABD Hisse

**Karakteristik**: Session-bound (14:30-21:00 UTC regular), earnings cycles,
macro event sensitivity (FOMC/CPI/NFP), sector rotation.

### Girdiler

| Girdi | Kaynak | Rol |
|--|--|--|
| ADX(14) | KhanSaab study | Trend gücü |
| ADX türevi | Hesaplanmış | Trend yaşı |
| BB genişliği / median | Hesaplanmış | Sıkışma |
| VIX | Makro | Risk iştahı / chaos filtresi |
| SPY beta (rolling 60d) | Hesaplanmış | Sektör/market etkisi |
| Sektör relative strength | Sector ETF vs SPY | Sektör rotasyonu |
| Earnings takvimi | Ekonomik takvim | Chaos penceresi |
| Pre-market / After-hours bayrağı | Saat | Düşük likidite dönemleri |

### Eşikler

| Rejim | Koşul |
|--|--|
| `trending_up` | ADX > 22 AND fiyat 20EMA üstünde AND VIX < 25 AND sektör RS ≥ 0 |
| `trending_down` | ADX > 22 AND fiyat 20EMA altında AND VIX < 30 (VIX ≥ 30 → chaos) |
| `ranging` | ADX < 18 AND BB genişliği 50-150% medyan AND VIX < 20 |
| `breakout_pending` | ADX < 18 AND BB genişliği < %70 medyan |
| `high_vol_chaos` | VIX > 30 OR gap open > 2% OR earnings ±24h OR FOMC/CPI/NFP ±chaos-window |
| `low_vol_drift` | Pre-market / After-hours OR VIX < 12 OR tatil öncesi yarım gün |
| `market_closed` | Session dışı, tatil, holiday |

### Ek risk kuralları

- VIX > 35 → tüm ABD hisse'de yeni sinyal kesilir.
- Sektör RS < -2σ → o sektör sembolleri halt.
- Earnings ±4h içinde pozisyon kapatılır (chaos öncesi hedge).

---

## 4. BIST

**Karakteristik**: Session-bound (07:00-15:00 UTC), TL volatilitesi ana
sürücü, düşük derinlik, siyasi/makro şok hassasiyeti, circuit breakers
(tavan-taban).

### Girdiler

| Girdi | Kaynak | Rol |
|--|--|--|
| ADX(14) | KhanSaab study | Trend gücü |
| ADX türevi | Hesaplanmış | Trend yaşı |
| BB genişliği / median | Hesaplanmış | Sıkışma |
| USDTRY 5-gün realized vol (σ) | OHLCV | TL stres göstergesi |
| Korelasyon (USDTRY 5d return, BIST100 5d return) | Hesaplanmış | **Asıl rejim ayıraç** |
| BIST100 trend göstergesi | XU100 OHLCV | Endeks rejimi |
| TCMB faiz kararı takvimi | Ekonomik takvim | Chaos penceresi |

### BIST-spesifik rejim ayıraç: USDTRY × BIST korelasyonu

BIST'te TL oynaması tek başına anlamsızdır; **asıl ayrım korelasyonun işareti
ve mutlak değeridir**.

| Alt-rejim (BIST'e özel) | USDTRY σ | ρ(USDTRY, BIST) | Anlam | Strateji |
|--|--|--|--|--|
| `bist_normal_coupled` | < %2 | +0.4 ile +0.8 | TL hafif değer kaybı → hisse nominal yükseliş | Standart trend/pullback |
| `bist_decoupled_stress` | > %2 | ρ < +0.2 VEYA negatif | Panik, yabancı çıkışı, ikisi birlikte düşer | **Long sinyal dondurulur**, sadece short veya halt |
| `bist_tl_stable_domestic` | < %0.5 (5 gün) | \|ρ\| < 0.3 | TL yatay, saf teknik/domestik hikaye | Standart teknik; rejim nadir — %10 altında tetikleniyorsa kaynak harcama |
| `bist_tl_spike_inflation` | > %3 | ρ > +0.7 | TL sert kayıp, BIST nominal patlama | Hızlı trend, TP agresif, **nominal vs gerçek getiri uyarısı** |

Bu alt-rejimler, ortak 6 rejim adıyla şu şekilde eşlenir:

| BIST alt-rejim | Ortak rejim adı |
|--|--|
| `bist_normal_coupled` + (ADX>22 up) | `trending_up` |
| `bist_normal_coupled` + (ADX>22 down) | `trending_down` |
| `bist_decoupled_stress` | `high_vol_chaos` (ek: long özel red) |
| `bist_tl_stable_domestic` + (ADX<18) | `ranging` |
| `bist_tl_spike_inflation` + (ADX>22 up) | `trending_up` (nominal) |

### Ek risk kuralları

- USDTRY 1-günlük > %4 hareket → tüm BIST halt (TCMB müdahalesi çoğu zaman
  eşlik eder).
- XU100 endeksi `high_vol_chaos` ise tekil hisselerde de chaos kabul edilir.
- Tavan-taban'a yakın (%1) fiyatlarda pozisyon açılmaz (slippage riski).
- TCMB faiz kararı ±4 saat → halt.

### Nadir rejim notu

`bist_tl_stable_domestic` tarihsel olarak BIST'te nadir (2018-2026
tahminen %5-10). Shadow mode 4 haftasında tetiklenme sıklığı ölçülür. %10
altındaysa bu rejim için özel strateji geliştirilmez, sadece `ranging` genel
stratejisi yeterli olur. Kaynak önceliği `coupled` ve `stress` rejimlerindedir.

---

## 5. Emtia

**Karakteristik**: Tek bir sınıf değil — altın, petrol, doğalgaz, tarım,
endüstriyel metaller ayrı sürücülerle hareket eder. Her alt-sınıf için ayrı
profile dosyası.

### 5.1 Kıymetli metal (XAUUSD, XAGUSD)

| Girdi | Rol |
|--|--|
| ADX(14), türev, BB genişliği | Teknik rejim |
| DXY (USD endeksi) | Ters korelasyon |
| US10Y reel faiz | Ana sürücü (altın düşman: yüksek reel faiz) |
| VIX | Risk-off flight (altın sığınak) |
| ETF akışı (GLD) | Positioning |

**Özel rejim**: `risk_off_flight` — VIX > 25 AND DXY düşüyor birlikte → altın
trending_up tetiklenir. Bu `trending_up`'a eşlenir ama gerekçesi farklı
(teknikten ziyade flight-to-safety).

### 5.2 Enerji / Petrol (USOIL, UKOIL)

| Girdi | Rol |
|--|--|
| ADX(14), türev, BB genişliği | Teknik rejim |
| EIA envanter takvimi | Haftalık shock |
| OPEC toplantı takvimi | Supply shock penceresi |
| Jeopolitik haber akışı | Chaos tetikleyici |
| DXY | İkincil (USD ters) |

**Özel rejim**: `supply_shock` — envanter > 2σ sapma veya OPEC haber →
`high_vol_chaos` (12-24 saat halt).

### 5.3 Doğalgaz (NATGAS)

| Girdi | Rol |
|--|--|
| ADX, BB | Teknik rejim |
| Depolama seviyesi (EIA, %normal) | Ana sürücü |
| HDD (heating degree days) forecast | Kış talep göstergesi |
| Mevsim (Ekim-Mart vs Nis-Eyl) | Premium dönemi |

**Özel rejim**: `winter_premium` — Ekim-Mart + depolama < %normal → yükseliş
baskısı (trending_up bias, short dondur).

### 5.4 Tarım (ZW buğday, ZC mısır, ZS soya)

| Girdi | Rol |
|--|--|
| ADX, BB | Teknik rejim |
| Hava tahmini (anahtar bölgeler) | Hasat riski |
| USDA WASDE raporu (aylık) | Chaos penceresi |
| Mevsim (ekim, hasat) | Döngüsel bias |

**Özel rejim**: `harvest_cycle` — hasat penceresinde yüksek oynama, chaos
eğilimi.

### 5.5 Endüstriyel metal (XCUUSD bakır)

| Girdi | Rol |
|--|--|
| ADX, BB | Teknik rejim |
| Çin PMI (aylık) | Ana talep göstergesi |
| LME stok seviyesi | Arz baskısı |
| DXY | İkincil |

**Özel kural**: Çin PMI < 50 → `trending_up` dondurulur, `ranging` / `trending_down` normal.

---

## 6. Session-bazlı portföy risk bütçesi

Otonom sistem aynı anda tüm piyasalarda sinyal üretebilir. **Saat dilimine
göre toplam portföy riski kapaklanır** — amaç tek bir zaman diliminde
(özellikle gece sadece kripto açıkken) portföyün tek bir piyasaya yığılmasını
engellemektir.

| Saat (UTC) | Açık piyasalar | Toplam açık risk kapağı (% equity) | Yeni pozisyon limiti (yeni/saat) |
|--|--|--|--|
| 00:00 - 06:00 | Kripto + Asya | **%3** | 2 |
| 06:00 - 08:30 | + Londra forex | **%5** | 3 |
| 08:30 - 13:30 | + BIST + Avrupa | **%7** | 4 |
| 13:30 - 20:00 | Full (ABD dahil) | **%10** | 5 |
| 20:00 - 24:00 | Kripto + ABD sonrası | **%5** | 3 |

### Ek kurallar

- Hafta sonu (Cmt 00:00 - Pzr 22:00 UTC): sadece kripto açık, kapak **%3**,
  yeni pozisyon limiti 1/saat.
- Pazartesi açılış +2 saat (ABD pre-market): kapak **%4** (gap open riski).
- Tüm piyasalar `high_vol_chaos` toplu ise (küresel risk-off): kapak
  mevcut değerin yarısı.

Rakamlar başlangıç değerleridir; 4 hafta paper sonucu değerlendirilir.

---

## 7. Chaos pencereleri (declarative config)

Sistem aşağıdaki olaylarda otomatik chaos moduna geçer. Pencereler
`config/chaos-windows.json` dosyasında tutulur, kod kalibrasyonsuz değişiklik
yapabilir.

```json
{
  "crypto_liquidation_cascade": { "min_minutes": 30, "typical": 90, "max": 1440 },
  "us_fomc":       { "start_offset_min": 0,   "duration_min": 120 },
  "us_nfp":        { "start_offset_min": 0,   "duration_min": 60 },
  "us_cpi":        { "start_offset_min": 0,   "duration_min": 90 },
  "us_ppi":        { "start_offset_min": 0,   "duration_min": 60 },
  "us_earnings":   { "start_offset_min": -15, "duration_min": 240 },
  "bist_open_gap": { "start_offset_min": 0,   "duration_min": 15 },
  "tcmb_rate":     { "start_offset_min": -30, "duration_min": 240 },
  "opec_meeting":  { "start_offset_min": 0,   "duration_min": 240 },
  "eia_release":   { "start_offset_min": 0,   "duration_min": 60 },
  "usda_wasde":    { "start_offset_min": 0,   "duration_min": 120 },
  "china_pmi":     { "start_offset_min": 0,   "duration_min": 120 }
}
```

- `start_offset_min`: olay başlangıcına göre chaos penceresi başlangıcı
  (negatif = olaydan önce başlar).
- `duration_min`: chaos süresinin başlangıç tahmini.
- Canlı veriden her 4 haftada bir kalibrasyon: gerçek volatility decay > `duration_min` ise
  süre uzat.

---

## 8. `computeRegime()` modülü — arayüz sözleşmesi

Sistem genelinde tek bir giriş noktası:

```js
computeRegime({
  symbol,          // "BTCUSDT", "AAPL", "GARAN", "XAUUSD"
  marketType,      // "crypto" | "us_stocks" | "bist" | "commodities"
  subClass,        // emtia için: "metals" | "energy" | "natgas" | "agri" | "industrial"
  ohlcv,           // son 100 bar
  studyValues,     // KhanSaab vs
  macro,           // { vix, dxy, btc_d, usdt_d, usdtry, us10y, ... }
  chaosWindows,    // config/chaos-windows.json yüklü
  now,             // UTC ms
})
```

**Çıktı**:

```js
{
  regime: "trending_up",          // ortak 6 rejimden biri
  subRegime: "bist_normal_coupled", // piyasa-özel alt rejim (varsa)
  confidence: 0.78,               // 0-1, histerezis tamamlandığı ölçüde artar
  since: 1735065600000,           // bu rejime ne zaman girildi (UTC ms)
  stableBars: 7,                  // N bar boyunca aynı rejim
  notes: ["adx=28 rising", "vix=18"], // debug için
  strategyHint: "pullback_entry", // strateji seçicisine ipucu
  newPositionAllowed: true,       // histerezis içinde mi?
  riskCapPct: 7.0,                // session + rejim kombinesi
}
```

### Kullanım akışı

```
computeRegime()
  └─ regime output
      └─ strategy-selector(regime)
          └─ signal pipeline (oylama)
              └─ risk-manager(position_size, correlation, session_budget)
                  └─ trade execution (otonom mod)
```

Oylama sistemi asla `computeRegime()`'den önce çalışmaz.

---

## 9. Shadow mode & kalibrasyon planı

Rejim modülü canlı stratejiye bağlanmadan önce **4 hafta shadow mode**:

- Her bar için rejim teşhisi yap, logla, **sinyal üretme**.
- Günlük metrikler:
  - Rejim dağılımı (% zaman her rejimde)
  - Rejim geçiş sayısı (gün/sembol)
  - False-flip oranı (N=3 histerezis içinde geri dönen geçişler)
  - BIST için `bist_tl_stable_domestic` frekansı
- 4 hafta sonunda:
  - Eşikleri kalibre et (ADX bands, BB genişlik percentiles vs)
  - Histerezis N'i revize et (false-flip > 10% ise N artır)
  - Nadir rejimleri (frekans < 5%) özel stratejiden çıkar, genel rejim
    eşleştirmesine bırak

---

## 10. Güncelleme kaydı

| Tarih | Versiyon | Değişiklik | Yapan |
|--|--|--|--|
| 2026-04-24 | 1.0 | İlk kurulum — 6 ortak rejim, 4 piyasa, 5 emtia alt-sınıfı, BIST USDTRY korelasyon modeli, session bütçesi, chaos pencereleri | İnsan + Claude + DeepSeek review |

---

## Referanslar

- `docs/risk-matrix.md` — risk haritası
- `config/chaos-windows.json` — chaos pencereleri (Faz 1'de üretilecek)
- `config/session-budget.json` — session risk kapakları (Faz 1'de üretilecek)
- Faz 0 patch'leri tamamlandıktan sonra bu doküman `computeRegime()`
  implementasyonunun spec'i olur.
