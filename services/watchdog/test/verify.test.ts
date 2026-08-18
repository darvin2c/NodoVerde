import { describe, it, expect } from "vitest";
import { CrossVerifier } from "../src/verify.js";

function cmdStart(policy = "pol-111", duration = 2000) {
  return { action: "start", policy_id: policy, params: { duration_ms: duration } };
}
function cmdSet(v: string, policy = "pol-111") {
  return { action: "set", policy_id: policy, params: { v } };
}
function cmdStop(policy = "pol-111") {
  return { action: "stop", policy_id: policy };
}

describe("CrossVerifier", () => {
  it("dosis → EC sube = sin alerta", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 10_000;
    v.onReading("demo", "mod-1", "ec", 1.0, now - 100);
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-1"), now);
    v.onReading("demo", "mod-1", "ec", 1.06, now + 500);
    const alerts = v.tick(now + 1000);
    expect(alerts).toHaveLength(0);
  });

  it("dosis → EC plana → expira → alerta critical con detail correcto", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 20_000;
    v.onReading("demo", "mod-1", "ec", 1.0, now - 50);
    v.onCmd("demo", "mod-1", "doser-a-01", { action: "start", policy_id: "pol-xyz", params: { duration_ms: 2000 } }, now);
    v.onReading("demo", "mod-1", "ec", 1.01, now + 500); // delta 0.01 < 0.05 no satisface
    const alerts = v.tick(now + 1000);
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.name).toBe("verification_failed");
    expect(a.severity).toBe("critical");
    expect(a.device).toBe("doser-a-01");
    expect(a.tenant).toBe("demo");
    expect(a.module).toBe("mod-1");
    expect(a.detail.kind).toBe("dose");
    expect(a.detail.policy_id).toBe("pol-xyz");
    expect(a.detail.metric).toBe("ec");
    expect(a.detail.baseline).toBe(1.0);
    expect(a.detail.last).toBe(1.01);
    // detail plano escalares
    expect(typeof a.detail.kind).toBe("string");
    expect(typeof a.detail.metric).toBe("string");
  });

  it("baseline null (sin lectura previa) se fija con primera lectura y no satisface aún", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const t0 = 30_000;
    v.onCmd("demo", "mod-1", "doser-b-01", cmdStart("pol-null"), t0);
    // primera lectura fija baseline
    v.onReading("demo", "mod-1", "ec", 1.5, t0 + 100);
    // tick antes de deadline no debe alertar (aún dentro ventana)
    expect(v.tick(t0 + 500)).toHaveLength(0);
    // sin segunda lectura que supere, debe expirar con baseline=1.5 last=1.5
    const alerts = v.tick(t0 + 1000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail.baseline).toBe(1.5);
    expect(alerts[0].detail.last).toBe(1.5);
  });

  it("baseline null + segunda lectura supera delta = éxito silencioso", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const t0 = 40_000;
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-2"), t0);
    v.onReading("demo", "mod-1", "ec", 1.0, t0 + 100); // fija baseline
    v.onReading("demo", "mod-1", "ec", 1.06, t0 + 200); // satisface
    expect(v.tick(t0 + 1000)).toHaveLength(0);
  });

  it("set OFF y stop no generan expectativa", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 50_000;
    v.onReading("demo", "mod-1", "level", 10, now - 10);
    v.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    v.onReading("demo", "mod-1", "flow", 0, now - 10);
    v.onCmd("demo", "mod-1", "valve-fill-01", cmdSet("OFF", "pol-off"), now);
    v.onCmd("demo", "mod-1", "pump-recirc-01", cmdSet("OFF", "pol-off2"), now);
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStop("pol-stop"), now);
    v.onCmd("demo", "mod-1", "doser-ph-01", cmdStop("pol-stop2"), now);
    expect(v.pendingCount()).toBe(0);
    expect(v.tick(now + 1000)).toHaveLength(0);
  });

  it("payload roto ignorado (no genera expectativa, no rompe)", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 60_000;
    v.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    // @ts-ignore
    v.onCmd("demo", "mod-1", "doser-a-01", "no-json{{", now);
    // @ts-ignore
    v.onCmd("demo", "mod-1", "doser-a-01", Buffer.from("{{{"), now);
    v.onCmd("demo", "mod-1", "doser-a-01", { nonsense: true } as unknown as string, now);
    v.onCmd("demo", "mod-1", "doser-a-01", { action: "unknown", policy_id: "pol-x" } as unknown as string, now);
    expect(v.pendingCount()).toBe(0);
    expect(v.tick(now + 1000)).toHaveLength(0);
  });

  it("payload como Buffer JSON válido sí genera expectativa", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 61_000;
    v.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    const buf = Buffer.from(JSON.stringify(cmdStart("pol-buf")));
    v.onCmd("demo", "mod-1", "doser-a-01", buf as unknown as string, now);
    expect(v.pendingCount()).toBe(1);
    expect(v.tick(now + 1000)).toHaveLength(1);
  });

  it("reemplazo de expectativa por cmd nuevo (misma tenant/module/device)", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const t0 = 70_000;
    v.onReading("demo", "mod-1", "ec", 1.0, t0 - 10);
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-first"), t0);
    // segundo cmd reemplaza, con nuevo policy_id y nuevo deadline
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-second"), t0 + 500);
    expect(v.pendingCount()).toBe(1);
    // primera ventana expira pero ya reemplazada → no alerta aún
    expect(v.tick(t0 + 1000)).toHaveLength(0);
    // debe expirar en t0+1500
    const alerts = v.tick(t0 + 1500);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail.policy_id).toBe("pol-second");
    expect(alerts[0].detail.metric).toBe("ec");
  });

  it("mapping flow: pump-recirc-01 start/set ON → flow up 0.5", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 80_000;
    v.onReading("demo", "mod-1", "flow", 1.0, now - 10);
    v.onCmd("demo", "mod-1", "pump-recirc-01", cmdStart("pol-pump"), now);
    v.onReading("demo", "mod-1", "flow", 1.6, now + 100); // 0.6 delta >0.5
    expect(v.tick(now + 1000)).toHaveLength(0);

    const v2 = new CrossVerifier({ windowMs: 1000 });
    v2.onReading("demo", "mod-1", "flow", 1.0, now - 10);
    v2.onCmd("demo", "mod-1", "pump-recirc-01", cmdSet("ON", "pol-pump2"), now);
    // sin subida suficiente
    v2.onReading("demo", "mod-1", "flow", 1.2, now + 100);
    const alerts = v2.tick(now + 1000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail.metric).toBe("flow");
    expect(alerts[0].detail.kind).toBe("recirc");
    expect(alerts[0].detail.baseline).toBe(1.0);
    expect(alerts[0].detail.last).toBe(1.2);
  });

  it("mapping level: valve-fill-01 start/set ON → level up 1.0", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 90_000;
    v.onReading("demo", "mod-1", "level", 50, now - 10);
    v.onCmd("demo", "mod-1", "valve-fill-01", cmdStart("pol-valve"), now);
    v.onReading("demo", "mod-1", "level", 51.5, now + 200);
    expect(v.tick(now + 1000)).toHaveLength(0);

    const v2 = new CrossVerifier({ windowMs: 1000 });
    v2.onReading("demo", "mod-1", "level", 50, now - 10);
    v2.onCmd("demo", "mod-1", "valve-fill-01", cmdSet("ON", "pol-valve2"), now);
    v2.onReading("demo", "mod-1", "level", 50.5, now + 200);
    const alerts = v2.tick(now + 1000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail.kind).toBe("fill");
    expect(alerts[0].detail.metric).toBe("level");
  });

  it("mapping ph: doser-ph-01 start → ph down 0.05", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 100_000;
    v.onReading("demo", "mod-1", "ph", 6.0, now - 10);
    v.onCmd("demo", "mod-1", "doser-ph-01", cmdStart("pol-ph"), now);
    v.onReading("demo", "mod-1", "ph", 5.94, now + 100); // baja 0.06
    expect(v.tick(now + 1000)).toHaveLength(0);

    const v2 = new CrossVerifier({ windowMs: 1000 });
    v2.onReading("demo", "mod-1", "ph", 6.0, now - 10);
    v2.onCmd("demo", "mod-1", "doser-ph-01", cmdStart("pol-ph2"), now);
    v2.onReading("demo", "mod-1", "ph", 5.98, now + 100); // solo baja 0.02
    const alerts = v2.tick(now + 1000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail.metric).toBe("ph");
    expect(alerts[0].detail.kind).toBe("dose");
  });

  it("doser-a-01 y doser-b-01 ambos mapean a ec", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 110_000;
    v.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-a"), now);
    v.onCmd("demo", "mod-1", "doser-b-01", cmdStart("pol-b"), now);
    expect(v.pendingCount()).toBe(2);
    v.onReading("demo", "mod-1", "ec", 1.06, now + 100);
    // ambos comparten métrica ec, ambos se satisfacen con misma lectura
    expect(v.tick(now + 1000)).toHaveLength(0);
  });

  it("inmunidad a now inyectado: deadlines relativos a now de creación", () => {
    const v = new CrossVerifier({ windowMs: 500 });
    const t0 = 1_000_000;
    v.onReading("demo", "mod-1", "ec", 1.0, t0 - 10);
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-time"), t0);
    expect(v.tick(t0 + 499)).toHaveLength(0);
    // justo en deadline
    const alerts = v.tick(t0 + 500);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].ts).toBe(t0 + 500);
    // segunda llamada no duplica (ya eliminada)
    expect(v.tick(t0 + 600)).toHaveLength(0);
  });

  it("dispositivos con métrica irrelevante no cancelan expectativa", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 120_000;
    v.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    v.onReading("demo", "mod-1", "ph", 6.0, now - 10);
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-ec"), now);
    // reading de ph no debe afectar ec
    v.onReading("demo", "mod-1", "ph", 5.0, now + 100);
    expect(v.tick(now + 1000)).toHaveLength(1);
    // sanity: ec sube sí cancela
    const v2 = new CrossVerifier({ windowMs: 1000 });
    v2.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    v2.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-ec2"), now);
    v2.onReading("demo", "mod-1", "ec", 1.06, now + 100);
    expect(v2.tick(now + 1000)).toHaveLength(0);
  });

  it("detail plano escalares y last null si sin lectura alguna", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 130_000;
    // sin lecturas previas ni posteriores
    v.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-noread"), now);
    const alerts = v.tick(now + 1000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail.baseline).toBeNull();
    expect(alerts[0].detail.last).toBeNull();
    // detail solo escalares
    for (const val of Object.values(alerts[0].detail)) {
      expect(val === null || typeof val === "string" || typeof val === "number").toBe(true);
    }
  });

  it("payload string JSON y objeto directo ambos funcionan", () => {
    const v = new CrossVerifier({ windowMs: 1000 });
    const now = 140_000;
    v.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    const jsonStr = JSON.stringify(cmdStart("pol-str"));
    v.onCmd("demo", "mod-1", "doser-a-01", jsonStr as unknown as string, now);
    expect(v.pendingCount()).toBe(1);
    v.onReading("demo", "mod-1", "ec", 1.06, now + 10);
    expect(v.tick(now + 1000)).toHaveLength(0);

    const v2 = new CrossVerifier({ windowMs: 1000 });
    v2.onReading("demo", "mod-1", "ec", 1.0, now - 10);
    v2.onCmd("demo", "mod-1", "doser-a-01", cmdStart("pol-obj"), now);
    v2.onReading("demo", "mod-1", "ec", 1.06, now + 10);
    expect(v2.tick(now + 1000)).toHaveLength(0);
  });
});
