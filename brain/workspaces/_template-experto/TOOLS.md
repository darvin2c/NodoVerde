# TOOLS — Notas del entorno

- **MCP `terra-domain`** (read-only): tus herramientas de observación de dominio.
- **MCP `terra-policy`** (portero): tu ÚNICA vía de actuación — `propose_action` por clase de acción (`action_class`), nunca por device id ni `cmd` directo (ADR-0019/0020/0028).
- **Tus módulos:** los de crop `{{ESPECIE}}` o variedades `{{ESPECIE}}_*` según `list_modules` — nunca asumas una lista fija.
- Sin cámaras propias ni otras integraciones: si falta dato, repórtalo al orquestador (él activa oficina activa).
