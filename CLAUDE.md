# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Flujo Premarket Unificado

### Regla crítica — BB es el indicador primario

> **Sin volatilidad no hay operaciones.** Si `bb.width` es muy estrecho en D1, H1 y M15 simultáneamente → NO operar ese día. Las MAs son contexto, no disparadores. BB manda sobre MAs.

Pesos del análisis: **BB 50% | MAs 30% | Fundamental 20%** (este último es manual — verificar FED ±2 días y Earnings ±7 días antes de ejecutar cualquier operación).

### Modos de operación

| Trigger | Modo | Qué hace |
|---------|------|----------|
| "morning brief" | **Rápido** | `morning_brief` → bias D1/H1/M15 por ticker + estrategias candidatas. ~2 minutos. |
| "checklist" / "ejecuta checklist premarket" / "analiza apertura" / "análisis premarket" / "prepara el análisis" | **Completo** | `morning_brief` → análisis 7 pasos → dibujar líneas → screenshots → estrategias → guardar reporte. ~15-20 minutos. |

### Flujo completo (modo Checklist)

```
1. morning_brief              → recolecta datos D1/H1/M15 de todo el watchlist
2. Análisis 7 pasos           → aplicar checklist por ticker usando los datos del paso 1
3. Dibujar niveles            → draw_shape para BB Middle D1, BB Middle H1, Máx/Mín H1
4. Captura                    → capture_screenshot por ticker
5. Estrategias                → evaluar strategy_candidates del morning_brief
6. Guardar reporte            → premarket_save con el análisis completo
```

**IMPORTANTE:** El paso 1 (`morning_brief`) recolecta todos los datos necesarios para los 7 pasos. No hacer llamadas adicionales a `data_get_study_values` por ticker — usar los datos del morning_brief.

### Checklist Premarket — Flujo Automático

**Trigger:** cuando el usuario escriba cualquiera de estas frases:
- "ejecuta checklist premarket"
- "analiza apertura"
- "checklist"
- "análisis premarket"
- "prepara el análisis"

**Watchlist:** AAPL, NVDA, SPY, QQQ, IWM, DIA

### Indicadores del sistema (los únicos que se usan)
- **Bollinger Bands 20-2-0** → peso 50% del análisis. Indicador primario.
- **SMAs 20 / 40 / 100 / 200** → peso 30% del análisis. Indicador secundario.
- Ambos deben estar visibles en el chart. Si `data_get_study_values` no retorna BB o alguna SMA,
  agregar con `chart_manage_indicator(action:"add", name:"Bollinger Bands")` o
  `chart_manage_indicator(action:"add", name:"Simple Moving Average")` antes de continuar.
- Los valores que retorna `data_get_study_values` para las 4 SMAs se asumen en orden MA20, MA40, MA100, MA200
  (de período más corto a más largo, de mayor a menor valor en tendencia alcista).

### Secuencia por ticker

```
Para cada ticker en [AAPL, NVDA, SPY, QQQ, IWM, DIA]:

  PASO 0 — Setup
    chart_set_symbol(ticker)
    chart_set_timeframe("D")
    data_get_study_values() → verificar que BB y las 4 SMAs están presentes.
    Si falta alguno → chart_manage_indicator para agregarlo.

  PASO 1 — Bollinger Bands D1  [peso 50%]
    (ya en D1 desde PASO 0)
    Leer: BB upper, BB middle, BB lower del data_get_study_values
    Evaluar tendencia D1 con BB:
      - Precio cerca de banda superior y alejándose del middle → tendencia alcista → BB middle = PISO
      - Precio cerca de banda inferior y alejándose del middle → tendencia bajista → BB middle = TECHO
      - Precio oscilando alrededor del middle → lateral
    draw_shape(horizontal_line, precio=BB_middle_D1) → marcar con etiqueta "BB D1 Middle [TECHO/PISO]"

  PASO 2 — Bollinger Bands H1  [peso 50%]
    chart_set_timeframe("60")
    data_get_study_values() → leer BB H1 (upper, middle, lower)
    Evaluar:
      1. ¿Está el precio dentro de las bandas? → [dentro / fuera superior / fuera inferior]
      2. ¿El BB middle H1 constituye techo o piso? (misma lógica que D1 pero en H1)
         → Tenerlo presente como PUNTO DE REBOTE en el análisis intraday
    draw_shape(horizontal_line, precio=BB_middle_H1) → marcar si es techo o piso relevante

  PASO 3 — Medias Móviles D1  [peso 30%]
    chart_set_timeframe("D")
    data_get_study_values() → leer MA20, MA40, MA100, MA200
    Determinar tendencia D1 por posición de precio vs MAs:
      - Precio sobre MA20 > MA40 > MA100 > MA200 (en orden descendente) → ALCISTA
      - Precio bajo MA20 < MA40 < MA100 < MA200 → BAJISTA
      - MAs entrelazadas o cruzadas → LATERAL
    Aplicar reglas de rebote (CRÍTICO):
      - MAs a FAVOR de la tendencia = puntos de rebote → marcarlas
      - MAs en CONTRA de la tendencia = puntos de continuación (el precio las rompe sin rebotar)
      - Si las MAs que marcan tendencia se SEPARAN más → tendencia fortaleciéndose
        (ej. bajista: precio rompe MA20 y llega a MA40 = intento de subida para seguir bajando)
    Identificar las 2 MAs de rebote más próximas al precio actual y reportarlas.

  PASO 4 — Medias Móviles H1 + Máx/Mín reciente  [peso 30%]
    chart_set_timeframe("60")
    data_get_study_values() → leer MA20, MA40, MA100, MA200 en H1
    data_get_ohlcv(summary: true, count: 20) → obtener high y low del rango reciente
    Evaluar tendencia H1:
      - Si MA20/MA40 van en sentido contrario a MA100/MA200 → MA20/MA40 = tendencia a corto plazo
      - Analizar posición del precio vs MAs H1 más cercanas que constituyan piso o techo
      - IMPORTANTE: mientras más separadas las MAs de rebote entre sí, más probable el rebote
    draw_shape(horizontal_line, precio=ohlcv.high) → "TICKER H1 Máx" (verde)
    draw_shape(horizontal_line, precio=ohlcv.low)  → "TICKER H1 Mín" (rojo)
    IMPORTANTE: mientras más antiguo sea el nivel H-line, mayor probabilidad de rebote.

  PASO 5 — Líneas de tendencia
    (mantener el chart en H1 con BB visible)
    capture_screenshot(region: "chart") → visual para marcar trendlines manualmente
    Reportar: en el gráfico BB H1, marcar línea de tendencia conectando la mayor
    cantidad de máximos (bajista) o mínimos (alcista) posibles.
    Si se busca cambio de tendencia en H1 → la ruptura de esa trendline es el trigger.

  PASO 6 — Bid/Ask
    Reportar: "Verificar spread Bid/Ask y calcular spot/strike manualmente antes
    de entrar. El spread debe estar dentro del rango habitual para este activo."

  PASO 7 — Apertura / Premarket
    quote_get(symbol=ticker) → precio actual
    Reportar: precio actual, dirección estimada de apertura (gap up / gap down / flat)
    Identificar hacia dónde apunta el mercado al abrir.
```

