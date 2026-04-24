# Kill Switch — Tasarim, Katmanlar ve Drill Proseduru

Bu doküman **Risk #3** (Acil durdurma başarısızlığı) için üç katmanlı kill
switch sisteminin referansıdır. Bir sistem kapanmak istediğinde **her zaman**
bir yolu kapalı bulursa risk kabul edilebilir seviyeye iner — bu yüzden üç
bağımsız katman vardır.

- **Versiyon**: 1.0 (ilk kurulum, 2026-04-25)
- **Bağlı risk**: #3 (Kill switch başarısızlığı — Düşük olasılık / Felaket etki)
- **Sahip**: Scanner (`scanner/lib/halt-state.js`) — persistent state tek kaynak
- **Canlıya çıkış şartı**: paper ortamında **en az 4 başarılı drill**

---

## Sistem mimarisi

```
                  +-------------------------+
                  |  halt-state.json        |   <-- tek kaynak (persistent)
                  |  scanner/data/          |       restart sonrasi unutulmaz
                  +-----------+-------------+
                              ^
                              | read/write
           +------------------+------------------+
           |                  |                  |
+----------+------+  +--------+-------+  +-------+---------+
|  Layer A        |  |  Layer B       |  |  Layer C        |
|  API endpoint   |  |  kill-all.sh   |  |  exchange-native|
|  (scanner UI)   |  |  (terminal)    |  |  cancel-all     |
+-----------------+  +----------------+  +-----------------+
         |                    |                    |
         v                    v                    v
  scheduler.stop()     SIGTERM node         OKX executor API
  dispatcher block     + file fallback      /api/emergency/
                       + process kill          cancel-all
```

**Her katmanın varsayımı**: bir üst katmanın çalışmadığı senaryoda işe yaraması.

| Senaryo | Layer A | Layer B | Layer C |
|--|--|--|--|
| Normal operatör halt | ✅ kullanır | — | opsiyonel (`cancelOrders:true`) |
| Scanner API cevap vermiyor | ❌ | ✅ direkt dosya yazar | ✅ direkt executor çağırır |
| Scanner process ölü | ❌ | ✅ PID kill + dosya | ✅ executor bağımsız |
| Scanner + executor ölü | ❌ | ✅ dosya korunur, restart sonrası halt devam | ❌ alarm + manuel borsa UI |
| Exchange API chaos | ✅ yeni trade bloke | ✅ yeni trade bloke | ❌ alarm (retry 3x, sonra manuel) |

---

## Layer A — API endpoint (ilk yol)

**Ne zaman**: dashboard'dan, script'ten, veya bir programmatic caller'dan.

### Engage

```bash
curl -X POST http://localhost:3838/api/emergency/halt \
  -H 'Content-Type: application/json' \
  -d '{
    "reason": "flash_crash_detected",
    "by": "operator",
    "cancelOrders": true
  }'
```

Etkileri:
1. `halt-state.json` yazılır (`halted: true, source: "api", layer: "A"`)
2. `scheduler.stop()` çağrılır + lock queue drain
3. `cancelOrders: true` ise Layer C tetiklenir (timeout 5sn, 3 retry)
4. WebSocket `emergency_halt` event broadcast edilir

### Status

```bash
curl http://localhost:3838/api/emergency/status
```

Dönen JSON: `{halt: {halted, reason, haltedAt, source, layer, history, cancelAll}, scheduler: {...}}`

### Release (korumalı)

```bash
curl -X POST http://localhost:3838/api/emergency/release \
  -H 'Content-Type: application/json' \
  -d '{"by":"operator","reason":"post_incident_resume","confirm":"I_CONFIRM_RELEASE"}'
```

`confirm` field'ı yanlışlıkla release'e karşı korumadır. Release **scheduler'ı otomatik başlatmaz** — operatör bilinçli olarak `/api/scheduler/start` çağırmalı.

---

## Layer B — Terminal fallback (`scripts/kill-all.sh`)

**Ne zaman**: API cevap vermiyor, dashboard açılmıyor, veya sunucu cokmus.

```bash
./scripts/kill-all.sh "reason text here"
```

### Akış

