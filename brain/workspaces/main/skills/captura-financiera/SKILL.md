---
name: captura-financiera
description: Captura de movimientos financieros por chat (texto/foto/voz) — flujo ADR-0011/0027 con confirmación, dedup, evidencia y traza de procedencia
---

# Skill: Captura Financiera (ADR-0011 + ADR-0027)

Capturas **gastos e ingresos** por chat en lenguaje natural, foto de recibo o nota de voz. Todo movimiento queda en el ledger inmutable, con imputación y con traza completa de procedencia.

## Principios

- **Tú no calculas.** Jamás haces aritmética de montos, totales ni repartos. Los repartos los calcula la tool `split_equal`; el registro valida que la suma de montos = total.
- **Dos niveles, nada de cascadas (ADR-0027).** Un movimiento es de **finca** (general: alquiler, luz, equipos — sin módulos) o de **módulos** (reparto en montos). Si el humano no dice módulo y el gasto suena compartido, pregunta: "¿Es de la finca en general o de alguna mesa?"
- **El lote no se pregunta.** El sistema deriva el lote activo de cada módulo y lo graba solo. Si una mesa no tiene lote activo, la tool te devuelve un warning — decláralo ("ojo: mod-3 no tiene lote activo") y confirma.
- **Corrección = edit_movement (anula + recrea atómico).** Nunca edites in-place. `edit_movement` hace la cadena completa en una transacción.
- **Dedup.** Si la tool devuelve `possible_duplicate` (por `external_ref` o mismo monto+categoría hoy), avisa con el MOV existente y pide confirmación antes de reintentar con `force`.
- **Trazabilidad.** Pasa SIEMPRE `channel` (telegram/whatsapp/webchat) y `raw_payload` (el mensaje original verbatim del humano, o la transcripción si fue voz).

## Herramientas (MCP terra-finance :7761/mcp)

| Tool | Escribe | Qué hace |
|---|---|---|
| `register_movement` | **sí** | Registra gasto/ingreso: scope finca/módulos, montos (no pct), dedup, evidencia, `MOV-NNNN`. |
| `split_equal` | no | Reparto a partes iguales en plata (el último absorbe el centavo). Úsala para proponer repartos — nunca calcules tú. |
| `edit_movement` | **sí** | Corrige: anula el original + crea el nuevo con cadena `replaces`, atómico. Acepta `MOV-NNNN`. |
| `void_movement` | **sí** | Anula (espejo negativo). Acepta `MOV-NNNN` (pasa `tenant`). |
| `list_movements` | no | Lista vigentes; filtros: kind, category, module, batch (LOTE-NNNN), scope, mes. |
| `cost_summary` | no | Totales por crop/module/batch/scope/category (SQL). |
| `list_supplies` / `set_supply_cost` | no / **sí** | Costo unitario de insumos. |

Categorías válidas: `nutrientes`, `energia`, `agua`, `plantulas`, `mano_obra`, `empaque`, `transporte`, `venta_cosecha`, `software`, `otro`. `kind` ∈ `gasto` | `ingreso`.

## Campos clave de register_movement

- `scope`: `'finca'` (sin attribution) o `'modulos'` (con attribution). Default: si hay attribution → módulos; si no → finca.
- `attribution`: `[{module, amount}]` — **montos en plata** cuya suma = `amount` total. Ya no porcentajes.
- `occurred_at`: fecha del gasto declarada (ISO) — "gasté ayer 150" → occurred_at = ayer. Default: ahora.
- `external_ref`: número de operación Yape/Plin/banco si el humano lo menciona o la captura lo muestra — dedup fuerte.
- `supplier`: proveedor si el humano lo menciona ("le compré a Agrovet") — texto libre, sin catálogo.
- `evidence_ids`: ids devueltos por el upload de evidencia (ver abajo).
- `channel` + `raw_payload`: obligatorios en tu uso (traza de procedencia).

Si el humano manda el voucher DESPUÉS de haber registrado (ej: registró por voz en el campo y la foto llega en la noche): súbelo con `POST /api/evidence` y enlázalo con `attach_evidence(movement, evidence_id)` — la evidencia es inmutable, solo se adjunta una vez.

Consultas: `list_movements` acepta `search` (op_number, nota, ref, autor, proveedor), `campaign`, `from/to`, `offset`. `cost_summary` acepta `group_by: 'campaign'` y con `group_by: 'batch'` devuelve `yield_kg` y `costo_por_kg` (null honesto si el lote cerró sin declarar kg).

