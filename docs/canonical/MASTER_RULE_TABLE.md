# MASTER_RULE_TABLE

**Versión:** 2.0.0 — Reescritura completa ADR_011  
**Fecha:** 2026-03-31  
**Aprobado por:** Juan M Aguilera Leyva — CEO DigiSenda AI LLC  
**Fuentes (en orden de autoridad):**
1. `Estrategia_structured.json` — estructura formal (fuente primaria)
2. `Estrategia Gemini v4.md` — texto verbatim del PDF original (fuente secundaria, `contenido_texto_verbatim`)
3. `Estrategia_canonical.md` — resumen estructurado (fuente terciaria)

**Principio rector:** Solo se incluye lo que está textualmente en las fuentes canónicas.  
Sin interpretación. Sin campos genéricos. Sin valores UNSPECIFIED inventados.

---

## REGISTRO CANÓNICO

| strategy_id | nombre_canónico | posición | temporalidad_principal | status |
|---|---|---|---|---|
| STRAT-01 | Cambio de Tendencia al alza | CALL | H1 / M15 | operative |
| STRAT-02 | Cambio de Tendencia a la baja | PUT | H1 / M15 | operative |
| STRAT-03 | Rebote en punto medio (Bajista) | PUT | D1 / H1 | operative |
| STRAT-04 | Apertura fuera de Bollinger (PUT) | PUT | M15 | operative |
| STRAT-05 | Apertura fuera de Bollinger (CALL) | CALL | M15 | operative |
| STRAT-06 | Efecto Imán (CALL) | CALL | H1 / M15 | **non_operative** |
| STRAT-07 | Efecto Imán (PUT) | PUT | H1 / M15 | **non_operative** |
| STRAT-08 | Cambio tendencia 15 min (CALL) | CALL | M15 | operative |
| STRAT-09 | Cambio tendencia 15 min (PUT) | PUT | M15 | operative |
| STRAT-10 | Ruptura Lateral Mediano Plazo (CALL) | CALL | H1 | operative |
| STRAT-11 | Ruptura Lateral Mediano Plazo (PUT) | PUT | H1 | operative |

---

## STRAT-01 — Cambio de Tendencia al alza

**Fuente primaria:** `Estrategia_structured.json` id=1  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 1  
**Activo de ejemplo:** COIN  
**Posición:** CALL  
**Temporalidad principal:** H1  
**Temporalidad confirmación:** M15  
**Indicadores:** Bollinger Bands (20, 2), Media Móvil 20  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "Trazar una línea de tendencia de trayectoria del precio bordeando levemente por encima la mayor cantidad de puntos posibles de la tendencia bajista."
> "Que el precio rompa esta línea de tendencia"
> "Que el precio rompa la media móvil de 20 períodos en dicha temporalidad y termine con una vela de confirmación alcista."
> "Cambiar a la temporalidad 15 minutos y la tendencia debe mostrarse totalmente alcista."
> "Cuando se cumplan todos estos requisitos tomar una posición en call."

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-01-PC-001 | pre_condition | H1 | Tendencia previa bajista en H1 | h1_trend_bearish |
| STRAT-01-TR-001 | trigger | H1 | Ruptura de línea de tendencia en H1 | h1_trendline_break |
| STRAT-01-TR-002 | trigger | H1 | Cierre sobre la media móvil de 20 periodos en H1 con vela de confirmación alcista | h1_price_above_ma20 |
| STRAT-01-CF-001 | confirmation | M15 | La tendencia en M15 debe mostrarse totalmente alcista | m15_trend_bullish |

### Invalidadores explícitos
Ninguno mencionado en las fuentes canónicas.

### Contexto no operativo (no convierte en regla)
- La ruptura puede ocurrir durante el día o en forma de salto (nota de ocurrencia, no condición evaluable).

---

## STRAT-02 — Cambio de Tendencia a la baja

