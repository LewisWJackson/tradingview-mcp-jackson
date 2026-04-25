# Faz 2 Tasarım Notu — Rejim-Strateji Wrapper

> **Statü**: Tasarım taslağı (henüz uygulanmadı). Faz 1 ara raporu (1 hafta
> sonu) sonrası verilerle doğrulanır, sonra implementasyona başlanır.
>
> **Versiyon**: 1.0 (2026-04-25, ilk tasarım)
>
> **Bağlam**: Faz 0 (kritik patchler + reconciliation + kill switch + learning
> guardrails) ve Faz 1 (computeRegime shadow mode) tamamlandı. Şu an sistem:
> ham rejim teşhisi yapıp JSONL'e yazıyor; sinyal pipeline'ı ise ESKİ
> oylama mantığı + macro filter ile çalışıyor. Faz 2'nin görevi:
> **rejim teşhisini sinyal akışına bağlamak.**

---

## 1. Felsefe (taxonomy §1'den)

> "Önce rejim → sonra strateji → sonra sinyal. Oylama asla rejimden önce
> koşmaz."

Şu an `signal-grader.js`'in oylama mantığı, rejimden bağımsız çalışıyor —
yani ranging'de momentum oylar, trending_up'ta mean-reversion oylar. Bu
yanlış strateji-rejim eşleşmesinin kaynağıdır. Faz 2'nin tek satırlık
özeti:

> Rejim, oylamaya hangi göstergelerin **dahil edileceğini** ve hangilerinin
> **dışlanacağını** seçmeli; ek olarak SL/TP profili rejime göre değişmeli.

---

## 2. Rejim-Strateji Eşleme Tablosu

| Rejim | Strateji | Birincil göstergeler (oy ağırlığı yüksek) | Bastırılan göstergeler | SL profili | Yeni pozisyon? |
|--|--|--|--|--|--|
| `trending_up` | **Pullback long entry** | EMA cross BULL, MACD BULL, ADX rising, OB/FVG support bounce, BOS bullish | Mean-reversion RSI dip alarmları (30 altı = al) — bastır | ATR × 2.5 (taxonomy normal) | ✅ |
| `trending_down` | **Pullback short entry** | EMA cross BEAR, MACD BEAR, ADX rising, OB/FVG resistance reject, BOS bearish | Mean-reversion RSI peak alarmları (70 üstü = sat) — bastır | ATR × 2.5 | ✅ |
| `ranging` | **Mean reversion** | RSI extremes (>70 sat / <30 al), BB band touches, S/R bounce, volume decline | Trend göstergeleri (EMA cross, BOS) düşük ağırlık | ATR × 1.5 (dar SL — range içinde fail erken kabul) | ✅ |
| `breakout_pending` | **Momentum on break** | BB squeeze + ADX yükselişe başlıyor, volume spike, BOS yeni → break confirm bekle | Pullback giriş tetikleyicileri (sıkışmada giriş yok) | ATR × 3.0 (geniş — breakout volatilite artırır) | ✅ ama _break confirmed_ sonra |
| `high_vol_chaos` | **YENİ POZİSYON YOK** | — | — | mevcut pozisyon hedge | ❌ |
| `low_vol_drift` | **YENİ POZİSYON YOK** | — | — | — | ❌ |
| `market_closed` | — | — | — | — | ❌ |

**Alt-rejim ek kuralları:**

- `bist_decoupled_stress`: long sinyal **kesin red**, short serbest (panik
  yön bilinmesine rağmen TL stresinin mantık yönü)
- `bist_tl_stable_domestic`: ranging stratejisi **yeterli** (özel strateji
  yok) — taxonomy %10 altı tetikse "kaynak harcama"
- `bist_tl_spike_inflation`: trending_up agresif TP (nominal patlama)

---

## 3. Wrapper Mimarisi

### 3.1 Mevcut akış (Faz 1 sonu)

```
collectShortTermData(symbol, tf)
  ├─ ohlcv, studyValues, KhanSaab, SMC parsing (gated)
  ├─ classifyRegime(macro, adx) ← LEGACY 5-rejim
  └─ shadow-mode hook: computeRegime() → JSONL log [SİNYAL AKIŞINDAN BAĞIMSIZ]
       │
       ▼
gradeShortTermSignal({khanSaab, smc, regime: legacy, ...})
  ├─ collectVotes() — REJİMDEN BAĞIMSIZ oylama
  ├─ alignment-filters
  └─ smart entry + SL/TP
```

### 3.2 Faz 2 hedef akışı

