# Reconciliation Schema — `open.json`

Risk Matrisi Risk #2 (**Broker state desync**) azaltmasının veri modeli.
Faz 0 Day 1'de eklendi. Periyodik reconciliation job bu alanlar üzerinden
`trade_id ↔ broker_order_id` eşlemesi yapar ve mismatch olduğunda halt +
alarm tetikler.

- **Versiyon**: 1.1 (2026-04-25) — monotonic timestamp, partial fills, currentStage, source alanları eklendi
- **Kapsam**: `scanner/data/signals/open.json` → `signals[]` kayıtları
- **Migration**: `scanner/scripts/migrate-reconciliation.mjs` (idempotent)
- **API**: `signal-tracker.js` → `attachBrokerOrder()`, `updateReconciliationState()`

---

## Şema

Her açık sinyal kaydına eklenen alanlar:

```jsonc
{
  // ... mevcut alanlar (id, symbol, direction, entry, sl, tp1, ...) ...

  // Tek bir sinyal birden çok venue'ya dispatch edilirse primary venue burada.
  "brokerVenue": "okx" | "binance" | "bybit" | null,

  // Bu sinyale bağlı tüm broker emirleri. idempotent — (venue, orderId) unique.
  "brokerOrderIds": [
    {
      "venue": "okx",
      "orderId": "1234567890",
      "kind": "entry",          // 'entry' | 'sl' | 'tp1' | 'tp2' | 'tp3' | 'reduce' | 'close'
      "side": "buy" | "sell",
      "type": "limit" | "market" | "stop" | "oco" | null,
      "price": 2318.33,
      "qty": 0.5,
      "status": "submitted" | "live" | "filled" | "canceled" | "rejected" | "unknown",
      "source": "api" | "manual" | "unknown",   // D: manuel müdahale ayıracı
      "submittedAt": "2026-04-24T12:34:56.000Z",
      "updatedAt":   "2026-04-24T12:35:10.000Z",
      "monotonicSeq": 3,                          // A: saat drift'ten bağımsız sıralama
      "fills": [                                   // B: partial fill detayı
        { "qty": 0.3, "price": 2318.5, "at": "2026-04-24T12:35:00.000Z" },
        { "qty": 0.2, "price": 2319.0, "at": "2026-04-24T12:35:05.000Z" }
      ],
      "filledQty": 0.5,       // aggregate (fills'ten hesaplanır)
      "avgFillPrice": 2318.7, // aggregate (weighted)
      "raw": { /* broker response passthrough, debug amaçlı */ }
    }
  ],

  // Reconciliation job'ın state'i.
  "reconciliationState": {
    "state": "unknown" | "in_sync" | "desync_detected" | "halted",
    "lastCheckedAt": "2026-04-24T12:35:00.000Z" | null,
    "desyncCount": 0,
    "lastMismatch": null | {
      "at": "2026-04-24T12:35:00.000Z",
      "reason": "broker_flat_but_system_open" | "broker_open_but_system_flat" | "size_mismatch" | "sl_missing" | ...,
      "detail": "brokerPos=0 expectedPos=0.5"
    },
    "expectedPosition": null | { "side": "long"|"short", "qty": 0.5, "entry": 2318.33, "sl": 2340.0 },
    "brokerPosition":   null | { "side": "long"|"short", "qty": 0.5, "avgPrice": 2318.5 },
    "haltedAt": null | "ISO timestamp",
    "haltReason": null | "3_desync_in_10min" | "broker_api_error_5min" | ...,

    // C: zincir asaması — broker ile sistem karşılaştırmasında ana eksen.
    "currentStage": "pending" | "entry" | "tp1" | "tp2" | "tp3" | "closed",
    // A: saat geriye alınırsa timestamp'e değil buna güven.
    "monotonicSeq": 7,
    "lastMonotonicTs": 1714000000123
  }
}
```

---

## Kurallar

1. **`id` == `trade_id`**: Mevcut `sig_<SYM>_<TF>_<ts>` id'si broker eşlemesinde
   trade_id rolünü oynar. Ayrı bir alan yok — tek kaynak doğruluk.
2. **`(venue, orderId)` unique**: `attachBrokerOrder()` aynı eşleşmeyle ikinci
   kez çağrılırsa mevcut kaydı günceller (status/filledQty), yeni satır eklemez.
3. **`submittedAt` korunur**: Güncelleme sırasında ilk kayıt tarihi ezilmez.
4. **Reconciliation frekansı**: 1 dk'da bir çalışır (Faz 2'de implement).
5. **Desync eskalasyonu**:
   - 1 desync → `state='desync_detected'`, warn log
   - 10 dk içinde ≥3 desync → `state='halted'`, tüm yeni sinyal red + alarm
   - 5 dk API yanıtsız → `state='halted'`, haltReason='broker_api_error_5min'