**Fuente primaria:** `Estrategia_structured.json` id=2  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 2  
**Activo de ejemplo:** QCOM  
**Posición:** PUT  
**Temporalidad principal:** H1  
**Temporalidad confirmación:** M15  
**Indicadores:** Bollinger Bands (20, 2), Media Móvil 20  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "Trazar una línea de tendencia de trayectoria del precio bordeando levemente por debajo la mayor cantidad de puntos posibles de la tendencia alcista."
> "Que el precio rompa esta línea de tendencia"
> "Que el precio rompa la media móvil de 20 periodos en dicha temporalidad y termine con una vela de confirmación bajista."
> "Cambiar a la temporalidad 15 minutos y la tendencia debe mostrarse totalmente bajista."
> "Cuando se cumplan todos estos requisitos tomar una posición en put."

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-02-PC-001 | pre_condition | H1 | Tendencia previa alcista en H1 | h1_trend_bullish |
| STRAT-02-TR-001 | trigger | H1 | Ruptura de línea de tendencia en H1 | h1_trendline_break |
| STRAT-02-TR-002 | trigger | H1 | Cierre bajo la media móvil de 20 periodos en H1 con vela de confirmación bajista | h1_price_below_ma20 |
| STRAT-02-CF-001 | confirmation | M15 | La tendencia en M15 debe mostrarse totalmente bajista | m15_trend_bearish |

### Invalidadores explícitos
Ninguno mencionado en las fuentes canónicas.

### Contexto no operativo
- La ruptura puede ocurrir durante el día o en forma de salto.

---

## STRAT-03 — Rebote en punto medio (Bajista)

**Fuente primaria:** `Estrategia_structured.json` id=3  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 3  
**Activo de ejemplo:** TSLA  
**Posición:** PUT  
**Temporalidad principal:** D1 / H1  
**Temporalidad confirmación:** H1 + M15  
**Indicadores:** Bollinger Bands (20, 2), Media Móvil 20  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "1. Debemos encontrarnos en una tendencia claramente bajista en Bollinger en la temporalidad DIA"
> "2. Debemos encontrarnos en una tendencia claramente alcista en Bollinger en la temporalidad HORA."
> "3. Los precios deben venir en subida acercándose a punto medio en diario o lo que es lo mismo la media móvil de 20 periodos"
> "3. Una vez que el precio toca esta marca verificar que no cruce el punto sino que lo respete, cambiar a la temporalidad 15 MINUTOS y esperar que comience a rebotar"
> "4. En temporalidad hora, esperar vela de confirmación bajista y tomar entrada en put."

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-03-PC-001 | pre_condition | D1 | Tendencia claramente bajista en D1 | d1_trend_bearish |
| STRAT-03-PC-002 | pre_condition | H1 | Tendencia claramente alcista en H1 (retroceso hacia punto medio) | h1_trend_bullish |
| STRAT-03-TR-001 | trigger | D1 | Precio se acerca al punto medio Bollinger en D1 (Media Móvil 20) sin cruzarlo | d1_price_near_bb_middle |
| STRAT-03-CF-001 | confirmation | H1 | Precio respeta el punto medio en H1 sin cruzarlo al alza | h1_price_near_bb_middle |

### Invalidadores explícitos
- Si el precio cruza el punto medio al alza en lugar de respetarlo, la estrategia pierde validez.

### Contexto no operativo
- Cambiar a M15 para observar el inicio del rebote (instrucción de observación, no condición evaluable).

---

## STRAT-04 — Apertura fuera de Bollinger (PUT)

