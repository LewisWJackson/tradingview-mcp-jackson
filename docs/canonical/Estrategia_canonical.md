# Estrategias de Trading para Sistemas RAG

Este documento contiene una base de conocimiento estructurada sobre 11 estrategias de trading de opciones, optimizada para recuperación semántica.

---

## 1. Cambio de Tendencia al alza
### Descripción
Estrategia basada en la ruptura de una tendencia bajista previa utilizando Bandas de Bollinger y medias móviles.
### Condiciones de mercado
- Tendencia previa claramente bajista.
- Análisis en temporalidad de 1 hora (H1).
### Reglas principales
- Trazar línea de tendencia bajista sobre los máximos.
- Ruptura de línea de tendencia y de la media móvil de 20 periodos en H1.
- Confirmación alcista en temporalidad de 15 minutos (M15).
- Posición: CALL.
### Interpretación del gráfico
Muestra a **COIN** rompiendo niveles de resistencia y superando la media móvil, con un incremento del +3.17%.

---

## 2. Cambio de Tendencia a la baja
### Descripción
Captura el inicio de un movimiento bajista tras una tendencia alcista previa.
### Condiciones de mercado
- Tendencia previa alcista.
- Temporalidad de 1 hora.
### Reglas principales
- Trazar línea de tendencia alcista bajo los mínimos.
- Ruptura de línea de tendencia y de la media móvil de 20 en H1.
- Confirmación bajista en M15.
- Posición: PUT.
### Interpretación del gráfico
Gráfico de **QCOM** ilustrando la pérdida de soportes dinámicos y caída hacia los 152.50.

---

## 3. Rebote en punto medio (Tendencia a la baja)
### Descripción
Entrada en corto aprovechando retrocesos a la media en una tendencia bajista macro.
### Condiciones de mercado
- Diario (D1): Bajista.
- Hora (H1): Retroceso alcista hacia la media.
### Reglas principales
- El precio debe tocar la media móvil de 20 en D1 sin romperla al alza.
- Esperar confirmación bajista en H1 y M15.
- Posición: PUT.
### Interpretación del gráfico
**TSLA** respetando la zona de los 444.50 como resistencia antes de retomar la caída.

---

## 4. Tendencia lateral: Apertura fuera de Bollinger (Al alza)
### Descripción
Reversión a la media por sobrecompra extrema en apertura.
### Condiciones de mercado
- M15 lateral y sin volatilidad previa.
### Reglas principales
- Apertura con gap muy por encima de la banda superior de Bollinger.
- Entrada en PUT en los primeros 5 minutos de la sesión.
### Interpretación del gráfico
Apertura violenta al alza seguida de una corrección inmediata hacia el rango previo.

---

## 5. Tendencia lateral: Apertura fuera de Bollinger (A la baja)
### Descripción
Reversión a la media por sobreventa extrema en apertura.
### Condiciones de mercado
- M15 lateral y sin volatilidad.
### Reglas principales
- Apertura con gap muy por debajo de la banda inferior.
- Entrada en CALL en los primeros 5 minutos.
### Interpretación del gráfico
**AMZN** rebotando tras abrir fuera de bandas en un mercado previamente estático.

---

## 6. Efecto Imán: Tendencia bajista
### Descripción
Rebote alcista técnico en una tendencia bajista prolongada.
### Condiciones de mercado
- Tendencia bajista macro.
- Apertura con gap bajista fuerte.
### Reglas principales
- Precio fuera de la banda inferior en M15.
- Confirmación: Cruce alcista en Worden Stochastics.
- Posición: CALL (buscando la media).
### Interpretación del gráfico
**AAPL** alejándose de la media de 20 para luego ser "atraído" nuevamente hacia ella.

---

## 7. Efecto Imán: Tendencia alcista
### Descripción
Corrección bajista tras sobreextensión en tendencia alcista.
### Condiciones de mercado
- Tendencia alcista macro de varios días.
### Reglas principales
- Apertura con gap alcista fuera de bandas en M15.
- Confirmación: Cruce bajista en Worden Stochastics.
- Posición: PUT (regreso a la media).
### Interpretación del gráfico
**GLD** mostrando agotamiento tras un salto alcista excesivo.

---

## 8. Cambio de tendencia al alza (15 min)
### Descripción
Giro alcista intradía basado en volatilidad de apertura.
### Reglas principales
- Ruptura de línea de tendencia bajista del día anterior.
- Apertura sobre el punto medio de Bollinger con alta volatilidad.
- Posición: CALL.
### Interpretación del gráfico
**TSLA** rompiendo estructura descendente justo en la apertura.

---

## 9. Cambio de tendencia a la baja (15 min)
### Descripción
Giro bajista intradía por ruptura de soportes.
### Reglas principales
- Ruptura de línea de tendencia alcista previa.
- Apertura bajo el punto medio de Bollinger con volatilidad.
- Posición: PUT.
### Interpretación del gráfico
**NFLX** perdiendo niveles clave al inicio de la jornada.

---

## 10. Cambio de tendencia Lateral al alza (Mediano Plazo)
### Descripción
Ruptura de canales de acumulación prolongados (10-30 días).
### Condiciones de mercado
- Medias de 100 y 200 periodos entrelazadas.
### Reglas principales
- Salida del canal mediante vela potente o gap.
- Confirmación en H1 con alta volatilidad.
- Posición: CALL.
### Interpretación del gráfico
**BNDX** rompiendo un rango lateral tras semanas de consolidación.

---

## 11. Cambio de tendencia Lateral a la baja (Mediano Plazo)
### Descripción
Ruptura bajista de rangos de consolidación extensos.
### Condiciones de mercado
- Canal lateral de 10+ días.
### Reglas principales
- El precio rompe el soporte inferior del canal.
- Confirmación con volatilidad en H1.
- Posición: PUT.
### Observaciones
Simétrica a la estrategia 10, pero con enfoque en distribución y caída.