6. **Halt kaldırma**: Manuel (operator) veya reconciliation job in_sync
   doğrulayınca `state='in_sync'` + `haltedAt=null`.
7. **Monotonic timestamp (A)**: `attachBrokerOrder` ve `updateReconciliationState`
   her çağrıda `Date.now() < lastMonotonicTs` kontrolü yapar. Geri giderse
   `CLOCK_DRIFT` uyarısı `warnings[]`'e düşer, `monotonicSeq` yine de artar.
   Sıralama için her zaman `monotonicSeq` kullanılır, timestamp'e güvenilmez.
8. **Partial fills (B)**: `fills[]` array'ine her parça `{qty, price, at}` olarak
   append edilir, `(at, price, qty)` unique. `filledQty` ve `avgFillPrice` her
   güncellemede weighted avg ile yeniden hesaplanır.
9. **currentStage (C)**: `pending → entry → tp1 → tp2 → tp3` ileri geçiş;
   `closed`'a her aşamadan gidilebilir. Geriye gidiş (`tp2 → tp1`) log'a
   `STAGE_REGRESSION` olarak düşer ama bloklanmaz (broker senkron hatası olabilir).
10. **Manuel müdahale (D)**: `source='manual'` gelen emir `MANUAL_INTERVENTION`
    warning üretir — desync sayılmaz, `desyncCount` artmaz. Reconciliation job
    bu emirlerin sonrasında state'i broker'a göre yeniden kalibre eder.

---

## Mismatch Tipleri

| Kod | Anlam | Örnek |
|--|--|--|
| `broker_flat_but_system_open` | Sistem "açık pozisyon" der, broker'da pozisyon yok | SL vuruldu ama sistem tespit etmedi |
| `broker_open_but_system_flat` | Broker'da pozisyon var, sistem kapattı sanıyor | Kill switch eksik kaldı |
| `size_mismatch` | İki taraf açık ama qty farklı | Partial fill / manual trim |
| `sl_missing` | Broker'da SL emri yok | Emir reddedildi veya düştü |
| `tp_missing` | Broker'da TP emri yok | TP1 sonrası TP2 yerleşmedi |
| `opposite_position` | Broker pozisyonu ters yön | Reverse mekanizma hatası |

---

## API Örneği

```js
import { attachBrokerOrder, updateReconciliationState } from './scanner/lib/learning/signal-tracker.js';

// Executor emir gönderdi:
attachBrokerOrder('sig_ETHUSDC_60_1714000000', {
  venue: 'okx',
  orderId: '7689123456',
  kind: 'entry',
  side: 'sell',
  type: 'limit',
  price: 2318.33,
  qty: 0.5,
  status: 'submitted',
});

// Reconciliation job tick:
updateReconciliationState('sig_ETHUSDC_60_1714000000', {
  state: 'in_sync',
  expectedPosition: { side: 'short', qty: 0.5, entry: 2318.33, sl: 2340.0 },
  brokerPosition:   { side: 'short', qty: 0.5, avgPrice: 2318.5 },
});

// Desync tespit:
updateReconciliationState('sig_ETHUSDC_60_1714000000', {
  state: 'desync_detected',
  desyncIncrement: true,
  lastMismatch: {
    at: new Date().toISOString(),
    reason: 'sl_missing',
    detail: 'broker has entry but no stop-loss order',
  },
});

// Halt:
updateReconciliationState('sig_ETHUSDC_60_1714000000', {
  halt: { reason: '3_desync_in_10min' },
});
```

---

## Haftalık Drill

Risk matrisi doğrulama kolonu gereği:

1. Paper ortamında kasıtlı desync üret (broker'da manuel order cancel)
2. ≤ 60sn içinde `state='desync_detected'` olmalı
3. 10dk içinde 3 kez tekrarla → `state='halted'` olmalı
4. Log'da alarm + yeni sinyal reject doğrulanmalı
5. Manuel recovery sonrası `state='in_sync'` dönmeli

---

## Güncelleme kaydı

| Tarih | Versiyon | Değişiklik |
|--|--|--|
| 2026-04-24 | 1.0 | İlk kurulum — Faz 0 Day 1 veri modeli |
| 2026-04-25 | 1.1 | A (monotonic timestamp + seq), B (partial fills[]), C (currentStage), D (source: api\|manual) eklendi. DeepSeek review sonrası. |