**Fuente primaria:** `Estrategia_structured.json` id=4  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 4  
**Activo de ejemplo:** LI  
**Posición:** PUT  
**Temporalidad principal:** M15  
**Temporalidad confirmación:** M15 (ventana 5 min apertura)  
**Indicadores:** Bollinger Bands (20, 2)  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "En temporalidad 15 minutos en Bollinger la tendencia debe ser totalmente lateral y sin volatilidad"
> "El precio debe aperturar con un salto y quedar extremadamente alejado del oscilador superior, o sea en zona de sobrecompra y observar que comience a bajar."
> "la compra de los contratos put debe ejecutarse en los primeros 5 minutos de la apertura del mercado, ya que pasado este tiempo podría quedar sin efecto la estrategia."
> NOTA: "Es recomendable comenzar el análisis de esta estrategia unos minutos antes de la apertura del mercado para saber que el precio abrirá con un considerable salto a la alza con respecto al precio de cierre del día anterior."

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-04-PC-001 | pre_condition | M15 | La tendencia en M15 debe ser totalmente lateral | m15_trend_lateral |
| STRAT-04-PC-002 | pre_condition | M15 | Sin volatilidad en Bollinger Bands M15 (bandas estrechas) | m15_bb_width_low |
| STRAT-04-TR-001 | trigger | M15 | Apertura con salto extremadamente alejado de la banda superior (sobrecompra) | m15_open_above_upper_bb |

### Invalidadores explícitos
- Si han pasado más de 5 minutos desde la apertura, la estrategia puede quedar sin efecto.

### Contexto no operativo
- Es recomendable analizar minutos antes de la apertura para anticipar el salto (instrucción de preparación humana).
- Ventana operativa: primeros 5 minutos de apertura del mercado.

---

## STRAT-05 — Apertura fuera de Bollinger (CALL)

**Fuente primaria:** `Estrategia_structured.json` id=5  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 5  
**Activo de ejemplo:** AMZN  
**Posición:** CALL  
**Temporalidad principal:** M15  
**Temporalidad confirmación:** M15 (ventana 5 min apertura)  
**Indicadores:** Bollinger Bands (20, 2)  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "En temporalidad 15 minutos en Bollinger la tendencia debe ser totalmente lateral y sin volatilidad"
> "El precio debe aperturar con un salto y quedar extremadamente alejado del oscilador inferior, o sea en zona de sobreventa y observar que comience a subir."
> "la compra de los contratos call debe ejecutarse en los primeros 5 minutos de la apertura del mercado, ya que pasado este tiempo podría quedar sin efecto la estrategia."

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-05-PC-001 | pre_condition | M15 | La tendencia en M15 debe ser totalmente lateral | m15_trend_lateral |
| STRAT-05-PC-002 | pre_condition | M15 | Sin volatilidad en Bollinger Bands M15 (bandas estrechas) | m15_bb_width_low |
| STRAT-05-TR-001 | trigger | M15 | Apertura con salto extremadamente alejado de la banda inferior (sobreventa) | m15_open_below_lower_bb |

### Invalidadores explícitos
- Si han pasado más de 5 minutos desde la apertura, la estrategia puede quedar sin efecto.

### Contexto no operativo
- La rentabilidad suele darse en los primeros 15 minutos de apertura (observación estadística, no condición).

---

## STRAT-06 — Efecto Imán (CALL)

**Fuente primaria:** `Estrategia_structured.json` id=6  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 6  
**Activo de ejemplo:** AAPL  
**Posición:** CALL  
**Temporalidad principal:** H1 (medias móviles) / M15 (Bollinger)  
**Indicadores:** Media Móvil 20, Media Móvil 40, Media Móvil 100, Media Móvil 200 (H1); Bollinger Bands (20, 2) M15; Worden Stochastics (12, %K, 3)  
**Status:** ⛔ NON_OPERATIVE  
**Razón:** Worden Stochastics requiere TC2000 — sin acceso vía API

### Texto verbatim del PDF (fuente de verdad)
> "En las medias móviles, debemos encontrarnos en una tendencia claramente bajista, es decir debe llevar varios días bajando."
> "El precio debe abrir con un fuerte salto a la baja y quedar muy alejado de la media móvil de 20 periodos."
> "En Bollinger en temporalidad 15 minutos la primera vela debe quedar completamente fuera del oscilador."
> "Cuando se comience a formar la vela en indicador volumen, deberá cruzar la línea roja del indicador worden stochastics, esa sería la confirmación de compra de contratos call."