## Flujo por chat

### 1. Extraer datos crudos

Del mensaje / transcripción / OCR de foto extrae sin transformar: `kind`, `amount`, `currency`, `category`, `note`, módulos (si menciona), `occurred_at` relativa ("ayer", "el lunes"), `external_ref` si aparece.

Defaults: `currency` = `PEN`; `occurred_at` = hoy (zona de la finca); `category` = infiere, si dudas pregunta.

### 2. Preguntar solo lo obligatorio — una pregunta a la vez

- Falta `amount` o `category` → pregunta eso.
- Falta saber si es de finca o de módulos → pregunta: "¿De la finca en general o de alguna mesa?"
- Varios módulos sin montos → propón con `split_equal`: "¿Reparto S/300 a partes iguales: mod-1 S/100, mod-2 S/100, mod-3 S/100?" (la tool calcula, tú presentas).

### 3. Confirmar SIEMPRE antes de guardar

> "Registro: gasto S/150 · nutrientes · mod-2 (LOTE-0007) · hoy. ¿Correcto?"

Solo con sí explícito llamas la tool.

### 4. Respuesta

- Éxito → confirma con el número: "Registrado **MOV-0042**". Si hubo warnings (mesa sin lote), decláralos.
- `possible_duplicate` → "Ya existe **MOV-0038** con ese mismo número de operación / mismo monto hoy. ¿Lo registro igual?" → solo con sí, `force: true`.
- Error de validación → explica y pide corrección, una a la vez.

### 5. Correcciones

"Corrige el MOV-0041: eran 180, no 150" → confirma el resumen del cambio → `edit_movement({ id: "MOV-0041", tenant, reason: "monto corregido", kind, amount: 180, ... })`. Jamás edición directa ni borrado.

## Evidencia (foto de recibo, captura de pago, nota de voz, PDF)

Cuando el humano mande un archivo:

1. **Súbelo ANTES de registrar**: `POST http://finance:7761/api/evidence` con el archivo como cuerpo binario y headers:
   - `content-type`: el mime real (image/jpeg, audio/ogg, application/pdf, …)
   - `x-tenant`: tenant activo
   - `x-uploaded-by`: el usuario de chat
   - `x-channel`: telegram/whatsapp/webchat
   - `x-kind`: recibo | captura_pago | factura | audio | foto_producto | otro
   Respuesta 201 → `{ id }` (guárdalo para `evidence_ids`). Respuesta 409 → ya existe ese archivo: avisa ("esta foto ya está en MOV-0038") y reusa el `existing_id`.
2. Extrae del archivo lo legible (monto, fecha, proveedor, nro. de operación → `external_ref`). **No inventes montos borrosos** — pregunta.
3. Registra con `evidence_ids: ["<id>"]` — la evidencia queda enlazada en la misma transacción.
4. Nota de voz: sube el audio original (kind `audio`) y pasa la transcripción como `raw_payload`.

## Ejemplos

**Gasto simple:**
> Humano: "Gasté 150 soles en nutrientes para el mod-2 hoy"
> Tú: "Registro: gasto S/150 · nutrientes · mod-2 · hoy. ¿Correcto?"
> → `register_movement({ kind:"gasto", amount:150, currency:"PEN", category:"nutrientes", attribution:[{module:"mod-2", amount:150}], channel:"telegram", raw_payload:"Gasté 150 soles en nutrientes para el mod-2 hoy", created_by:"<usuario>" })`

**Gasto general de finca:**
> Humano: "Pagué 320 de luz"
> Tú: "¿De la finca en general o de alguna mesa?" → "general"
> → `register_movement({ kind:"gasto", amount:320, category:"energia", scope:"finca", ... })`

**Varios módulos:**
> Humano: "Compré 300 de nutrientes para las tres mesas"
> Tú: llamas `split_equal({ amount:300, modules:["mod-1","mod-2","mod-3"] })` → "Reparto: mod-1 S/100, mod-2 S/100, mod-3 S/100. ¿Correcto?"
> → register con esos montos exactos.

## Qué NO hacer

- No calcules repartos ni totales — usa `split_equal` y deja que la tool valide la suma.
- No imputes a módulos un gasto que el humano declaró general (scope finca), ni al revés.
- No registres sin confirmación explícita.
- No edites ni borres: `edit_movement` o `void_movement`.
- No omitas `channel`/`raw_payload`: sin traza, el movimiento pierde procedencia.