### Reglas de análisis — lógica de rebotes (CRÍTICO)

**Bollinger Bands:**
- BB middle D1 = soporte/resistencia dinámica de mayor peso
- Precio dentro de bandas H1 = movimiento normal; fuera de banda = sobreextensión → rebote probable
- BB middle H1 actúa como imán intraday → si precio lo supera con fuerza, confirma dirección

**Medias Móviles:**
- MAs CON la tendencia → constituyen piso (alcista) o techo (bajista) → punto de rebote
- MAs CONTRA la tendencia → el precio las rompe sin rebotar (son puntos de continuación)
- MAs separándose → tendencia fortaleciéndose → no esperar rebote rápido
- MAs H1 más separadas entre sí → mayor fuerza del nivel de rebote
- H-lines de máx/mín: mientras más antiguo el nivel, mayor es su relevancia

### Output esperado por ticker
```
TICKER: AAPL
  BB D1   — Middle: $XXX → [TECHO / PISO / Neutro] | Tendencia BB D1: [Alcista / Bajista / Lateral]
  BB H1   — Precio [dentro / fuera sup / fuera inf] de bandas. Middle H1: $XXX → [TECHO / PISO]
  MAs D1  — Tendencia: [Alcista / Bajista / Lateral]
            Rebotes próximos (a favor tendencia): MA20 @ $XXX | MA40 @ $XXX
            MAs en contra (continuación): MA100 @ $XXX | MA200 @ $XXX
  MAs H1  — Tendencia corto: [Alcista / Bajista / Mixta (MA20/40 vs MA100/200)]
            Rebote más cercano: MAXX @ $XXX (separación vs siguiente: $X.XX)
            Máx reciente: $XXX | Mín reciente: $XXX
  Trendlines — Marcar manualmente en gráfico BB H1 conectando [máximos / mínimos]
  Bid/Ask    — Verificar spread y calcular strike manualmente antes de entrar
  Premarket  — Precio: $XXX | Apertura estimada: [Gap Up / Gap Down / Flat]
  ESTRATEGIAS POSIBLES:
    conditions_met → [STRAT-XX CALL/PUT: descripción corta]
    setup_forming  → [STRAT-XX CALL/PUT: qué falta para activarse]
    watch          → [STRAT-XX CALL/PUT: condición a vigilar]
```

### Paso final — Guardar reporte

Al terminar el checklist completo de los 6 tickers, llamar:
```
premarket_save(content="[reporte completo en markdown]", date="YYYY-MM-DD")
```
El reporte se guarda en `docs/sessions/premarket-YYYY-MM-DD.md` dentro del repo.

### Reglas operativas
- Verificar filtros globales: FED ±2 días hábiles / Earnings ±7 días por ticker
- Ventana válida: 9:30–11:30 AM ET únicamente
- Strike: prima dentro del rango óptimo por ticker (ver rules.json → asset_config)
- Expiración: más cercana. Corte viernes 11:00 AM ET → siguiente semana si ya pasó
- Exit: +12% profit GTC / -25% stop loss GTC (bracket inmediato al entrar)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