| Adım | Ne yapar | Başarısızsa |
|--|--|--|
| 1 | `POST /api/emergency/halt` (3sn timeout) | 2. adıma düşer |
| 2 | `halt-state.json`'a direkt yazar | sunucu restart sonrası halt'ta kalır |
| 3 | `pgrep scanner/server.js` → SIGTERM, 10sn bekle, SIGKILL | FAIL raporu |
| 4 | Executor `/api/emergency/cancel-all` (5sn × 3 retry) | **alarm — manuel borsa UI** |

### Çıktı örneği (başarılı drill)

```
=========================================================================
  KILL SWITCH (Layer B) — 2026-04-25T14:32:11Z
  Reason: drill_test
=========================================================================
[1/4] Scanner API halt + cancelOrders...
  [PASS] API halt engaged: {"success":true,"halt":{"halted":true,...
[2/4] halt-state.json direct write...
  [PASS] halt-state.json already written by API
[3/4] Scanner node process kill...
  [PASS] scanner stopped gracefully
[4/4] Executor cancel-all direct call...
  [PASS] executor cancel-all OK on attempt 1: {"success":true,"cancelled":3}
=========================================================================
  RESULT: 4 passed, 0 failed
  NEXT: verify reconciliation within 60s — brokerPosition should be null
=========================================================================
```

**Kritik**: her adım bağımsız raporlar. Script `set -e` kullanmaz — Step 3 başarısız olsa bile Step 4 çalışmaya devam eder.

---

## Layer C — Exchange-native cancel-all + flatten

**Ne zaman**: Layer A veya B tarafından otomatik tetiklenir, veya `/api/emergency/cancel-all` ile manuel.

### `cancelAllAndFlatten()` (scanner/lib/okx-dispatcher.js)

- 3 attempt, her biri 5sn timeout, linear backoff (1/2/3 sn)
- Her deneme `halt-state.json.cancelAll.attempts[]` audit'e yazılır (son 50)
- Başarı → `lastSuccessAt` damgalanır
- Başarısızlık → `detail: "ALL_ATTEMPTS_FAILED — MANUAL INTERVENTION REQUIRED"`, console.error alarm

### DeepSeek uyarısı (mimari not)

> "Exchange API'si de çökmüş olabilir (özellikle chaos anında). Bu durumda
> kill switch'in 'başaramadım' diye alarm vermesi, sessizce başarısız
> olmasından iyidir."

Bu prensip koda gömüldü: `success: false` sonucu audit trail'e yazılır, console.error basar, operator Layer B'den gelen çıktıda `[FAIL]` görür. **Sessiz başarısızlık imkansız**.

### Executor endpoint sözleşmesi (executor tarafında implement edilecek)

```
POST /api/emergency/cancel-all
Body: { reason: string, source: string }
Response (success): { success: true, cancelled: <count>, closed: <count> }
Response (fail):    HTTP 5xx / { success: false, error: "..." }
```

Executor henüz bu endpoint'i implement etmediyse Layer C **alarm modunda** çalışır — halt devreye girer, yeni trade çıkmaz, ama eski pozisyonlar için **borsa UI üzerinden manuel** kapatma gerekir. Drill bu durumu mutlaka test etmeli.

---

## Haftalık drill prosedürü (paper ortamı)

**Amaç**: Her katmanın gerçekten çalıştığını, ve kill sonrası pozisyonların 60sn içinde kapandığını düzenli olarak doğrulamak.

**Ortam**: `OKX_EXECUTOR_URL` paper endpoint'e, `SIGNAL_NOTIFY_ENABLED=0`, gerçek sermaye yok.

### Önhazırlık

```bash
# 1. Scanner ve executor'ı ayağa kaldır
./scanner/start.sh

# 2. Paper pozisyon aç (executor direkt, küçük büyüklük)
curl -X POST $OKX_EXECUTOR_URL/api/paper/open \
  -d '{"symbol":"BTC-USDT","side":"long","size":0.001}'

# 3. scanner baseline status
curl http://localhost:3838/api/emergency/status
# expected: halt.halted == false
```

### Drill A — API katmanı

