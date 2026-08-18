---
name: aprobaciones
description: Gate humano para acciones del portero — aprobar/rechazar propuestas pendientes vía terra-policy MCP
---

# Skill: Aprobaciones (Fase 3)

Gestionas el **gate humano** del portero. Las acciones supervisadas quedan en `pending` hasta que el humano decida.

## Cuándo actuar

Cuando llegue una notificación del bridge:

- `[POLICY proposal_pending]` / `[POLICY needs_data]` / `🔐` — hay una propuesta esperando
- Mensaje del watchdog/bridge con acción propuesta (módulo, dispositivo, parámetros, razón)
- El humano pregunta "qué está pendiente"

## Flujo

### 1. Notificación entrante

Al recibir `[POLICY ...]` o `🔐` del bridge:

1. La notificación ya trae resumen, pero verifica con `list_pending_actions({ tenant })` si necesitas detalle completo.
2. Presenta al humano en español, conciso:

> 🔐 Acción propuesta — módulo `mod-2` (lechuga)
> Dispositivo `doser-a-01` · `start` { duration_ms: 2000 }
> Razón: EC 1.0 < mínimo 1.2 del perfil (confianza 85%)
> ID: `a1b2c3...` — ¿APRUEBAS o RECHAZAS?

3. Pregunta explícitamente **APRUEBA / RECHAZA**. No asumas.

### 2. Aprobación

Solo si el humano aprueba **explícitamente** en el mensaje más reciente (ej. "sí", "apruebo", "aprueba", "adelante", "ok aprueba"):

```
terra-policy approve_action({ id, decided_by: "chat" })
```

Si el portero responde `needs_data` al aprobar (confianza cayó), informa: "No se pudo aprobar — falta confianza en [métrica]. El portero disparó recolección. Pide medición/foto (ver oficina-activa). La acción queda pending."

Si responde `executed`, confirma: "✅ Aprobada y ejecutada — `policy_id pol-...` → `terra/{tenant}/{module}/{device}/cmd`."

Si responde error (rate limit, ventana horaria, techo duro, serialización), explica el `reason` tal cual.

### 3. Rechazo

Si el humano rechaza explícitamente ("no", "rechaza", "cancela"):

```
terra-policy reject_action({ id, decided_by: "chat", reason: "<motivo si lo dio>" })
```

Confirma: "❌ Rechazada."

### 4. Consulta de pendientes

Si el humano pregunta "qué está pendiente" / "qué hay para aprobar":

```
list_pending_actions({ tenant })
```

Lista cada una con módulo, dispositivo, acción, parámetros, razón, `requested_by` y `created_at`. Si no hay pendientes: "No hay acciones pendientes."

Para historial:

```
list_action_history({ tenant, module, limit: 20 })
```

## Herramientas MCP terra-policy

| Tool | Uso |
|---|---|
| `propose_action` | No la uses aquí (es de expertos). Solo informativa. |
| `approve_action({ id, decided_by })` | Aprobar — solo con confirmación humana explícita |
| `reject_action({ id, decided_by, reason? })` | Rechazar — idem |
| `list_pending_actions({ tenant? })` | Listar pendientes |
| `list_action_history({ tenant?, module?, limit? })` | Historial |

## Reglas inviolables

- **NUNCA apruebes sin confirmación humana explícita en el mensaje más reciente.** Silencio, "quizá", o aprobación de hace 3 turnos no vale.
- No inventes `id`: usa el `action_id` exacto del portero.
- `decided_by` siempre `"chat"` cuando decides desde este skill.
- Si dudas, pregunta de nuevo: "¿Apruebas la acción `...` en `mod-2`?"
- No publiques `cmd` directo: todo pasa por el portero.
