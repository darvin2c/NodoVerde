// Builders de Home Assistant discovery (sensor/switch) — publicados por el router.
// Inspirado en sim/src/mqtt.ts pero con identidad resuelta (plano interno, 6 segmentos).
// Plano interno: state_topic = terra/{tenant}/{module}/{device}/{metric}/reading (6 seg)
//                availability = terra/{tenant}/{module}/{device}/status/status (6 seg)
//                command_topic = terra/{tenant}/{module}/{device}/request/set (6 seg)
// Plano plataforma (contrato v0.5.0, 4 segmentos — no pasa por router, lo publican
// servicios de dominio directo al bus interno):
//                terra/{tenant}/{module}/confidence  (confidence global del módulo)
//                terra/{tenant}/{module}/health      (salud del módulo)

import {
  buildInternalReadingTopic,
  buildInternalStatusTopic,
  buildInternalRequestTopic,
} from "./topics.js";

// ---------------------------------------------------------------------------
// Definición de dispositivos por nodo (según ADR-0015 / Contract)
// ---------------------------------------------------------------------------

type SensorDef = {
  device: string;
  metric: string;
  name: string;
  unit?: string;
  deviceClass?: string;
};

type SwitchDef = {
  device: string;
  name: string;
};

// Sensores por nodo
export const SENSOR_DEFS: SensorDef[] = [
  { device: "ec-01", metric: "ec", name: "EC", unit: "mS/cm" },
  { device: "ph-01", metric: "ph", name: "pH" },
  { device: "temp-01", metric: "temp", name: "Water Temp", unit: "°C" },
  { device: "level-01", metric: "level", name: "Tank Level", unit: "%" },
  { device: "flow-01", metric: "flow", name: "Flow", unit: "L/min" },
  { device: "climate-01", metric: "air_temp", name: "Air Temp", unit: "°C" },
  { device: "climate-01", metric: "humidity", name: "Humidity", unit: "%" },
];

// Switches por nodo
export const SWITCH_DEFS: SwitchDef[] = [
  { device: "pump-recirc-01", name: "Pump Recirc" },
  { device: "valve-fill-01", name: "Valve Fill" },
  { device: "doser-a-01", name: "Doser A" },
  { device: "doser-b-01", name: "Doser B" },
  { device: "doser-ph-01", name: "Doser pH" },
];

// ---------------------------------------------------------------------------
// Builders de payload HA
// ---------------------------------------------------------------------------

export function haSensorDiscovery(opts: {
  tenant: string;
  module: string;
  device: string;
  metric: string;
  name: string;
  unit?: string;
  deviceClass?: string;
  moduleName?: string | null;
}): { topic: string; payload: Record<string, unknown> } {
  const deviceId = `${opts.module}-${opts.device}`;
  const uniqueId = `${opts.module}-${opts.device}-${opts.metric}`;
  const stateTopic = buildInternalReadingTopic(opts.tenant, opts.module, opts.device, opts.metric);
  const availabilityTopic = buildInternalStatusTopic(opts.tenant, opts.module, opts.device);
  // Nombre humano del módulo (ADR-0022); fallback honesto al id técnico
  const display = opts.moduleName ?? opts.module;

  const payload: Record<string, unknown> = {
    name: opts.name,
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: "{{ value_json.v }}",
    availability_topic: availabilityTopic,
    payload_available: "online",
    payload_not_available: "offline",
    availability_template: "{{ value_json.state }}",
    device: {
      identifiers: [deviceId],
      name: `${display} ${opts.device}`,
      manufacturer: "terraOS",
      // HA crea el área automáticamente si no existe y agrupa el dispositivo
      suggested_area: display,
    },
  };

  if (opts.unit) payload.unit_of_measurement = opts.unit;
  if (opts.deviceClass) payload.device_class = opts.deviceClass;
  // Todos los sensores llevan state_class measurement excepto switch (que no es sensor)
  payload.state_class = "measurement";

  const topic = `homeassistant/sensor/${uniqueId}/config`;
  return { topic, payload };
}

