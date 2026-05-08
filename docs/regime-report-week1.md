<!--
  Otomatik üretildi (launchd, 2026-05-02T19:11:00Z)
  Veri kalitesi notu: 2026-04-25 02:00-12:30 UTC arasinda Binance WS
  zombi tespit edildi (Risk #17). Bu pencerede yazilan rejim log'lari
  stale fiyatla hesaplanmis olabilir; analizden manuel haric tutulmali.
-->

# Regime Shadow Mode — Ara Rapor

**Donem**: 2026-04-26 → 2026-05-02 (7 gun, 2925 kayit)

## 1. Rejim Dagilimi (Piyasa basina)

### crypto (n=1391)
  - ranging: 100% (1391)

### forex (n=136)
  - ranging: 100% (136)

### bist (n=791)
  - ranging: 100% (791)

### commodities (n=162)
  - ranging: 100% (162)

### us_stocks (n=445)
  - ranging: 100% (445)

## 2. Histerezis False-flip Analizi

- **N=3 (mevcut)**: 845 transition, 699 false-flip → **82.72%**
- **N=4 simulasyonu**: 1010 transition'in 0'i baska bir bar gerektirirdi → 0% bastirma

> ⚠️ False-flip > %10 → taxonomy kuralina gore N artirma adayi (N=4 simulasyonu deger katiyorsa).

### Ornek false-flip'ler:
  - BTCUSD|60: ranging → ranging (1 bar) → ranging @ 2026-04-26T00:26:52.895Z
  - BTCUSD|60: ranging → ranging (1 bar) → ranging @ 2026-04-26T10:35:14.074Z
  - BTCUSD|60: ranging → ranging (1 bar) → ranging @ 2026-04-26T11:17:20.171Z
  - BTCUSD|60: ranging → ranging (1 bar) → ranging @ 2026-04-26T11:40:37.063Z
  - BTCUSD|60: ranging → ranging (1 bar) → ranging @ 2026-04-26T14:17:09.559Z

## 3. Rate-limit (Unstable sembol-gun)

- **0** sembol-gun cifti rate-limit'e takildi (>4 gecis)

## 4. Chaos Suresi (Gercek vs Tahmin)

- Bu donemde chaos rejimine girilmedi (ya da log donemi henuz cok kisa).

## 5. BIST `bist_tl_stable_domestic` Sıklığı

- BIST toplam kayit: 791
- `bist_tl_stable_domestic` tetik: 791 → **100%**

---
Uretildi: 2026-05-02T19:11:01.069Z