```
collectShortTermData(symbol, tf)
  ├─ (aynı parsing, gating)
  └─ computeRegime() → strategyHint, newPositionAllowed, regime, subRegime
       │
       ▼ (newPositionAllowed === false ise BURADA BEKLE üret, oylama kaçır)
       │
gradeShortTermSignal({
  khanSaab, smc, ...,
  regimeContext: { regime, subRegime, strategyHint, confidence }
})
  ├─ collectVotes() — REJİME GÖRE ağırlık seti seç + bastırılanları çıkar
  ├─ alignment-filters (rejim-aware: ranging'de OB-bounce zorunlu vs)
  └─ smart entry + SL/TP profili rejime göre (ATR çarpanı)
```

### 3.3 Wrapper tasarımı

Anahtar prensip: **mevcut `signal-grader.js` mantığını yeniden yazmıyoruz**;
rejim bilgisini "context" olarak enjekte edip mevcut votes/filter mantığını
hafifçe modify ediyoruz.

**Yeni dosya**: `scanner/lib/learning/regime-strategy.js`

```js
// Arayuz sözlesmesi (test edilebilir)
export function applyRegimeStrategy({
  regimeContext,   // { regime, subRegime, strategyHint, confidence }
  votes,           // collectVotes() ham çıktısı: [{indicator, direction, weight}]
  signalDraft,     // { direction, entry, sl, tp1, ... }
  category,        // 'kripto' | 'abd_hisse' | 'bist' | 'emtia'
}) {
  return {
    rejected: bool,         // true ise bu sinyal REJIM tarafından red
    rejectionReason: string|null,
    adjustedVotes: votes',  // bastırılan göstergeler ağırlığı 0'a alındı
    slMultiplier: number,   // rejim profilinden gelen ATR çarpanı
    tpProfile: 'normal'|'aggressive'|'tight',  // rejim → TP genişliği
    notes: string[],
  };
}
```

**Kullanım site'i**: `signal-grader.js` `gradeShortTermSignal` içinde,
`collectVotes()` çağrısından **hemen sonra**, alignment filter'lardan
**önce**:

```js
const votes = collectVotes({...});
// ↓ Faz 2 wrapper hook
const regimeAdj = applyRegimeStrategy({ regimeContext, votes, ... });
if (regimeAdj.rejected) {
  return { grade: null, action: 'BEKLE', reasoning: [regimeAdj.rejectionReason] };
}
const finalVotes = regimeAdj.adjustedVotes;
const slMult = regimeAdj.slMultiplier;
// ↑
// ... mevcut akış devam (alignment, smart entry, vs)
```

Bu desen değişikliği **lokal**: 5-10 satır değişir, mevcut votes/filter
implementasyonuna dokunulmaz.

---

## 4. Veri akışı: regimeContext nereden gelecek?

`scanner-engine.js` `_scanShortTermInner` halihazırda her TF için
`computeRegime` çağrısını shadow-mode'da yapıyor. Faz 2'de bu çağrının
**çıktısı `gradeShortTermSignal`'a geçilecek**.

Tek değişiklik:

```diff
- const signal = gradeShortTermSignal({ khanSaab, smc, ..., regime: legacyRegime });
+ const regimeContext = {
+   regime: shadowResult.regime,
+   subRegime: shadowResult.subRegime,
+   strategyHint: shadowResult.strategyHint,
+   confidence: shadowResult.confidence,
+   newPositionAllowed: shadowResult.newPositionAllowed,
+ };
+ if (!regimeContext.newPositionAllowed) {
+   tfSignals.push({ tf, grade: null, action: 'BEKLE', reasoning: [`rejim ${regimeContext.regime} yeni pozisyon kapali`] });
+   continue;
+ }
+ const signal = gradeShortTermSignal({ khanSaab, smc, ..., regimeContext });
```

`legacyRegime` (eski 5-rejim) `weight-adjuster.js`'in `byRegime` setlerini
seçmek için **şimdilik korunur** (geçiş döneminde). Faz 2 ikinci yarısında
weight-adjuster da yeni 6-rejimli `byRegime`'a geçer (zaten REGIMES_TRACKED
listesi yeni isimlere uygun).

---

## 5. Test edilebilirlik arayüzü

**Birim test plan**: `scanner/tests/regime-strategy.test.mjs`

