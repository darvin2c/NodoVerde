// Tests del routing puro del bridge (ADR-0019) — agente destino por cultivo
import { describe, it, expect } from "vitest";
import { expertAgentId, targetAgents, extractExpertReport } from "../src/route.js";

describe("expertAgentId", () => {
  it("especie simple → experto de la especie", () => {
    expect(expertAgentId("lechuga")).toBe("experto-lechuga");
    expect(expertAgentId("tomate")).toBe("experto-tomate");
  });

  it("variedad (<especie>_<variedad>) → experto de la ESPECIE, no de la variedad", () => {
    expect(expertAgentId("lechuga_romana")).toBe("experto-lechuga");
    expect(expertAgentId("tomate cherry")).toBe("experto-tomate");
  });

  it("normaliza mayúsculas y espacios", () => {
    expect(expertAgentId("  Lechuga_Romana ")).toBe("experto-lechuga");
  });

  it("sin cultivo o nombre inválido → null", () => {
    expect(expertAgentId(null)).toBeNull();
    expect(expertAgentId(undefined)).toBeNull();
    expect(expertAgentId("")).toBeNull();
    expect(expertAgentId("   ")).toBeNull();
    expect(expertAgentId("!!!")).toBeNull();
  });
});

describe("targetAgents", () => {
  it("con cultivo: experto primero, orquestador de respaldo", () => {
    expect(targetAgents("lechuga")).toEqual(["experto-lechuga", "main"]);
  });

  it("sin cultivo: solo orquestador", () => {
    expect(targetAgents(null)).toEqual(["main"]);
  });
});

describe("extractExpertReport", () => {
  it("extrae text/message/result de payloads objeto", () => {
    expect(extractExpertReport({ text: "EC bajo en mod-3" })).toBe("EC bajo en mod-3");
    expect(extractExpertReport({ message: "hola" })).toBe("hola");
    expect(extractExpertReport({ result: "r" })).toBe("r");
    expect(extractExpertReport({ data: { text: "anidado" } })).toBe("anidado");
  });

  it("acepta string plano", () => {
    expect(extractExpertReport("reporte directo")).toBe("reporte directo");
  });

  it("NO_REPLY y vacíos → null (silencio explícito)", () => {
    expect(extractExpertReport("NO_REPLY")).toBeNull();
    expect(extractExpertReport({ text: "no-reply" })).toBeNull();
    expect(extractExpertReport({ text: "   " })).toBeNull();
    expect(extractExpertReport({})).toBeNull();
    expect(extractExpertReport(null)).toBeNull();
    expect(extractExpertReport(42)).toBeNull();
  });
});
