import { describe, it, expect } from "vitest";
import { ALERT_REMEDIATION, KNOWN_ALERT_NAMES, remediationFor } from "../src/lib/remediation.ts";

// Contrato: todo tipo de alerta que emite el sistema tiene ficha de remediación completa.
// Lista canónica = nombres que emiten watchdog, router, finance y token-meter.
// Si un servicio añade un tipo nuevo, este test fuerza a escribir su ficha (ADR-0010: guía en código).
const SYSTEM_ALERT_NAMES = [
  "device_silence", "device_frozen", "device_impossible", "device_offline", "device_recovered",
  "module_blind", "module_recovered", "data_gap", "verification_failed",
  "cmd_sin_policy", "invariant_ledger", "budget_tokens"
];

describe("mapa de remediación", () => {
  it("cubre exactamente los tipos de alerta que emite el sistema", () => {
    expect([...KNOWN_ALERT_NAMES].sort()).toEqual([...SYSTEM_ALERT_NAMES].sort());
  });

  it("toda ficha tiene título, explicación, fuente y al menos un paso", () => {
    for (const [name, rem] of Object.entries(ALERT_REMEDIATION)) {
      expect(rem.title.length, `${name}.title`).toBeGreaterThan(3);
      expect(rem.what.length, `${name}.what`).toBeGreaterThan(20);
      expect(rem.source.length, `${name}.source`).toBeGreaterThan(0);
      expect(rem.steps.length, `${name}.steps`).toBeGreaterThan(0);
    }
  });

  it("las fichas no contienen placeholders", () => {
    for (const [name, rem] of Object.entries(ALERT_REMEDIATION)) {
      const blob = `${rem.title} ${rem.what} ${rem.steps.join(" ")}`.toLowerCase();
      expect(blob, name).not.toContain("todo");
      expect(blob, name).not.toContain("tbd");
      expect(blob, name).not.toContain("lorem");
    }
  });

  it("alerta desconocida cae en fallback honesto", () => {
    const rem = remediationFor("alerta_que_no_existe");
    expect(rem.title).toBe("Alerta sin ficha");
    expect(rem.what).toContain("no catalogado");
  });

  it("alerta conocida devuelve su ficha, no el fallback", () => {
    expect(remediationFor("cmd_sin_policy").title).toBe("Comando saltándose al portero");
    expect(remediationFor("invariant_ledger").source).toBe("finance");
  });
});