```js
test('trending_up: mean-reversion RSI 30 alti oy bastırılır', () => {
  const out = applyRegimeStrategy({
    regimeContext: { regime: 'trending_up', strategyHint: 'pullback_entry_long' },
    votes: [
      { indicator: 'rsi_oversold', direction: 'long', weight: 1.0 },
      { indicator: 'ema_bull', direction: 'long', weight: 1.0 },
    ],
    signalDraft: { direction: 'long' },
  });
  const rsiVote = out.adjustedVotes.find(v => v.indicator === 'rsi_oversold');
  assert.equal(rsiVote.weight, 0);
  const emaVote = out.adjustedVotes.find(v => v.indicator === 'ema_bull');
  assert.equal(emaVote.weight, 1.0);
});

test('high_vol_chaos: dogrudan rejected', () => {
  const out = applyRegimeStrategy({
    regimeContext: { regime: 'high_vol_chaos' },
    votes: [{ indicator: 'x', direction: 'long', weight: 1 }],
    signalDraft: { direction: 'long' },
  });
  assert.equal(out.rejected, true);
});

test('bist_decoupled_stress: long red, short serbest', () => {
  const longOut = applyRegimeStrategy({
    regimeContext: { regime: 'high_vol_chaos', subRegime: 'bist_decoupled_stress' },
    signalDraft: { direction: 'long' },
    votes: [],
  });
  assert.equal(longOut.rejected, true);

  const shortOut = applyRegimeStrategy({
    regimeContext: { regime: 'high_vol_chaos', subRegime: 'bist_decoupled_stress' },
    signalDraft: { direction: 'short' },
    votes: [],
  });
  // Note: subregime yine high_vol_chaos default'una düşer (chaos'ta hiçbir yön)
  // Beklenen: short da rejected. Bu koşul tartışmalı — taxonomy "long red,
  // short serbest" diyor. Test bu kararı sabitliyor.
  assert.equal(shortOut.rejected, true);  // güvenli taraf: chaos = no new pos
});
```

---

## 6. Geçiş planı (commit sırası)

Ara rapor doğrulandıktan sonra:

1. **Commit 1**: `regime-strategy.js` + tests (henüz wired DEĞIL — saf modül)
   - Vote suppression tablosu kodla, unit test
   - SL multiplier profili: profile dosyası mı yoksa burada hardcode mu?
     Karar: profile dosyasında yeni alanlar (`slMult.trending`, `.ranging` vs)
2. **Commit 2**: `signal-grader.js`'e wrapper hook (5-10 satır)
   - `regimeContext` parametresi ekle, `applyRegimeStrategy` çağır, votes
     güncelle, SL multiplier override et
3. **Commit 3**: `scanner-engine.js` `_scanShortTermInner`'da computeRegime
   sonucunu gradeShortTermSignal'a geçir
4. **Commit 4**: weight-adjuster geçişi — `byRegime` artık 6-rejim üzerinden
   (zaten REGIMES_TRACKED bunu destekliyor)
5. **Commit 5**: Risk Matrix v1.5 + dokümantasyon

Her commit ayrı PR / review noktası — toplu rollback kolay.

---

## 7. Bilinmeyenler / risk noktaları

| Bilinmeyen | Açıklama | Karar zamanı |
|--|--|--|
| **Vote indicator isimleri** | `collectVotes` hangi `indicator` field'larını üretiyor? Suppression tablosu için bu liste lazım | Implementation öncesi `collectVotes` okumayı zorunlu (~30 dk) |
| **SL profile dosyası mı, hardcode mu?** | Rejim → ATR çarpanı eşlemesi nerede yaşar? | Tasarım: `regime-profiles.js`'e `slMult` alanı ekle, runtime'da load |
| **Ara rapordan sonra eşik değişimleri** | Faz 1 verisi `adxHi`/`adxLo`'yu kalibre edecek; Faz 2 implementasyonu kalibre eşiklere göre | Ara rapor → eşik update → sonra Faz 2 commit'leri |
| **Backtest rejim retroaktif mi?** | Geçmiş sinyallerde rejim hesaplaması yapılabilir mi? `signal-tracker` log'larında `regime` field var ama eski 5-rejim. Migration gerekir. | Faz 2 Commit 4 sonrası, geçmiş outcome'ları yeni rejimlerle backfill |

---

## 8. DeepSeek tavsiyesinin kapsamı

DeepSeek bu tasarım notunda istediği:

- ✅ Her 6 rejim için strateji seçimi → Bölüm 2'de tablo
- ✅ Wrapper'ın `signal-grader.js`'e nasıl bağlanacağı → Bölüm 3
- ✅ Test edilebilir arayüz → Bölüm 5

**Ara rapor sonrası bu doküman:**
1. Bölüm 2'deki bastırma listeleri canlı veriyle doğrulanır
2. SL multiplier sayıları ara rapor istatistiklerinden kalibre edilir
3. Bölüm 7'deki bilinmeyenler kapatılır
4. Implementasyon başlar

---

## 9. Güncelleme kaydı

| Tarih | Versiyon | Değişiklik |
|--|--|--|
| 2026-04-25 | 1.0 | İlk tasarım — eşleme tablosu, wrapper mimarisi, geçiş planı, bilinmeyenler |
