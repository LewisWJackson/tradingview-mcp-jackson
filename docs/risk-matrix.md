# Risk Matrisi — Otonom Trading Sistemi

Bu doküman, sistemin otonom çalıştırma döngüsünde karşılaşabileceği risklerin
haritasıdır. **Sistemin anayasası** statüsündedir — her mimari karar bu
matrise referans vermek zorundadır.

- **Versiyon**: 1.0 (ilk kurulum)
- **Kapsam**: Kripto + ABD hisse + BIST + Emtia, 4 piyasa
- **Güncellenme kuralı**: Yeni bir risk tespit edildiğinde ekle, mevcut
  risklerde olasılık/etki değişirse revize et, tarih ve gerekçe yaz.
- **Canlıya çıkış kapısı**: Matristeki her "Yüksek olasılık" riskin azaltma
  kontrolü **paper-trading döneminde doğrulanmış** olmadıkça canlıya geçilmez.

---

## Olasılık / Etki ölçeği

| Etiket | Olasılık anlamı | Etki anlamı |
|--|--|--|
| **Düşük** | 6 ayda bir veya daha az | Tek trade kaybı veya gün içi sapma |
| **Orta** | Ayda 1-3 kez | Haftalık performansı bozar, düzeltme ister |
| **Yüksek** | Haftada 1+ kez | Günlük P&L'i dalgalandırır, sürekli gözlem ister |
| **Felaket** | Tek olay hesap kapatır | — |

Etki düzeyi, otonom modda **müdahalesiz** geçen süreye göre değerlendirilir.

---

## Risk Matrisi

