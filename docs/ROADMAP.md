# Roadmap de Desarrollo — TradingView MCP
**Reconstruido:** 2026-05-20  
**Fuentes:** `docs/DEPURACION MORNING_BRIEF.md`, `docs/pinecone-rag-integration/PLAN.md`, git log

---

## FASE 1 — Unificación morning_brief + checklist ✅ COMPLETADA

> Commit: `12fc071` — 2026-05-20 09:13 AM

### Etapa 1 — morning_brief multi-timeframe
- `src/core/morning.js`: scan D1, H1, M15 por ticker
- Helpers: `extractBB()`, `extractSMAs()`, `bbPosition()`, `maOrder()`
- `screenStrategies()` — screening STRAT-01 a 11
- Output: `bb.width`, `bb_position`, `ma_order`, `strategy_candidates`
- `savePremarketReport()` — guarda en `docs/sessions/`

### Etapa 2 — Triggers unificados en CLAUDE.md
- Tabla de modos: Rápido ("morning brief") / Completo ("checklist")
- Regla crítica: BB es indicador primario, sin volatilidad no hay operaciones
- Flujo completo 7 pasos documentado con output esperado por ticker

### Etapa 3 — Persistencia
- `docs/sessions/` agregado a `.gitignore`
- Tool `premarket_save` operativo

---

## FASE 2 — Verificación end-to-end ✅ COMPLETADA

> Sesión: 2026-05-20 (hoy)

- BB 20-2-0 confirmado visible en chart para todos los tickers
- SMAs 20/40/100/200 confirmados y verificados (MA20 = BB basis en todos los tickers)
- Checklist premarket completo ejecutado: AAPL / NVDA / SPY / QQQ / IWM / DIA
- Draw de niveles (BB D1, BB H1, H1 Máx/Mín) operativo en los 6 tickers
- Screenshots guardados en `screenshots/`
- Reporte guardado en `docs/sessions/premarket-2026-05-20.md`

---

## FASE 3 — Análisis Fundamental Automatizado ✅ COMPLETADA

> Fuente: `docs/DEPURACION MORNING_BRIEF.md` — ítem 4

### Objetivo
Conectar con una fuente de datos externa para eliminar la verificación manual de filtros globales (FED y Earnings) que hoy se hace "verificar manualmente".

### Alcance
- **FED calendar:** detectar automáticamente si hay evento Fed ±2 días hábiles
- **Earnings calendar:** detectar si algún ticker del watchlist tiene earnings ±7 días
- Integrar este check en `morning_brief` como campo `fundamental_filters`
- Si hay filtro activo → reportar en el output con advertencia visible

### Opciones de implementación (a decidir)
| Opción | Fuente | Esfuerzo |
|--------|--------|---------|
| A | Finviz web scraping (mencionado en DEPURACION doc) | Medio |
| B | API pública de earnings (Alphavantage, Polygon.io) | Bajo-Medio |
| C | ICS calendar feed (FED publica calendarios) | Bajo |

### Output esperado en morning_brief
```json
"fundamental_filters": {
  "fed_event": { "active": false, "next": "2026-06-11", "days_away": 22 },
  "earnings": {
    "AAPL": { "active": false, "next": "2026-07-28", "days_away": 69 },
    "NVDA": { "active": false, "next": "2026-05-28", "days_away": 8 }
  }
}
```

### Checklist de implementación
- [ ] Decidir fuente de datos (Finviz / API / ICS)
- [ ] Implementar `src/core/fundamental.js` con `checkFedCalendar()` y `checkEarnings()`
- [ ] Integrar en `morning_brief` como preflight check
- [ ] Agregar bloque `## Filtros Globales` al reporte `premarket_save`
- [ ] Probar con ticker que tenga earnings próximos

---

## FASE 4 — Dashboard / Visualización del Reporte ⏳ PENDIENTE

> Fuente: `docs/DEPURACION MORNING_BRIEF.md` — ítem 5

### Objetivo
Darle mayor visibilidad y usabilidad al reporte premarket diario. Actualmente es un bloque de texto Markdown sin jerarquía visual clara al momento de operación.

### Alcance (a definir)
- **Opción A — Reporte HTML:** Generar versión HTML del premarket con colores por bias (verde/rojo/naranja), tabla de estrategias resaltada, niveles clave en bold
- **Opción B — Terminal table:** Mejorar el output en consola con tablas ASCII y colores ANSI para leer directamente en Claude Code sin abrir archivo
- **Opción C — Resumen de 3 líneas por ticker:** Cabecera compacta al inicio del reporte para lectura rápida antes del análisis detallado

### Prioridad de setup activo
Asegurar que `conditions_met` aparezca siempre al tope del reporte, visible antes de cualquier otra cosa.

### Checklist de implementación
- [ ] Definir formato preferido (A, B o C)
- [ ] Implementar en `savePremarketReport()` o como función separada
- [ ] Probar lectura rápida en condiciones reales de mercado (9:30 AM bajo presión)
- [ ] Iterar hasta que el setup activo sea visible en menos de 3 segundos de lectura

---

## FASE 5 — Pinecone RAG Integration ⏳ PENDIENTE

> Fuente: `docs/pinecone-rag-integration/PLAN.md` (plan completo aquí)

### Objetivo
Conectar el RAG de Pinecone (contexto cualitativo del sistema de opciones) con el flujo premarket para recuperar orientación situacional dinámica durante el análisis.

### Opción elegida
**Opción 1 — Pinecone MCP Server** (`@pinecone-database/mcp`)  
Agregar a `~/.claude/.mcp.json` junto al servidor TradingView.

### Inserción en el flujo
Nuevo **PASO 5.5** entre trendlines (PASO 5) y Bid/Ask (PASO 6):
```
query: "{ticker} | BB D1: {techo/piso} | H1: {alcista/bajista} | 
        Precio vs MA20: {sobre/bajo} | Candidatas: {STRAT-XX}"
pinecone.query(top_k=3) → contexto cualitativo al reporte
```

### Preguntas pendientes de confirmar con Juan ⚠️
1. ¿El índice Pinecone es **dedicado** a opciones o compartido con el bot?
2. ¿Qué **tipo de contenido** tiene el RAG? (reglas, casos históricos, anotaciones)
3. ¿Cuál es la **estructura de los embeddings**? (por frase, por estrategia, por sesión)
4. ¿Qué **modelo de embeddings** usa?

### Checklist de implementación
- [ ] Confirmar respuestas a las 4 preguntas
- [ ] Verificar disponibilidad: `npx @pinecone-database/mcp --help`
- [ ] Configurar credenciales en `.env`
- [ ] Agregar servidor a `~/.claude/.mcp.json`
- [ ] Probar query básico al índice
- [ ] Agregar PASO 5.5 en `CLAUDE.md`
- [ ] Ejecutar checklist completo con RAG activo
- [ ] Evaluar calidad del contexto y ajustar query

---

## Resumen de Estado

| Fase | Descripción | Estado |
|------|-------------|--------|
| 1 | Unificación morning_brief + checklist (Etapas 1-3) | ✅ Completada |
| 2 | Verificación end-to-end (BB + SMAs + checklist completo) | ✅ Completada |
| 3 | Análisis Fundamental Automatizado (Finviz / FED / Earnings) | ✅ Completada |
| 4 | Dashboard / Visualización del reporte | ⏳ Pendiente |
| 5 | Pinecone RAG Integration | ⏳ Pendiente — 4 preguntas previas |

**Próxima fase recomendada:** Fase 3 (más impacto operativo inmediato) o Fase 5 si Juan responde las 4 preguntas del RAG.