```bash
# Engage
curl -X POST http://localhost:3838/api/emergency/halt \
  -d '{"reason":"drill_A","by":"drill","cancelOrders":true}'

# 60 saniye bekle, sonra teyit
sleep 60
curl http://localhost:3838/api/emergency/status | jq '.halt.cancelAll'
# expected: lastSuccessAt set, attempts[].success == true

# Reconciliation teyit — açık pozisyon kapalı olmalı
# (signal-tracker.open.json içindeki brokerPosition alanları null/closed olmalı)
cat scanner/data/learning/open.json | jq '[.[] | select(.reconciliationState.brokerPosition != null)]'
# expected: [] (boş array)

# Release + scheduler resume
curl -X POST http://localhost:3838/api/emergency/release \
  -d '{"by":"drill","confirm":"I_CONFIRM_RELEASE"}'
curl -X POST http://localhost:3838/api/scheduler/start
```

### Drill B — Terminal fallback (API çalışırken yine de)

```bash
# Yeni paper pozisyon aç
# ... (drill A'daki gibi)

# Script'i çalıştır
./scripts/kill-all.sh "drill_B"
# expected output: "RESULT: 4 passed, 0 failed"

# Scanner restart
./scanner/start.sh

# Restart sonrası halt hala aktif mi? (persistent test)
curl http://localhost:3838/api/emergency/status | jq '.halt.halted'
# expected: true (halt-state.json restart sonrasi korundu)

# Release + resume
curl -X POST http://localhost:3838/api/emergency/release \
  -d '{"by":"drill","confirm":"I_CONFIRM_RELEASE"}'
curl -X POST http://localhost:3838/api/scheduler/start
```

### Drill C — Chaos mode (API ölü)

```bash
# Paper pozisyon aç
# ...

# Scanner'ı sert öldür (API kullanılabilir değil)
pkill -9 -f scanner/server.js

# Script fallback modunda çalışacak
./scripts/kill-all.sh "drill_C_chaos"
# expected: Step 1 FAIL (API down), Step 2 PASS (file write), Step 3 PASS (no process to kill), Step 4 PASS (executor direct)

# halt-state.json dosyada mı?
cat scanner/data/halt-state.json | jq '.halted'
# expected: true

# Scanner'ı baştan başlat — halt hala aktif olmalı (yeni dispatch bloke)
./scanner/start.sh
sleep 5
curl http://localhost:3838/api/emergency/status | jq '.halt'
# expected: halted==true, source=="script", layer=="B"

# Release + resume
curl -X POST http://localhost:3838/api/emergency/release \
  -d '{"by":"drill","confirm":"I_CONFIRM_RELEASE"}'
```

### Drill D — Executor down (Layer C alarm mode)

```bash
# Scanner açık, ama executor'ı durdur
pkill -f okx-executor  # executor süreç adı ne ise

# Halt engage cancelOrders=true ile
curl -X POST http://localhost:3838/api/emergency/halt \
  -d '{"reason":"drill_D","by":"drill","cancelOrders":true}'

# Response'ta "CANCEL-ALL FAILED, MANUAL INTERVENTION" mesajı görülmeli
# halt-state audit'te 3 başarısız attempt olmalı
curl http://localhost:3838/api/emergency/status | jq '.halt.cancelAll.attempts[-3:]'
# expected: attempts[].success == false (× 3)

# Bu drill "alarm'ın görüldüğünü" doğrular. Gerçekte operator borsa UI'den
# manuel cancel/close yapmalı; sonra release.
```

---

## Başarı kriteri (go/no-go)

Kill switch'in canlıya geçiş onayı için **4 farklı haftada**, **her 4 drill**
(A, B, C, D) başarıyla çalıştırılmış olmalı:

- [ ] Drill A × 4 hafta — pozisyonlar 60sn içinde kapandı, reconciliation teyit
- [ ] Drill B × 4 hafta — script 4/4 PASS, restart sonrası halt korundu
- [ ] Drill C × 4 hafta — chaos scenario'da Step 2 direkt file write çalıştı
- [ ] Drill D × 4 hafta — executor down'da "alarm mode" doğru çalıştı, sessiz başarı yok

**Reconciliation köprüsü** (DeepSeek uyarısı):  
Her drill sonrası `scanner/data/learning/open.json` içinde
`reconciliationState.brokerPosition` alanları 60 saniye içinde `null` (veya
`closed`) olmalı. Olmazsa reconciliation job eskalasyona girer — bu da
ayrıca alarm üretir ve drill **başarısız** sayılır.

---

## Güncelleme kaydı

| Tarih | Versiyon | Değişiklik |
|--|--|--|
| 2026-04-25 | 1.0 | İlk kurulum — 3 katman, 4 drill senaryosu, reconciliation köprüsü |