### Reglas documentadas (no evaluables — non_operative)

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute | evaluable |
|---|---|---|---|---|---|
| STRAT-06-PC-001 | pre_condition | H1 | Tendencia claramente bajista en medias móviles, debe llevar varios días bajando | gap_bearish_strong | ⚠️ proxy |
| STRAT-06-TR-001 | trigger | M15 | Primera vela completamente fuera de la banda inferior de Bollinger en M15 | m15_candle_below_lower_bb | ✅ |
| STRAT-06-CF-001 | confirmation | M15 | Cruce de la línea roja del Worden Stochastics al formar la vela en volumen | worden_oversold | ❌ sin API |

### Razón non_operative
La condición de confirmación (STRAT-06-CF-001) requiere Worden Stochastics, indicador exclusivo de TC2000 sin acceso vía API. Sin esta confirmación la estrategia no puede evaluarse de forma completa — activarla generaría señales no validadas y gasto innecesario de tokens.

---

## STRAT-07 — Efecto Imán (PUT)

**Fuente primaria:** `Estrategia_structured.json` id=7  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 7  
**Activo de ejemplo:** GLD  
**Posición:** PUT  
**Temporalidad principal:** H1 (medias móviles) / M15 (Bollinger)  
**Indicadores:** Media Móvil 20, Media Móvil 40, Media Móvil 100, Media Móvil 200 (H1); Bollinger Bands (20, 2) M15; Worden Stochastics (12, %K, 3)  
**Status:** ⛔ NON_OPERATIVE  
**Razón:** Worden Stochastics requiere TC2000 — sin acceso vía API

### Texto verbatim del PDF (fuente de verdad)
> "En las medias móviles, debemos encontrarnos en una tendencia claramente alcista, es decir debe llevar varios días subiendo."
> "El precio debe abrir con un fuerte salto a la alza y quedar muy alejado de la media móvil de 20 periodos."
> "En Bollinger en temporalidad 15 minutos la primera vela debe quedar completamente fuera del oscilador."
> "Cuando se comience a formar la vela en el indicador de volumen, deberá cruzar la línea roja del indicador worden stochastics, esa sería la confirmación de compra de contratos put."

### Reglas documentadas (no evaluables — non_operative)

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute | evaluable |
|---|---|---|---|---|---|
| STRAT-07-PC-001 | pre_condition | H1 | Tendencia claramente alcista en medias móviles, debe llevar varios días subiendo | gap_bullish_strong | ⚠️ proxy |
| STRAT-07-TR-001 | trigger | M15 | Primera vela completamente fuera de la banda superior de Bollinger en M15 | m15_candle_above_upper_bb | ✅ |
| STRAT-07-CF-001 | confirmation | M15 | Cruce de la línea roja del Worden Stochastics al formar la vela en volumen | worden_overbought | ❌ sin API |

### Razón non_operative
Idéntica a STRAT-06. La confirmación requiere Worden Stochastics (TC2000, sin API).

---

## STRAT-08 — Cambio tendencia 15 min (CALL)

**Fuente primaria:** `Estrategia_structured.json` id=8  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 8  
**Activo de ejemplo:** TSLA  
**Posición:** CALL  
**Temporalidad principal:** M15  
**Temporalidad confirmación:** M15 (apertura inmediata)  
**Indicadores:** Bollinger Bands (20, 2), Trendline  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "Debemos encontrarnos en una tendencia bajista o lateral en 15 min"
> "Trazamos una línea de tendencia desde el punto máximo del dia hasta el mínimo por la parte de arriba del precio bordeando la mayor cantidad de puntos posibles"
> "El precio amanece con un salto a la alza rompiendo punto medio y línea de tendencia"
> "De llegar a abrir volatilidad inmediatamente"
> "Tomamos posición en CALL"

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-08-PC-001 | pre_condition | M15 | Tendencia bajista o lateral en M15 | m15_trend_bearish_or_lateral |
| STRAT-08-TR-001 | trigger | M15 | Ruptura de línea de tendencia bajista en M15 | m15_trendline_break |
| STRAT-08-TR-002 | trigger | M15 | Apertura sobre el punto medio de Bollinger en M15 con volatilidad inmediata | m15_price_above_bb_middle |

