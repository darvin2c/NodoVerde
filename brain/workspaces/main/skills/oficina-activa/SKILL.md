---
name: oficina-activa
description: Qué pedir al humano cuando falta dato — fotos, mediciones manuales EC/pH y cómo registrar respuestas para subir confianza
---

# Skill: Oficina Activa (ADR-0010)

Cuando un módulo está **ciego** (`health.state == "blind"`) o la **confianza por variable < umbral del portero** (EC 70%, pH 70%, nivel 80%), no puedes decidir. Activas oficina: **pides dato al humano, que se vuelve tu sensor.**

## Cuándo activar

- `health.state == "blind"` (todos los sensores del módulo sin dato)
- `health.state == "offline"` o `degraded` con `device_silence`/`device_offline` en sensores críticos
- Confianza por variable por debajo del umbral para la acción que el humano pregunta
- Foto de `cam-01` con >6 h de antigüedad en día caluroso o >24 h en general
- El usuario pregunta algo que requiere dato que no tienes

## Qué pedir (instrucciones concretas)

### Foto del módulo

> "¿Me mandas una foto del módulo 3 (tomate), de arriba y de cerca de las hojas? Con luz natural, sin flash, que se vea el nivel del tanque si puedes."

Cuando llegue la foto:
- Analiza visualmente (si tienes visión) y declara confianza 75% (foto) degradando por edad (semivida 6 h).
- No inventes lectura de EC/pH desde foto.

### Medición manual EC

> "¿Puedes medir el EC del módulo 2 con el medidor de mano? Enjuaga el sensor, sumérgelo 30 s con recirculación prendida, y pásame el valor en mS/cm + una foto del medidor."

Valor humano → confianza base 65% (reporte humano), semivida 2 h.

### Medición manual pH

> "¿Puedes medir el pH del módulo 2 igual que el EC? Calibra si hace >7 días que no calibras. Pásame el valor + foto del display."

Igual: base 65%, semivida 2 h.

### Nivel / temperatura manual

> "¿Qué nivel marca la mirilla del tanque del módulo 1 (en % o cm)? ¿Y temperatura del agua si tienes termómetro?"

Nivel manual base 65%, semivida 10 min (muy volátil).

### Clima

> "¿Cómo está el invernadero ahora — hace calor, viento, sombra? Si tienes termohigrómetro a mano, pásame temp. y HR."

Base 65%, semivida 30 min.

## Cómo registrar la respuesta

1. Agradece y repite el dato: "Anotado: EC 1.55 mS/cm (medición manual tuya, hace 1 min) → confianza 65%."
2. Usa ese dato como referencia en el próximo reporte, citando fuente y frescura.
3. No lo escribas como telemetría de sensor: es `photo` o `reporte humano`, no `ec-01/ec`.
4. Si el humano manda foto, guarda referencia (MinIO en Fase 1 si está disponible, si no cita el chat).
5. Si el dato manual contradice el sensor (ej. sensor dice EC 2.8, humano mide 1.4), declara conflicto y pide recalibración: "Hay discrepancia — sensor 2.8 vs manual 1.4. ¿Cuándo calibraste el ec-01 por última vez?"

## Mensajes modelo

- Pedido inicial: corto, 1 dato a la vez. No pidas 5 cosas a la vez salvo que el módulo esté blind.
- Recordatorio (si no responde en 2 h): "Cuando puedas, me falta el EC del módulo 3 para cerrar el reporte de hoy. Sin ese dato no puedo confirmar si está en rango."
- Cierre: "Gracias — con tu medición la confianza de EC subió de 12% a 65%. Ya puedo comparar contra el perfil (1.2–1.8) y sale dentro de rango."

## Límites

- No insistas más de 2 veces al día por el mismo dato.
- No comandas actuadores aunque ya tengas dato; en Fase 1 solo informas.
- Finanzas no aplica: si preguntan costo, deriva a Fase 2.
