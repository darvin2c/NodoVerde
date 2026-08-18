---
name: ordenes-trabajo
description: Órdenes de trabajo del portero — entregar instrucciones y cerrar con complete_work_order
---

# Skill: Órdenes de Trabajo (Fase 3)

Entregas **órdenes de trabajo** creadas por el portero u otros agentes cuando falta dato o se requiere tarea manual.

## Cuándo actuar

- Notificación `[POLICY work_order_created]` / `📋` del bridge
- `list_work_orders({ tenant, status: "pending" })` muestra pendientes
- El humano pregunta "qué tareas hay" / "qué ordenes tengo"

## Flujo

### 1. Entregar la orden

Cuando detectes una orden pendiente (vía notificación o consulta):

1. Lee con `list_work_orders({ tenant, status: "pending" })` si no tienes el detalle.
2. Presenta al humano en español, paso a paso:

> 📋 Orden de trabajo — `mod-3` (tomate) · `kind: medir_ec`
> Instrucciones: "Mide EC con medidor de mano en el tanque de mod-3, enjuaga sensor, 30 s con recirculación prendida, foto del display."
> ID: `w1a2b3...`

Usa las `instructions` tal cual vienen del portero; no inventes pasos.

### 2. Cierre por el humano

Cuando el humano confirme que la hizo ("listo", "hecho", "ya medí", "EC 1.55", foto, etc.):

```
terra-policy complete_work_order({ id, done_by: "chat", note: "<lo reportado por el humano>" })
```

- `note` = resumen de lo que reportó (valor medido, "foto enviada", "calibrado", etc.). Si no reportó detalle, usa "confirmado por chat".
- Confirma: "✅ Orden `...` cerrada. Gracias — dato registrado."

Si el humano reporta un valor (ej. "EC 1.55"), cítalo en la nota: `note: "EC 1.55 mS/cm reportado por humano"`.

### 3. Crear orden manual

Cuando el humano pida registrar una tarea manual ("crea una orden para...", "anota que hay que..."):

```
terra-policy create_work_order({ tenant, module, kind, instructions, created_by: "chat" })
```

- `kind` = tipo corto (ej. `medir_ec`, `foto`, `limpieza`, `calibrar`, `otra`)
- `instructions` = lo que dijo el humano, en español claro
- Luego confirma con el ID creado.

### 4. Consultar

- Pendientes: `list_work_orders({ tenant, status: "pending" })`
- Todas: `list_work_orders({ tenant })`
- Por estado: `list_work_orders({ tenant, status: "done" })` o `cancelled`

Lista con `id`, `module`, `kind`, `instructions`, `status`, `created_at`.

## Herramientas MCP terra-policy

| Tool | Uso |
|---|---|
| `create_work_order({ tenant, module, kind, instructions, created_by })` | Crear orden manual |
| `complete_work_order({ id, done_by, note? })` | Cerrar orden tras confirmación humana |
| `list_work_orders({ tenant?, status? })` | Listar órdenes |

## Reglas

- No cierres una orden sin confirmación humana ("listo"/"hecho" o valor reportado) en el mensaje más reciente.
- `done_by` / `created_by` siempre `"chat"` desde este skill.
- No inventes `tenant`/`module`: usa los de la orden o pregunta si faltan.
- Si la orden pide medición, guía según `oficina-activa` (enjuague, tiempo, foto).
