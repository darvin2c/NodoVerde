---
type: adr
title: "ADR-0011: Finanzas = registro simple de movimientos categorizados"
description: Gastos e ingresos categorizados con imputación a cultivo; captura por canales (texto/foto/voz); historia inmutable. Supersede ADR-0005
tags: [adr, finanzas, captura, canales]
created: 2026-08-15
status: aceptado
supersedes: ADR-0005
---

# ADR-0011: Finanzas = registro simple de movimientos categorizados

## Contexto

ADR-0005 definió un ledger de doble partida con "gestión completa" (ventas, nómina, inventario). Era respuesta a un problema que aún no existe (contabilidad formal). La pregunta real del negocio es: **¿cuánto cuesta producir y cuánto entra?**

## Decisión

### Modelo: una tabla de movimientos

```
movimiento:
  tipo:        gasto | ingreso
  monto:       decimal
  moneda:      PEN | USD          # campo barato hoy, doloroso después
  categoria:   nutrientes | energia | agua | plantulas | mano_obra |
               empaque | transporte | venta_cosecha | software | otro
  imputacion:  [{ cultivo/modulo, pct }]   # SIEMPRE suma 100%
  descripcion, fecha, evidencia_key (MinIO), registrado_por
  estado:      vigente | anulado
  anula_a:     id (opcional)
```

### Reglas (decididas con el dueño)

1. **Quién registra**: cualquiera con acceso al canal. La identidad del usuario de chat queda en `registrado_por`.
2. **Historia inmutable**: nada se borra ni se edita. Corrección = anulación + nuevo movimiento (`estado: anulado`, `anula_a`).
3. **Imputación obligatoria**: todo movimiento se amarra a cultivo(s), total (100% a uno) o proporcional (porcentajes explícitos que suman 100; el agente propone el reparto, el humano confirma). Sin esto muere el costo-por-kg.
4. **Sin recurrentes en v1**: cada gasto fijo se registra cuando ocurre. (Backlog.)
5. **Sin portero financiero en v1**: los gastos ya ocurrieron cuando se registran; no hay nada que aprobar. Trigger: cuando el agente pueda *iniciar* un gasto (compras online), se activa el portero financiero con umbrales por monto.

### Captura por canales (texto / foto / voz)

1. **Texto**: "gasté 150 en nutriente A" → extracción.
2. **Foto de recibo**: el VLM lee monto, fecha, proveedor. La imagen queda en MinIO como evidencia enlazada.
3. **Nota de voz**: transcripción → mismo flujo que texto (manos ocupadas en campo).

Flujo: **extraer → autocompletar con defaults** (fecha=hoy, moneda=PEN) **→ categorizar automático si confianza alta → preguntar solo lo obligatorio faltante (una pregunta a la vez) → confirmar antes de guardar** ("Registro: gasto S/150 · nutrientes · lechuga mod-2 · hoy. ¿Correcto?").

Guardias: **dedup** (misma foto o mismo monto+fecha+proveedor → "¿ya lo habías registrado?") y **evidencia** (toda foto queda enlazada al movimiento).

### Auto-registro desde actuadores

Cuando el portero ejecuta "dosificar 50ml de nutriente A", el evento genera el movimiento de gasto automáticamente (costo de insumo conocido, imputación al cultivo del módulo). Una sola tabla, dos puertas: automática y por chat. El agente además se auto-contabiliza (tokens → categoría `software`).

### Lo que NO cambia

- **El LLM jamás hace aritmética**: totales, repartos y costo-por-kg los calcula SQL; el agente interpreta.
- **Tablas del agente**: prefijo `agent_*`, jamás duplicando movimientos.

## Backlog financiero (con triggers)

| Pieza | Trigger |
|---|---|
| Doble partida / plan de cuentas | Contador formal o inversionistas lo exijan |
| Recurrentes | El registro mensual manual moleste |
| Portero financiero (umbrales) | Primera forma de gasto iniciado por el agente |
| Inventario valorizado, nómina, presupuestos | El registro simple demuestre no bastar |
| OCR avanzado de recibos | Volumen de recibos lo justifique |

## Puerta de escape

El registro simple es subconjunto estricto del formal: cada movimiento ya tiene monto, fecha, categoría, moneda e imputación. Migrar a doble partida después es carga de datos, no refactor.

## Consecuencias

- Fase 2 del ROADMAP se aligera: registro + consulta por chat + costo por kg.
- Invariante continua (reemplaza "ledger cuadra"): todo movimiento vigente tiene categoría, moneda e imputación que suma 100%.
