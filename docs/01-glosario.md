---
type: reference
title: Glosario terraOS
description: Qué es cada pieza y concepto del sistema, en lenguaje simple
tags: [terraos, glosario, referencia]
created: 2026-08-15
status: vigente
---

# Glosario

## Piezas del sistema

| Pieza | Qué es | Analogía |
|---|---|---|
| **Simulador (`sim/`)** | Programa TypeScript que finge ser un módulo hidropónico real: EC que cae, pH que deriva, tanque que se vacía | Un videojuego de granja, pero con física real |
| **Mosquitto (MQTT)** | Buzón central de mensajes. Sensores publican, quien quiera escucha | El tablero de anuncios de la finca |
| **Telegraf** | Mensajero que copia cada mensaje del buzón a la base de datos, sin código | El asistente que transcribe los anuncios al cuaderno |
| **TimescaleDB** | Base de datos (Postgres) que guarda historial: cada lectura de sensor, cada gasto, cada decisión | El cuaderno de campo, infinito y con memoria perfecta |
| **MinIO** | Almacén de archivos: fotos de cámaras, imágenes | El archivador de fotos |
| **Home Assistant** | La interfaz visual: tarjetas por dispositivo, gráficas, app móvil, botones para operar manualmente | El tablero de control del invernadero |
| **ESPHome** | Fábrica de firmware: describes el sensor en YAML y genera el programa del ESP32. En desarrollo corre simulado en modo host | El molde con que se fabrican los nodos |
| **OpenClaw** | El cerebro: agente IA que corre 24/7, lee datos, decide y te habla | El administrador que nunca duerme |
| **Policy module (portero)** | Código que revisa cada orden (del cerebro O de un botón humano) antes de tocar una bomba o válvula | El capataz que firma cada orden de trabajo |
| **Watchdog** | Servicio que detecta lo que el dispositivo no sabe de sí mismo: silencios, sensores pegados, válvulas que mienten | El inspector de turno |
| **Grafana** | Gráficas de análisis profundo y alertas de umbral simple | El tablero de instrumentos |
| **PWA terraOS (`pwa/`)** | Portada read-only del sistema (ADR-0014): una pantalla con sistema, módulos, campo, finanzas, pendientes y cámaras | La página de resumen del periódico de la finca |
| **Bridge (`services/bridge/`)** | Servicio delgado que traduce alertas del bus MQTT a mensajes para el cerebro (hooks de OpenClaw). Solo observa: jamás comanda | El mensajero que le avisa al administrador |
| **MCP de dominio (`services/mcp-domain/`)** | Enchufe read-only por el que el cerebro consulta datos reales (telemetría, perfiles, confianza, alertas) | El archivo del cuaderno al que el administrador puede asomarse, pero no escribir |
| **Termómetro (`services/confidence/`)** | Servicio que calcula la confianza por variable y por módulo (fuente × edad) y la publica al bus | El medidor de qué tan seguro está el sistema de lo que sabe |
| **WhatsApp/Telegram** | Tu interfaz conversacional: reportes, fotos, aprobaciones | Tu walkie-talkie con el administrador |

## Conceptos

| Concepto | Qué es |
|---|---|
| **MQTT** | Idioma estándar de IoT: formato de mensajes que sensores y actuadores entienden en todo el mundo |
| **EC (conductividad eléctrica)** | Concentración de nutrientes en el agua (mS/cm). La variable #1 en hidroponía |
| **pH** | Acidez de la solución. Fuera de rango (5.5–6.5), la planta no absorbe nutrientes aunque estén |
| **ET0 / FAO-56** | Evapotranspiración de referencia: cuánta agua pierde el cultivo al día. Open-Meteo la entrega ya calculada |
| **LWT (Last Will)** | "Testamento" MQTT: si un dispositivo muere sin despedirse, el broker publica `offline` por él |
| **Retained** | Mensaje que el broker guarda: quien se conecte ve el último estado al instante |
| **Modos de operación** | Manual (botones HA) → supervisado (agente propone, tú apruebas) → autónomo (por clase de acción) |
| **Perfil de cultivo** | YAML que define un cultivo (rangos EC/pH, ciclo, etapas). Cambiar de cultivo = cambiar de archivo |
| **Termómetro de confianza** | 0–100% por variable y por módulo: qué tan bien conoce el sistema la realidad. Lo calcula software determinístico (fuente × edad), jamás el LLM. El portero exige mínimos para actuar |
| **Orden de trabajo** | Acción manual (podar, trasplantar): el portero la emite, el chat la entrega con instrucciones, tú confirmas, queda registrada |
| **Modo oficina activo** | Sin edge, el agente no espera datos: los pide (fotos, mediciones manuales). Tú eres sus sensores. Una finca sin instrumentar es operable desde el día 1 |
| **Fuentes de conocimiento** | Sensor (95%) > foto (75%) > tu reporte (65%) > dato viejo (decae) > desconocido (0%, declarado, jamás inventado) |
| **Orquestador** | El administrador: habla contigo, lleva las finanzas, coordina expertos. Único que presenta propuestas al portero |
| **Experto por cultivo** | Agente con playbook y memoria propia por cultivo. Aprende de cada ciclo cerrado; propone, jamás ejecuta |
| **Playbook** | Guía Markdown del cultivo: síntomas, plagas, recetas de solución. Lo que carga el experto para volverse especialista |
| **Aprendizaje por ciclo cerrado** | Al terminar la cosecha, el experto destila lecciones a su memoria. Solo cuentan decisiones con resultado conocido |
| **Reloj dual** | El simulador corre a velocidad real (campaña de meses) o acelerado (1 día = 1 minuto) para pruebas |
| **MCP** | Enchufe estándar por el que el cerebro usa herramientas (consultar clima, registrar gasto). Un solo tipo de enchufe |
| **Multi-tenant** | La base de datos nace con "casillero por finca", aunque hoy solo haya una. Cambiarlo después cuesta 10x |
| **Movimiento** | Registro financiero simple: gasto o ingreso con categoría, moneda e imputación a cultivo (ADR-0011). Nada se borra: se anula y se crea uno nuevo |
| **Imputación** | A qué cultivo(s) se carga un gasto/ingreso, en porcentajes que suman 100%. Sin esto no hay costo-por-kg |
| **Captura por canales** | Registrar movimientos por WhatsApp: texto, foto de recibo (la IA lo lee) o nota de voz. El agente extrae, autocompleta y confirma contigo |
| **Interlocks** | Seguros físicos en hardware: aunque todo el software falle, la bomba no enciende en seco |
| **ADR** | Documento que congela una decisión ("elegimos X porque..."). Si cambias de opinión, escribes uno nuevo, no borras el viejo |
| **AsyncAPI** | Documento que define exactamente qué mensajes MQTT existen y su formato. El contrato entre piezas |
| **OKF** | Formato (Google) para que los documentos sean legibles por humanos y por el propio agente IA |
| **Backlog con triggers** | Piezas pospuestas, cada una con su condición de entrada: "Home Assistant entra cuando llegue el primer sensor real" |

## Niveles de prueba

| Nivel | Qué prueba | Duración |
|---|---|---|
| Unitario | Las fórmulas (agua, dinero) | Segundos |
| Integración | Que las piezas se entiendan entre sí | Minutos |
| E2E acelerado | Sistema completo, simulación rápida, semilla fija | ~15 min |
| Campaña 1:1 | El sistema viviendo una temporada en tiempo real (ADR-0021: admite pausas honestas; se mide en días de reloj sim) | Meses |