### Invalidadores explícitos
- Si no hay ruptura simultánea del punto medio y de la línea de tendencia, la estrategia no aplica.

### Contexto no operativo
- La instrucción de trazar la línea de tendencia desde el punto máximo del día es una preparación humana previa (no automatizable).

---

## STRAT-09 — Cambio tendencia 15 min (PUT)

**Fuente primaria:** `Estrategia_structured.json` id=9  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 9  
**Activo de ejemplo:** NFLX  
**Posición:** PUT  
**Temporalidad principal:** M15  
**Temporalidad confirmación:** M15 (apertura inmediata)  
**Indicadores:** Bollinger Bands (20, 2), Trendline  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "Debemos encontrarnos en una tendencia alcista o lateral en 15 min"
> "Trazamos una línea de tendencia desde el punto máximo del dia hasta el máximo por la parte de abajo del precio bordeando la mayor cantidad de puntos posibles"
> "El precio amanece con un salto a la baja rompiendo punto medio y línea de tendencia"
> "De llegar a abrir volatilidad inmediatamente"
> "Tomamos posición en PUT"

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-09-PC-001 | pre_condition | M15 | Tendencia alcista o lateral en M15 | m15_trend_bullish_or_lateral |
| STRAT-09-TR-001 | trigger | M15 | Ruptura de línea de tendencia alcista en M15 | m15_trendline_break |
| STRAT-09-TR-002 | trigger | M15 | Apertura bajo el punto medio de Bollinger en M15 con volatilidad inmediata | m15_price_below_bb_middle |

### Invalidadores explícitos
- Si no hay ruptura simultánea del punto medio y de la línea de tendencia, la estrategia no aplica.

---

## STRAT-10 — Ruptura Lateral Mediano Plazo (CALL)

**Fuente primaria:** `Estrategia_structured.json` id=10  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 10  
**Activo de ejemplo:** BNDX  
**Posición:** CALL  
**Temporalidad principal:** H1  
**Temporalidad confirmación:** H1  
**Indicadores:** Media Móvil 20, Media Móvil 40, Media Móvil 100, Media Móvil 200; Bollinger Bands (20, 2) H1  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "1. Las cuatro medias móviles 20, 40, 100 y 200 periodos deben mostrarse de manera lateral o entrelazadas entre ellas dentro de ese canal lateral, siendo las más predominantes las de 100 y 200 periodos"
> "2. El tiempo en el que el precio debe permanecer dentro de este canal, tiene que ser de 10 días o más (podría llegar a ser de más de 30 días)"
> "3. Debe presentarse una señal alcista que haga que el precio se salga del canal, ya sea en forma de salto o con una vela alcista o extremadamente alcista."
> "4. Esperar confirmación con vela final alcista y tomar acción en call. Esa confirmación debe presentarse en Bollinger Bands en temporalidad HORA con alta volatilidad."

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-10-PC-001 | pre_condition | D1 | Las cuatro medias móviles (20, 40, 100, 200) laterales o entrelazadas en canal de 10+ días | d1_trend_lateral |
| STRAT-10-TR-001 | trigger | H1 | Señal alcista que saque el precio del canal (salto o vela alcista potente) | h1_trendline_break |
| STRAT-10-CF-001 | confirmation | H1 | Confirmación con vela alcista en H1 | h1_trend_bullish |
| STRAT-10-CF-002 | confirmation | H1 | Alta volatilidad en Bollinger Bands en temporalidad H1 | h1_bb_width_high |

### Invalidadores explícitos
Ninguno mencionado en las fuentes canónicas.

