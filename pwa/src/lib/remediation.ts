// Mapa de remediación de alertas (ADR-0010: conocimiento honesto — guía determinística en código, nunca LLM).
// Cada tipo de alerta que el sistema puede emitir tiene: qué está pasando y pasos concretos para solucionar.
// Fuentes: services/watchdog (health/dataGap/verify), router (cmdAlert), services/finance (ledgerInvariant),
// services/token-meter (alert). Añadir un tipo nuevo de alerta exige añadir su entrada aquí (test lo fuerza).

export type Remediation = {
  /** Título humano del tipo de alerta */
  title: string;
  /** Qué está pasando, en lenguaje de finca */
  what: string;
  /** Quién emite la alerta */
  source: string;
  /** Pasos concretos para solucionar, en orden */
  steps: string[];
  /** Acción externa sugerida (opcional) */
  link?: { label: string; href: string };
};

export const ALERT_REMEDIATION: Record<string, Remediation> = {
  device_silence: {
    title: "Sensor en silencio",
    what: "El dispositivo dejó de publicar lecturas. El módulo está parcialmente ciego: la última lectura conocida envejece y la confianza baja.",
    source: "watchdog",
    steps: [
      "Verifica alimentación del nodo (LED del ESP32) en el laboratorio.",
      "Revisa cobertura WiFi del módulo; si el nodo está lejos del router, valora moverlo.",
      "Comprueba el cableado del sensor al ESP32 (sensores Atlas/DS18B20 se aflojan con humedad).",
      "Si el nodo responde pero el sensor no, reemplaza la sonda."
    ],
    link: { label: "Abrir laboratorio del sim", href: "http://localhost:1880/dashboard/lab" }
  },
  device_frozen: {
    title: "Lectura congelada",
    what: "El sensor publica exactamente el mismo valor una y otra vez — casi seguro es un fallo de la sonda o de su canal ADC, no un milagro de estabilidad.",
    source: "watchdog",
    steps: [
      "Compara con una medición manual (medidor portátil EC/pH).",
      "Re-calibra la sonda si el valor manual difiere.",
      "Si sigue clavada, reemplaza la sonda: valor congelado = dato muerto."
    ]
  },
  device_impossible: {
    title: "Lectura físicamente imposible",
    what: "El sensor reportó un valor fuera de rango físico (pH negativo, EC absurda, temperatura imposible). La lectura se descarta: el sistema NO actúa sobre ella.",
    source: "watchdog",
    steps: [
      "Revisa burbujas o suciedad en la sonda (causa #1 de picos imposibles).",
      "Verifica conexión y aislamiento del cable del sensor.",
      "Si persiste, la sonda está dañada: reemplázala."
    ]
  },
  device_offline: {
    title: "Dispositivo offline (LWT)",
    what: "El broker recibió el Last Will del dispositivo: se desconectó sin despedirse. Cero datos de ese dispositivo hasta que vuelva.",
    source: "watchdog",
    steps: [
      "Verifica alimentación del nodo.",
      "Revisa que el broker Mosquitto siga accesible desde la red del módulo.",
      "Si es el nodo completo, revisa el log del emulador/firmware."
    ],
    link: { label: "Abrir laboratorio del sim", href: "http://localhost:1880/dashboard/lab" }
  },
  device_recovered: {
    title: "Dispositivo recuperado",
    what: "El dispositivo volvió a publicar. La confianza del módulo se irá recuperando sola con lecturas nuevas.",
    source: "watchdog",
    steps: ["Nada que hacer — la confianza se recupera con datos nuevos. Si se repite, revisa la causa raíz del corte anterior."]
  },
  module_blind: {
    title: "Módulo ciego",
    what: "Todas las fuentes del módulo están mudas o inválidas. El portero RECHAZA cualquier actuación en este módulo hasta que recupere datos (ADR-0020).",
    source: "watchdog",
    steps: [
      "Prioridad alta: un módulo ciego no puede actuar ni ser actuado.",
      "Verifica alimentación y red del nodo completo.",
      "Mientras esté ciego, opera en oficina activa: toma mediciones manuales y regístralas por chat."
    ]
  },
  module_recovered: {
    title: "Módulo recuperado",
    what: "El módulo volvió a tener fuentes vivas. El portero vuelve a aceptar propuestas cuando la confianza supere el mínimo de cada clase de acción.",
    source: "watchdog",
    steps: ["Verifica que las lecturas post-recuperación sean plausibles antes de aprobar actuaciones."]
  },
  data_gap: {
    title: "Hueco de telemetría",
    what: "Hubo una ventana sin datos (apagado declarado o caída). Si fue pausa honesta de campaña (ADR-0021), es esperado; si no, algo se cayó sin avisar.",
    source: "watchdog",
    steps: [
      "¿Era una pausa declarada (apagado nocturno / caída semanal del protocolo)? Entonces es normal.",
      "Si no fue declarada: revisa qué se cayó (sim, Telegraf o TimescaleDB) y por qué.",
      "El reporte diario declarará el gap automáticamente — no hace falta justificarlo a mano."
    ]
  },
  verification_failed: {
    title: "Comando sin efecto",
    what: "Se ordenó dosificar pero la EC no subió como debía. O la dosificadora no actuó físicamente, o el sensor EC no lo vio. CRÍTICO: el lazo cerrado está roto en ese punto.",
    source: "watchdog (verificación cruzada)",
    steps: [
      "Revisa la dosificadora: ¿tiene nutriente en el depósito? ¿la manguera está sumergida y sin obstruir?",
      "Revisa el sensor EC del módulo: si está congelado o mudo, la verificación no puede ver el efecto.",
      "No apruebes más dosificaciones en este módulo hasta entender qué falló."
    ]
  },
  cmd_sin_policy: {
    title: "Comando saltándose al portero",
    what: "Alguien publicó un comando directo al plano dispositivo sin policy_id válido. Viola ADR-0020: TODA actuación pasa por el portero. El comando fue bloqueado.",
    source: "router",
    steps: [
      "Identifica quién publicó (el detalle trae el topic origen): ¿fue un humano por MQTT directo, un script viejo, o un servicio mal configurado?",
      "Si es un flujo legítimo, muévelo al canal correcto: propose_action del portero o botón de HA (request/).",
      "Si se repite y no sabes quién es, revisa las credenciales del broker: algo no autorizado está publicando."
    ]
  },
  invariant_ledger: {
    title: "Invariante financiera violada",
    what: "El ledger rompió una regla dura (ADR-0011): imputación que no suma 100%, movimiento huérfano o historia alterada. La contabilidad NO es confiable hasta resolverlo.",
    source: "finance",
    steps: [
      "Abre Finanzas y localiza el movimiento problemático (el detalle trae la razón y fingerprint).",
      "NUNCA edites ni borres el movimiento: la corrección es anular + crear uno nuevo (void_movement + register_movement).",
      "Cuando esté corregido, marca esta alerta como resuelta desde aquí."
    ],
    link: { label: "Ir a Finanzas", href: "/finanzas" }
  },
  budget_tokens: {
    title: "Presupuesto de tokens",
    what: "El gasto del cerebro (tokens LLM) superó el techo mensual configurado, o apareció un modelo sin precio conocido. No bloquea nada — informa (ADR-0021).",
    source: "token-meter",
    steps: [
      "Revisa el gasto del mes en Finanzas (categoría software).",
      "Si es modelo desconocido: añade su precio a la tabla de pricing del token-meter.",
      "Si es gasto real alto: decide si subes el techo (config) o reduces superficies del cerebro (menos reportes, otro modelo)."
    ],
    link: { label: "Ir a Finanzas", href: "/finanzas" }
  }
};

export const KNOWN_ALERT_NAMES = Object.keys(ALERT_REMEDIATION);

const FALLBACK: Remediation = {
  title: "Alerta sin ficha",
  what: "Tipo de alerta no catalogado en el mapa de remediación. Revisa el detalle crudo y considera añadir su ficha (src/lib/remediation.ts).",
  source: "desconocido",
  steps: ["Lee el detalle de la alerta.", "Documenta el tipo nuevo en el mapa de remediación."]
};

export function remediationFor(name: string): Remediation {
  return ALERT_REMEDIATION[name] ?? FALLBACK;
}
