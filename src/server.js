import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHealthTools } from "./tools/health.js";
import { registerChartTools } from "./tools/chart.js";
import { registerPineTools } from "./tools/pine.js";
import { registerDataTools } from "./tools/data.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerDrawingTools } from "./tools/drawing.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerReplayTools } from "./tools/replay.js";
import { registerIndicatorTools } from "./tools/indicators.js";
import { registerWatchlistTools } from "./tools/watchlist.js";
import { registerUiTools } from "./tools/ui.js";
import { registerPaneTools } from "./tools/pane.js";
import { registerTabTools } from "./tools/tab.js";
import { registerMorningTools } from "./tools/morning.js";
import { registerResources } from "./resources.js";

const server = new McpServer(
  {
    name: "tradingview",
    version: "2.1.0-tr-guvenli",
    description:
      "TradingView grafik analizi ve Pine Script gelistirme - Chrome DevTools Protocol uzerinden (Guvenlik yamali Turkce surum)",
  },
  {
    instructions: `TradingView MCP — Canli TradingView Desktop grafiklerini okuma ve kontrol etme araclari.

ARAC SECIM REHBERI — dogru araci secmek icin kullanin:

Grafiginizi okuma:
- chart_get_state → sembol, zaman dilimi, tum indikator adlari + entity ID'leri (ilk bunu cagirin)
- data_get_study_values → tum gorunen indikatorlerin guncel sayisal degerleri (RSI, MACD, BB, EMA, vb.)
- quote_get → anlik fiyat (son, OHLC, hacim)
- data_get_ohlcv → fiyat mumlari. Bireysel mumlara ihtiyaciniz yoksa MUTLAKA summary=true kullanin

Ozel Pine indikator ciktilari (line.new/label.new/table.new/box.new):
- data_get_pine_lines → ozel indikatorlerden yatay fiyat seviyeleri
- data_get_pine_labels → fiyatli metin etiketleri ("PDH 24550", "Bias Long", vb.)
- data_get_pine_tables → tablo verileri (seans istatistikleri, analiz panolari)
- data_get_pine_boxes → fiyat bölgeleri {high, low} ciftleri
- MUTLAKA study_filter kullanin (orn: study_filter="Profiler")
- Indikatorlerin grafikte GORUNUR olmasi gerekir

Grafigi degistirme:
- chart_set_symbol, chart_set_timeframe, chart_set_type → sembol/zaman/stil degistir
- chart_manage_indicator → indikator ekle/kaldir. TAM AD KULLANIN: "RSI" degil "Relative Strength Index"
- chart_scroll_to_date → tarihe git (ISO format)
- indicator_set_inputs → indikator ayarlarini degistir

Pine Script gelistirme:
- pine_set_source → kod yaz, pine_smart_compile → derle + hata kontrol
- pine_get_errors → hatalari oku, pine_get_console → log ciktisini oku
- UYARI: pine_get_source karmasik scriptlerde 200KB+ donebilir — sadece duzenleme icin

Ekran goruntusu: capture_screenshot → bolgeler: "full", "chart", "strategy_tester"
Tekrar: replay_start → replay_step → replay_trade → replay_status → replay_stop
Toplu islem: batch_run → birden fazla sembol/zaman diliminde islem yap
Cizim: draw_shape → yatay cizgi, trend cizgisi, dikdortgen, metin
Alarmlar: alert_create, alert_list, alert_delete
Baslatma: tv_launch → TradingView'i otomatik bul ve CDP ile baslat
Paneller: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Sekmeler: tab_list, tab_new, tab_close, tab_switch

GUVENLIK NOTU:
- ui_evaluate araci guvenlik nedeniyle kaldirilmistir (keyfi JS calistirma riski)
- Tum kullanici girdileri JSON.stringify ile guvenli hale getirilmistir
- pine_check araci Pine Script kaynak kodunuzu TradingView sunucularina gonderir — hassas stratejilerinizi kontrol etmeyin

BAGLAM YONETIMI:
- data_get_ohlcv'de MUTLAKA summary=true kullanin
- Pine araclarinda indikator adini biliyorsaniz MUTLAKA study_filter kullanin
- Kullanici ozellikle istemediginde ASLA verbose=true kullanmayin
- Buyuk veri setleri yerine capture_screenshot tercih edin
- chart_get_state'i BASLANGIÇTA BIR KERE cagirin, entity ID'leri tekrar kullanin`,
  },
);

// Register all tool groups
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerMorningTools(server);

// Register static/dynamic resources (watchlist, market-hours, scheduler-status, recent-signals, claude-rules)
registerResources(server);

// Baslangic bildirimi (stderr — MCP stdio protokolunu etkilemez)
process.stderr.write(
  "⚠  tradingview-mcp (TR-Guvenli)  |  Resmi olmayan arac. TradingView Inc. veya Anthropic ile baglantisi yoktur.\n",
);
process.stderr.write(
  "   Kullaniminizin TradingView Kullanim Kosullari'na uygun olduguna emin olun.\n",
);
process.stderr.write(
  "   Guvenlik yamalari: ui_evaluate kaldirildi, JS injection duzeltildi, Turkce surum.\n\n",
);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
