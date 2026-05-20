# Plan de Integración — Pinecone RAG + TradingView MCP

**Objetivo:** Conectar el RAG de Pinecone (contexto cualitativo de estrategias) con el flujo de análisis premarket de TradingView MCP para que Claude recupere contexto situacional durante el análisis.

**Estado:** Pendiente de implementar — contexto guardado aquí para continuar sin re-explicar.

---

## Contexto del problema

El sistema actual tiene:
- `rules.json` → reglas estructuradas de las estrategias (STRAT-01 a 11)
- `CLAUDE.md` → flujo de análisis premarket
- TradingView MCP → datos en tiempo real del chart

Lo que **falta** y está en el RAG de Pinecone:
- Contexto cualitativo extenso de CUÁNDO y CÓMO aplicar cada estrategia
- Matices por ticker (comportamiento de AAPL vs NVDA vs SPY en diferentes condiciones de BB)
- Casos históricos y ejemplos de entradas válidas/inválidas
- Lógica de interpretación que no cabe en rules.json

---

## Arquitectura propuesta (Hybrid)

```
Flujo premarket:
  chart data (TradingView MCP)
       ↓
  detección de condición de mercado
  ej: "BB D1 bajista + precio bajo MA20 H1 en NVDA"
       ↓
  query a Pinecone RAG  ← nuevo paso
  "¿qué estrategias y contexto aplican a esta condición?"
       ↓
  respuesta enriquecida con contexto cualitativo del RAG
       ↓
  reporte premarket completo
```

---

## Opciones de implementación (en orden de preferencia)

### OPCIÓN 1 — Pinecone MCP Server (recomendada, menor esfuerzo)

Agregar el MCP server oficial de Pinecone a `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["C:\\Users\\juant\\tradingview-mcp-jackson\\src\\server.js"]
    },
    "pinecone": {
      "command": "npx",
      "args": ["-y", "@pinecone-database/mcp"],
      "env": {
        "PINECONE_API_KEY": "TU_API_KEY_AQUI",
        "PINECONE_INDEX_NAME": "NOMBRE_DEL_INDICE"
      }
    }
  }
}
```

**Qué hace:** Expone herramientas MCP para query/upsert/fetch en Pinecone. Claude las llama directamente durante el análisis.

**Pasos para implementar:**
1. Confirmar que `@pinecone-database/mcp` está disponible: `npx @pinecone-database/mcp --help`
2. Obtener API key de Pinecone y nombre del índice del proyecto de bot trading
3. Editar `~/.claude/.mcp.json` para agregar el servidor
4. Reiniciar sesión de Claude Code y verificar con `tv_health_check` + tool discovery
5. Probar un query manual al índice para validar que devuelve contexto útil
6. Integrar el query en el flujo premarket (PASO nuevo entre PASO 4 y PASO 5)

---

### OPCIÓN 2 — Función nativa en el MCP server (más control, más esfuerzo)

Agregar una herramienta `rag_query_strategy` directamente al `src/server.js` del TradingView MCP. Esta función:
- Recibe condición de mercado como parámetro (ej: `{ticker: "NVDA", bb_d1: "bearish", price_vs_ma20_h1: "below"}`)
- Construye el embedding o query de texto
- Llama a Pinecone API directamente
- Retorna contexto relevante

**Cuándo usar esta opción:** Si el índice de Pinecone está en un proyecto separado con estructura muy específica que el MCP oficial no maneja bien.

**Archivos a modificar:**
- `src/core/` → nuevo archivo `rag.js`
- `src/tools/` → nuevo archivo `rag.js` con definición del tool MCP
- `src/server.js` → registrar el nuevo tool
- `package.json` → agregar dependencia `@pinecone-database/pinecone`

---

### OPCIÓN 3 — Exportar contexto clave al CLAUDE.md (sin infraestructura extra)

Si el RAG tiene contexto estable (no cambia frecuentemente):
- Extraer los fragmentos más importantes por estrategia
- Agregar una sección `## Contexto Cualitativo por Estrategia` al `CLAUDE.md`

**Cuándo usar:** Si el volumen de contexto es manejable (<50 fragmentos) y no necesita actualización dinámica.

---

## Preguntas para resolver en la próxima sesión

Antes de implementar, confirmar con Juan:

1. **¿El índice de Pinecone es dedicado a este sistema de opciones o es compartido con el bot de otro proyecto?**
   - Si compartido → necesitamos metadata filters para separar los namespaces
   - Si dedicado → implementación directa más simple

2. **¿Qué tipo de contenido tiene el RAG?**
   - Reglas de estrategias (texto estructurado)
   - Casos históricos de trades
   - Anotaciones de análisis pasados
   - Otra cosa

3. **¿Cuál es la estructura de los embeddings?** (cómo está vectorizado el contenido)
   - Por frase/párrafo
   - Por estrategia completa
   - Por sesión de trading

4. **¿Qué modelo de embeddings usa el RAG?** (para queries compatibles)

---

## Diseño del query durante el premarket

Una vez implementado, el PASO 5.5 del checklist premarket quedaría así:

```
PASO 5.5 — Consulta RAG (nuevo)
  Construir query string basado en condiciones detectadas:
    "{ticker} | BB D1: {techo/piso} | Tendencia H1: {alcista/bajista/lateral} | 
     Precio vs MA20: {sobre/bajo} | Estrategias candidatas: {STRAT-XX, STRAT-YY}"
  
  pinecone.query(text=query_string, top_k=3)
  → recuperar top 3 fragmentos más relevantes del RAG
  → incluir contexto cualitativo en el reporte del ticker
```

---

## Archivos que se modificarán

| Archivo | Cambio |
|---------|--------|
| `~/.claude/.mcp.json` | Agregar servidor Pinecone (Opción 1) |
| `CLAUDE.md` | Agregar PASO 5.5 con instrucción de query RAG |
| `src/core/rag.js` | Nuevo — solo si se elige Opción 2 |
| `src/tools/rag.js` | Nuevo — solo si se elige Opción 2 |
| `src/server.js` | Modificar — solo si se elige Opción 2 |

---

## Checklist de implementación (para marcar en la próxima sesión)

- [ ] Confirmar respuestas a las 4 preguntas de arriba
- [ ] Elegir Opción 1, 2 o 3
- [ ] Verificar disponibilidad de `@pinecone-database/mcp`
- [ ] Configurar credenciales en `.env` o directamente en `.mcp.json`
- [ ] Agregar servidor a `~/.claude/.mcp.json`
- [ ] Probar query básico al índice
- [ ] Integrar en flujo premarket (PASO 5.5)
- [ ] Ejecutar checklist premarket completo con RAG activo
- [ ] Evaluar calidad del contexto recuperado y ajustar query si necesario