| # | Risk | Olasılık | Etki | Azaltma | Doğrulama yöntemi |
|--|--|--|--|--|--|
| 1 | **Learning overfit** (weight-adjuster kontrolsüz öğrenir, rejim değişince ters güven) | Yüksek | Portföy erimesi | Walk-forward (200 train / 50 validation), weight değişim hızı %20/gün cap ✅ (2026-04-25), min 30 outcome threshold ✅ (2026-04-25), **rejim-aware** ayrı weight set'leri ✅ (2026-04-25, 6 rejim taxonomy) | Shadow-mode 4 hafta boyunca weight trajectory log (`weights.weightChangeLog`) + out-of-sample WR karşılaştırması |
| 2 | **Broker state desync** (sistem "açık" sanıyor broker'da kapalı, tersi) | Yüksek | Hayalet/kaçak pozisyon | `trade_id ↔ broker_order_id` eşlemesi, 1dk'da bir reconciliation job, mismatch → otomatik halt + alarm | Haftalık reconciliation drill: kasıtlı desync yarat, sistem yakalıyor mu? |
| 3 | **Kill switch başarısızlığı** (acil durdurma çalışmıyor) | Düşük | Felaket | Üç katmanlı: (a) API endpoint `/api/emergency/halt` ✅ (2026-04-25), (b) terminal script `scripts/kill-all.sh` ✅ (2026-04-25, 4-step fallback chain), (c) exchange-native cancel-all `cancelAllAndFlatten()` timeout+retry+audit ✅ (2026-04-25); halt-state.json persistent (restart sonrası unutmaz); scheduler + okx-dispatcher halt-aware | Haftalık drill 4 senaryo (A/B/C/D) — bkz `docs/kill-switch-drill.md`; paper ortamında pozisyonlar 60sn içinde kapanıyor mu + reconciliation teyidi |
| 4 | **Rejim yanlış teşhis / ping-pong** (geçişte dakikada birkaç değişim) | Orta | Ters strateji tetikler | N=3 bar histerezis ✅ (Faz 1 İter 1, 2026-04-25), rate-limit <4 geçiş/gün/sembol ✅ (Faz 1 İter 1), shadow-mode logger + scanner hook ✅ (Faz 1 İter 2, 2026-04-25), ara rapor üretici (N=3/4 karşılaştırma) ✅ (Faz 1 İter 3, 2026-04-25), **geçiş sırasında yeni pozisyon yok** (`newPositionAllowed: false` histerezis dolana kadar) | `scanner/scripts/regime-report.mjs --days=7` haftalık çalıştırılır; false-flip > %10 ise N=4'e çıkış kararı veriler ile alınır |
| 5 | **Parser kırılması** (KhanSaab/SMC format değişikliği sessiz null döner) | Yüksek | Sessiz yanlış sinyal | `scanner/lib/parser-validator.js` ✅ (2026-04-25): `TECHNICAL_SCHEMA` + `KHANSAAB_SCHEMA` + `SMC_SCHEMA` zorunlu field listesi; `gateTechnicals/gateSMC` parse sonrası — **broken** (>=50% required eksik) → null döner (mevcut akış BEKLE'ye düşer), **partial** → veri geçer ama `parser_alarm` log + counter; günlük rotation `data/parser-alarms.json` (bugün/dün); `/api/parser-alarms` endpoint günlük review için | `curl /api/parser-alarms` günlük; `today.total > 0` → acil fix; 16/16 unit test |
| 6 | **HTF fib cache stale** (30h+ eski cache sessiz null, TP capped değil) | Yüksek | TP filtresi kalkar, over-reach sinyal | Cache yaşı kontrolü + warn log + counter; stale ise TP default HTF cap ile çalış (varsayılan buffer), null geçme | Faz 0 patch; canlıda `stale_used_24h` metriği izlenir |
| 7 | **Flash crash / slippage** (stop ötesi fill, thin liquidity) | Orta | Planlanan SL'in %2-5 ötesi kayıp | Max slippage koruma: order fill entry'den > N × ATR ötedeyse cancel; volatility > X σ → yeni pozisyon yok | Paper'da gerçek slippage ölçümü; ortalama > %0.3 ise sistem halt |
| 8 | **Multi-market gizli korelasyon** (BTC-beta'lı 5 pozisyon = tek devasa BTC pozisyonu) | Orta | Tek risk birden fazla pozisyonda birikir | Rolling 30d korelasyon matrisi, **net-beta limiti** (toplam BTC-beta < 3, SPX-beta < 3, USDTRY-beta < 2), sektör/varlık sınıfı kapakları | Günlük portföy beta raporu; limit aşılırsa yeni pozisyon red |
| 9 | **Session asimetrisi** (gece sadece kripto açıkken portföy kriptoya yığılır) | Orta | Zaman dilimi bazlı risk yoğunlaşması | Saat-bazlı risk bütçesi (bkz `docs/regime-taxonomy.md` session tablosu), new-position rate limit | Hafta boyu portföy composition saatlik snapshot; dengesizlik görünürse bütçe revize |
| 10 | **Exchange/broker outage** (API cevap vermiyor, market halted) | Orta | Pozisyon ne açılır ne kapanır | (a) Multi-venue desteği hazırlığı (ör. Binance + Bybit aynı kriptoda), (b) outage > 5dk → tüm açık pozisyon için önce hedge emri dene; başarısızsa full halt | Aylık drill: kasıtlı API timeout simüle et |
| 11 | **Funding fee / overnight fee erozyonu** (pozisyon teknik olarak kazançta ama carry ile eksi) | Orta | Sessiz sızıntı | Her açık pozisyonda günlük carrying cost hesabı; `daily_carry_pct >= 0.5%` → TP daralt veya zaman aşımı kısalt; kümülatif carry > kar potansiyeli → kapat | Günlük P&L raporunda `realized - gross` farkı izlenir |
| 12 | **TradingView CDP bridge kopması** (veri feed'i ölür) | Orta | Sinyal üretimi durur, mevcut pozisyon state yarı-kör kalır | Heartbeat + 30sn reconnect loop; feed yoksa yeni sinyal üretilmez, **mevcut açık pozisyonlar exchange/broker-native fiyat feed'i üzerinden outcome takip eder**; 5dk+ feed yoksa halt alarmı | Günlük uptime metriği, haftalık kopma sayısı |
| 13 | **Clock drift / timestamp mismatch** (outcome'lar yanlış trade'e eşlenir) | Düşük | Öğrenme korrupte, yanlış atıf | NTP sync zorunlu (systemd-timesyncd), tüm timestamp UTC + epoch ms; her yazımda monotonic-check | Günlük `abs(local - ntp) < 500ms` assert |
| 14 | **Black swan / stop atlama** (gap open veya likidite boşluğu) | Düşük | Sermaye sıçraması | Hard `%R-per-trade` limiti (%0.5-1), hesap drawdown %10 → tüm açık pozisyon halt + yeni sinyal red 48 saat | Paper dönemde her pozisyonun max adverse excursion ölçümü |
| 15 | **Regülasyon / broker kural değişikliği** (yeni order reddi, leverage sınırı) | Düşük | Sessiz trade reddi | Order reject handler → alarm + açıklayıcı log; aylık broker changelog review; yeni kural algılanırsa manuel inceleme | Aylık review checklist |
| 16 | **Model decay / konsept kayması** (piyasa rejimleri zamanla evrilir, geçmiş threshold'lar bugün geçersiz) | Yüksek | Sessiz performans erozyonu | **3 ayda bir periyodik walk-forward re-optimizasyon**; out-of-sample performans son 3 ayda ≥%20 bozulursa **alarm + manuel inceleme + re-kalibrasyon**; rejim sıklık dağılımı değişirse taxonomy güncellemesi | 3 aylık performans raporu, sürekli `live vs backtest PF` ratio izleme |
| 17 | **Veri feed zombi bağlantısı** (Binance WS TCP açık ama mesaj akışı durmuş — `connected:true` yanıltıcı) | Yüksek | Tüm sinyal/rejim akışı stale fiyatla çalışır; shadow log kirlenir | `live-price-feed.js` heartbeat timer (15sn aralık) ✅ (2026-04-25), idle > 60sn → `ws.terminate()` + auto-reconnect ✅, proaktif `_ws.ping()` her heartbeat'te (NAT/proxy timeout sigortası) ✅, `idleReconnects` sayacı ✅, `/api/feed-health` endpoint (severity: ok / warning >30sn / critical >60sn) ✅ | `curl /api/feed-health` günlük; `severity != "ok"` veya `idleReconnects` artıyor → kök sebep araştırması (Binance API status, network) |

---

## Kategori özeti

| Kategori | Risk #'leri | Toplam azaltma yatırımı |
|--|--|--|
| **Veri bütünlüğü** | 5, 6, 12, 13, 17 | Parser validation, cache freshness, feed heartbeat (CDP + Binance WS), clock sync |
| **Execution / state** | 2, 3, 7, 10, 14, 15 | Reconciliation, kill switch, slippage guard, outage handling |
| **Öğrenme / adaptasyon** | 1, 16 | Walk-forward + rate cap + periyodik re-optimizasyon |
| **Portföy / korelasyon** | 8, 9, 11 | Beta matrisi, session budget, carry accounting |
| **Rejim tespiti** | 4 | Histerezis + shadow mode |

---

## Her piyasa için özel riskler (ek not)

| Piyasa | Yüksek önemli risk | Neden |
|--|--|--|
| **Kripto** | #11 (funding erozyonu), #7 (flash crash) | 24/7 + yüksek kaldıraç + liquidation cascade |
| **ABD hisse** | #14 (gap open), #10 (session-bound outage) | Gece gap, earnings boşlukları, session sınırlı |
| **BIST** | #7 (thin liquidity slippage), #14 (tavan-taban) | Düşük derinlik, siyasi şok hassasiyeti |
| **Emtia** | #15 (contract roll), #10 (thin hours) | Vade yuvarlaması, bölgesel seans boşlukları |

---

## Canlıya geçiş kapısı (go / no-go kontrolleri)

Aşağıdaki maddelerin **tamamı** paper-trading döneminde doğrulanmadıkça
otonom canlı moda geçilmez:

- [ ] Her "Yüksek olasılık" risk için azaltma kontrolü test edilmiş (#1, #2,
      #5, #6, #16)
- [ ] Kill switch drill en az 4 kez başarılı çalıştırılmış
- [ ] Reconciliation drill en az 4 kez başarılı çalıştırılmış
- [ ] Paper trading süresi her piyasada ≥ 8 hafta VE ≥ 30 kapalı işlem
- [ ] Slippage < %0.3 ortalama, hiçbir gün > %1
- [ ] Learning weight trajectory'si rejim-aware ayrılmış, `validation_wr` ≥ `train_wr × 0.85`
- [ ] Günlük `parser_alarm` = 0, son 14 günde
- [ ] `live vs backtest PF` ratio 0.7 - 1.3 aralığında
- [ ] Clock drift < 500ms son 30 günde
- [ ] Risk matrisi versiyonu ≥ 1.0 ve son review tarihi < 30 gün

---

## Güncelleme kaydı

| Tarih | Versiyon | Değişiklik | Yapan |
|--|--|--|--|
| 2026-04-24 | 1.0 | İlk kurulum — 16 risk, 4 piyasa | İnsan + Claude + DeepSeek review |
| 2026-04-25 | 1.1 | Risk #1 azaltma kontrolleri uygulandı: rate cap %20/gün, min 30 sample, regime-aware data modeli (6 rejim taxonomy) | Claude + DeepSeek |
| 2026-04-25 | 1.2 | Risk #3 kill switch 3-katman implement edildi: halt-state modülü + `/api/emergency/*` endpoint'leri + `scripts/kill-all.sh` fallback + `cancelAllAndFlatten()` timeout+retry+audit + drill doc (`docs/kill-switch-drill.md`) | Claude + DeepSeek |
| 2026-04-25 | 1.5 | **Yeni Risk #17** eklendi — "Veri feed zombi bağlantısı". Canlı sistemde Binance WS 80+ dk mesaj akışı kesildiği halde `connected:true` döndürüyordu; shadow veri kirleniyordu. Fix: `live-price-feed.js` heartbeat (15sn) + idle-detect (60sn) + auto-reconnect + `_ws.ping()` + `idleReconnects` sayacı + `/api/feed-health` endpoint. Bekleme dönemi kuralına istisna gerekçesi: shadow veri bütünlüğü > bekleme. | Claude + DeepSeek |
| 2026-04-25 | 1.4 | Risk #5 parser kırılma koruması: `parser-validator.js` (TECHNICAL/KHANSAAB/SMC schema), `gateTechnicals`+`gateSMC` scanner-engine'de hot-path, alarm counter (günlük rotation), `/api/parser-alarms` endpoint. 16/16 yeni test. | Claude + DeepSeek |
| 2026-04-25 | 1.3 | Risk #4 Faz 1 shadow-mode kuruldu: `computeRegime()` 6-rejim state machine + N=3 histerezis + rate-limit, `regime-profiles.js` 4 piyasa, `regime-shadow-logger.js` JSONL + günlük rotation, scanner-engine hook (try-catch, sıfır etki), `regime-report.mjs` ara rapor + N=3/N=4 simülasyonu, `config/chaos-windows.json` template. Test: 26/26 yeni + 29/29 regression. Perf 0.08 ms/kombinasyon. | Claude + DeepSeek |
