import { describe, it, expect } from "vitest";
import {
  SENSOR_DEFS,
  SWITCH_DEFS,
  haModuleConfidenceDiscovery,
  haModuleHealthDiscovery,
  buildDiscoveryConfigs,
} from "../src/discovery.js";

const TENANT = "demo";
const MOD = "mod-1";

describe("haModuleConfidenceDiscovery", () => {
  it("topic y unique_id correctos", () => {
    const { topic, payload } = haModuleConfidenceDiscovery(TENANT, MOD);
    expect(topic).toBe(`homeassistant/sensor/terra_${TENANT}_${MOD}_confidence/config`);
    expect(payload.unique_id).toBe(`terra_${TENANT}_${MOD}_confidence`);
  });

  it("state_topic 4 segmentos (terra/tenant/module/confidence)", () => {
    const { payload } = haModuleConfidenceDiscovery(TENANT, MOD);
    expect(payload.state_topic).toBe(`terra/${TENANT}/${MOD}/confidence`);
    expect((payload.state_topic as string).split("/").length).toBe(4);
  });

  it("value_template extrae v", () => {
    const { payload } = haModuleConfidenceDiscovery(TENANT, MOD);
    expect(payload.value_template).toBe("{{ value_json.v }}");
  });

  it("unidad %, icono gauge, nombre", () => {
    const { payload } = haModuleConfidenceDiscovery(TENANT, MOD);
    expect(payload.unit_of_measurement).toBe("%");
    expect(payload.icon).toBe("mdi:gauge");
    expect(payload.name).toBe(`Módulo ${MOD} Confianza`);
  });

  it("payload es JSON válido para HA MQTT sensor", () => {
    const { payload } = haModuleConfidenceDiscovery(TENANT, MOD);
    const json = JSON.stringify(payload);
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.state_topic).toBe(`terra/${TENANT}/${MOD}/confidence`);
    expect(parsed.unique_id).toBeDefined();
  });

  it("device identifiers agrupan por módulo", () => {
    const { payload } = haModuleConfidenceDiscovery(TENANT, MOD);
    const device = payload.device as { identifiers: string[]; name: string };
    expect(device.identifiers).toContain(`terra_${TENANT}_${MOD}`);
    expect(device.name).toBe(`Módulo ${MOD}`);
  });
});

describe("haModuleHealthDiscovery", () => {
  it("topic y unique_id correctos", () => {
    const { topic, payload } = haModuleHealthDiscovery(TENANT, MOD);
    expect(topic).toBe(`homeassistant/sensor/terra_${TENANT}_${MOD}_health/config`);
    expect(payload.unique_id).toBe(`terra_${TENANT}_${MOD}_health`);
  });

  it("state_topic 4 segmentos (terra/tenant/module/health)", () => {
    const { payload } = haModuleHealthDiscovery(TENANT, MOD);
    expect(payload.state_topic).toBe(`terra/${TENANT}/${MOD}/health`);
    expect((payload.state_topic as string).split("/").length).toBe(4);
  });

  it("value_template extrae state", () => {
    const { payload } = haModuleHealthDiscovery(TENANT, MOD);
    expect(payload.value_template).toBe("{{ value_json.state }}");
  });

  it("icono heart-pulse, nombre", () => {
    const { payload } = haModuleHealthDiscovery(TENANT, MOD);
    expect(payload.icon).toBe("mdi:heart-pulse");
    expect(payload.name).toBe(`Módulo ${MOD} Salud`);
  });

  it("sin unidad (estado enumerado)", () => {
    const { payload } = haModuleHealthDiscovery(TENANT, MOD);
    expect(payload.unit_of_measurement).toBeUndefined();
  });

  it("payload es JSON válido para HA MQTT sensor", () => {
    const { payload } = haModuleHealthDiscovery(TENANT, MOD);
    const json = JSON.stringify(payload);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("device identifiers agrupan por módulo (mismo que confidence)", () => {
    const c = haModuleConfidenceDiscovery(TENANT, MOD).payload.device as { identifiers: string[] };
    const h = haModuleHealthDiscovery(TENANT, MOD).payload.device as { identifiers: string[] };
    expect(c.identifiers).toEqual(h.identifiers);
  });
});

describe("buildDiscoveryConfigs incluye módulos", () => {
  it("incluye confidence y health además de sensores y switches", () => {
    const configs = buildDiscoveryConfigs(TENANT, MOD);
    const expected = SENSOR_DEFS.length + SWITCH_DEFS.length + 2;
    expect(configs.length).toBe(expected);
  });

  it("contiene los dos topics de módulo", () => {
    const configs = buildDiscoveryConfigs(TENANT, MOD);
    const topics = configs.map((c) => c.topic);
    expect(topics).toContain(`homeassistant/sensor/terra_${TENANT}_${MOD}_confidence/config`);
    expect(topics).toContain(`homeassistant/sensor/terra_${TENANT}_${MOD}_health/config`);
  });

  it("state_topics de módulo son 4 segmentos, resto 6 segmentos", () => {
    const configs = buildDiscoveryConfigs(TENANT, MOD);
    for (const c of configs) {
      const stateTopic = (c.payload.state_topic as string);
      if (stateTopic.endsWith("/confidence") && !stateTopic.includes("/confidence/confidence")) {
        // módulo confidence (4 seg)
        expect(stateTopic.split("/").length).toBe(4);
        expect(stateTopic).toBe(`terra/${TENANT}/${MOD}/confidence`);
      } else if (stateTopic.endsWith("/health")) {
        expect(stateTopic.split("/").length).toBe(4);
        expect(stateTopic).toBe(`terra/${TENANT}/${MOD}/health`);
      } else {
        // sensores/switches 6 seg
        expect(stateTopic.split("/").length).toBe(6);
      }
    }
  });

  it("todos los payloads son JSON válidos y con unique_id único", () => {
    const configs = buildDiscoveryConfigs(TENANT, MOD);
    const ids = new Set<string>();
    for (const { topic, payload } of configs) {
      expect(topic.startsWith("homeassistant/")).toBe(true);
      expect(topic.endsWith("/config")).toBe(true);
      const json = JSON.stringify(payload);
      expect(() => JSON.parse(json)).not.toThrow();
      const uid = payload.unique_id as string;
      expect(uid).toBeDefined();
      expect(ids.has(uid)).toBe(false);
      ids.add(uid);
    }
  });

  it("value_templates correctos por tipo", () => {
    const configs = buildDiscoveryConfigs(TENANT, MOD);
    const confidence = configs.find((c) => (c.payload.unique_id as string).endsWith("_confidence"));
    const health = configs.find((c) => (c.payload.unique_id as string).endsWith("_health"));
    expect(confidence?.payload.value_template).toBe("{{ value_json.v }}");
    expect(health?.payload.value_template).toBe("{{ value_json.state }}");
  });
});
