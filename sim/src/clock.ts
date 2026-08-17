export class SimClock {
  simMs: number;
  speed: number;
  private realStartMs: number;

  constructor(initialSimMs: number, speed = 1) {
    this.simMs = initialSimMs;
    this.speed = speed;
    this.realStartMs = Date.now();
  }

  // avanza dtRealMs (normalmente 1000) → dtSim = dtReal * speed
  tick(dtRealMs: number): number {
    const dtSimMs = dtRealMs * this.speed;
    this.simMs += dtSimMs;
    return dtSimMs;
  }

  // integra: dado dtReal, retorna dtSim en segundos
  dtSimSec(dtRealMs: number): number {
    return (dtRealMs * this.speed) / 1000;
  }

  // para tests: avanzar simMs directo sin real
  advanceSim(dtSimMs: number): void {
    this.simMs += dtSimMs;
  }

  nowSim(): number {
    return this.simMs;
  }

  // horas simuladas helpers
  hour(): number {
    return ((this.simMs / 3_600_000) % 24 + 24) % 24;
  }
}