### Contexto no operativo
- Las medias 100 y 200 son las predominantes durante el canal (observación visual, ya cubierta por d1_trend_lateral).

---

## STRAT-11 — Ruptura Lateral Mediano Plazo (PUT)

**Fuente primaria:** `Estrategia_structured.json` id=11  
**Fuente verbatim:** `Estrategia Gemini v4.md` página 11  
**Activo de ejemplo:** APPF  
**Posición:** PUT  
**Temporalidad principal:** H1  
**Temporalidad confirmación:** H1  
**Indicadores:** Media Móvil 20, Media Móvil 40, Media Móvil 100, Media Móvil 200; Bollinger Bands (20, 2) H1  
**Status:** operative

### Texto verbatim del PDF (fuente de verdad)
> "1. Las cuatro medias móviles 20, 40, 100 y 200 periodos deben mostrarse de manera lateral o entrelazadas entre ellas dentro de ese canal lateral, siendo las más predominantes las de 100 y 200 periodos"
> "2. El tiempo en el que el precio debe permanecer dentro de este canal, debe ser de 10 días o más (podría llegar a ser de más de 30 días)"
> "3. Debe presentarse una señal bajista que haga que el precio se salga del canal, ya sea en forma de salto o con una vela bajista o extremadamente bajista."
> "4. Esperar confirmación con vela final bajista y tomar acción en put. Esa confirmación debe presentarse en Bollinger Bands en temporalidad HORA con alta volatilidad."

### Reglas operativas

| canonical_id | rule_type | timeframe | condition (verbatim) | regime_attribute |
|---|---|---|---|---|
| STRAT-11-PC-001 | pre_condition | D1 | Las cuatro medias móviles (20, 40, 100, 200) laterales o entrelazadas en canal de 10+ días | d1_trend_lateral |
| STRAT-11-TR-001 | trigger | H1 | Señal bajista que saque el precio del canal (salto o vela bajista potente) | h1_trendline_break |
| STRAT-11-CF-001 | confirmation | H1 | Confirmación con vela bajista en H1 | h1_trend_bearish |
| STRAT-11-CF-002 | confirmation | H1 | Alta volatilidad en Bollinger Bands en temporalidad H1 | h1_bb_width_high |

### Invalidadores explícitos
Ninguno mencionado en las fuentes canónicas.

---

## FILTROS GLOBALES

| canonical_id | condition | source |
|---|---|---|
| GLOBAL-GF-001 | No operar en ventana FED ±2 días hábiles | ADR_004 |
| GLOBAL-GF-002 | No operar en ventana Earnings ±7 días del activo | ADR_004 |

---

## RESUMEN DE REGLAS

| Estrategia | PC | TR | CF | Total | Status |
|---|---|---|---|---|---|
| STRAT-01 | 1 | 2 | 1 | 4 | operative |
| STRAT-02 | 1 | 2 | 1 | 4 | operative |
| STRAT-03 | 2 | 1 | 1 | 4 | operative |
| STRAT-04 | 2 | 1 | — | 3 | operative |
| STRAT-05 | 2 | 1 | — | 3 | operative |
| STRAT-06 | 1 | 1 | 1 | 3 | **non_operative** |
| STRAT-07 | 1 | 1 | 1 | 3 | **non_operative** |
| STRAT-08 | 1 | 2 | — | 3 | operative |
| STRAT-09 | 1 | 2 | — | 3 | operative |
| STRAT-10 | 1 | 1 | 2 | 4 | operative |
| STRAT-11 | 1 | 1 | 2 | 4 | operative |
| GLOBAL | — | — | 2 | 2 | operative |
| **TOTAL** | | | | **40** | 9 operativas / 2 non_op |

PC = pre_condition | TR = trigger | CF = confirmation

---

**Versión:** 2.0.0  
**Reescrito:** 2026-03-31 — ADR_011 FASE A  
**Aprobado por:** Juan M Aguilera Leyva · CEO DigiSenda AI LLC