export function haSwitchDiscovery(opts: {
  tenant: string;
  module: string;
  device: string;
  name: string;
  moduleName?: string | null;
}): { topic: string; payload: Record<string, unknown> } {
  const deviceId = `${opts.module}-${opts.device}`;
  const uniqueId = `${opts.module}-${opts.device}-switch`;
  const stateTopic = buildInternalReadingTopic(opts.tenant, opts.module, opts.device, "switch");
  const commandTopic = buildInternalRequestTopic(opts.tenant, opts.module, opts.device, "set");
  const availabilityTopic = buildInternalStatusTopic(opts.tenant, opts.module, opts.device);
  const display = opts.moduleName ?? opts.module;

  const payload: Record<string, unknown> = {
    name: opts.name,
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: "{{ value_json.v }}",
    command_topic: commandTopic,
    payload_on: "ON",
    payload_off: "OFF",
    state_on: "ON",
    state_off: "OFF",
    availability_topic: availabilityTopic,
    payload_available: "online",
    payload_not_available: "offline",
    availability_template: "{{ value_json.state }}",
    device: {
      identifiers: [deviceId],
      name: `${display} ${opts.device}`,
      manufacturer: "terraOS",
      suggested_area: display,
    },
  };

  const topic = `homeassistant/switch/${uniqueId}/config`;
  return { topic, payload };
}

// ---------------------------------------------------------------------------
// Sensores de módulo — plano plataforma 4 segmentos (contrato v0.5.0)
// Publicados por servicios de dominio (confidence, watchdog) directamente al
// bus interno; el router SOLO publica su discovery HA aquí. Retenidos qos1.
// ---------------------------------------------------------------------------

export function haModuleConfidenceDiscovery(
  tenant: string,
  mod: string,
  moduleName?: string | null,
): { topic: string; payload: Record<string, unknown> } {
  // Contrato v0.5.0: terra/{tenant}/{module}/confidence — 4 segmentos
  const uniqueId = `terra_${tenant}_${mod}_confidence`;
  const stateTopic = `terra/${tenant}/${mod}/confidence`;
  const deviceId = `terra_${tenant}_${mod}`;
  const display = moduleName ?? mod;
  const payload: Record<string, unknown> = {
    name: `${display} Confianza`,
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: "{{ value_json.v }}",
    unit_of_measurement: "%",
    icon: "mdi:gauge",
    state_class: "measurement",
    device: {
      identifiers: [deviceId],
      name: `Módulo ${display}`,
      manufacturer: "terraOS",
      suggested_area: display,
    },
  };
  const topic = `homeassistant/sensor/${uniqueId}/config`;
  return { topic, payload };
}

export function haModuleHealthDiscovery(
  tenant: string,
  mod: string,
  moduleName?: string | null,
): { topic: string; payload: Record<string, unknown> } {
  // Contrato v0.5.0: terra/{tenant}/{module}/health — 4 segmentos
  const uniqueId = `terra_${tenant}_${mod}_health`;
  const stateTopic = `terra/${tenant}/${mod}/health`;
  const deviceId = `terra_${tenant}_${mod}`;
  const display = moduleName ?? mod;
  const payload: Record<string, unknown> = {
    name: `${display} Salud`,
    unique_id: uniqueId,
    state_topic: stateTopic,
    value_template: "{{ value_json.state }}",
    icon: "mdi:heart-pulse",
    device: {
      identifiers: [deviceId],
      name: `Módulo ${display}`,
      manufacturer: "terraOS",
      suggested_area: display,
    },
  };
  const topic = `homeassistant/sensor/${uniqueId}/config`;
  return { topic, payload };
}

// ---------------------------------------------------------------------------
// Builder agregado: todos los discovery para un módulo resuelto
// ---------------------------------------------------------------------------

export function buildDiscoveryConfigs(
  tenant: string,
  mod: string,
  moduleName?: string | null,
): { topic: string; payload: Record<string, unknown> }[] {
  const configs: { topic: string; payload: Record<string, unknown> }[] = [];
  const display = moduleName ?? mod;

  for (const s of SENSOR_DEFS) {
    configs.push(
      haSensorDiscovery({
        tenant,
        module: mod,
        device: s.device,
        metric: s.metric,
        name: `${display} ${s.name}`,
        unit: s.unit,
        deviceClass: s.deviceClass,
        moduleName,
      }),
    );
  }

  for (const sw of SWITCH_DEFS) {
    configs.push(
      haSwitchDiscovery({
        tenant,
        module: mod,
        device: sw.device,
        name: `${display} ${sw.name}`,
        moduleName,
      }),
    );
  }

  // Sensores de módulo (plano plataforma 4 seg) — se publican junto al resto
  // al resolver identidad, en el mismo flujo existente (publishDiscovery).
  configs.push(haModuleConfidenceDiscovery(tenant, mod, moduleName));
  configs.push(haModuleHealthDiscovery(tenant, mod, moduleName));

  return configs;
}
