import { gaussian } from "./model.js";

// Capa de medición: el sim conoce el valor VERDADERO; lo publicado pasa por el
// modelo del instrumento comercial que finge ser (ruido + deriva + cuantización).
// Perfiles calibrados de hojas de datos típicas (Atlas Scientific, DS18B20, HC-SR04).
export type SensorSpec = {
  sigma: number; // ruido gaussiano 1σ por lectura
  driftPerDay: number; // deriva acumulativa desde el arranque (absoluta, o fracción si relative)
  relative?: boolean;
  resolution: number; // cuantización del ADC/sensor
};

export const SENSOR_SPECS: Record<string, SensorSpec> = {
  ec: { sigma: 0.015, driftPerDay: 0.003, relative: true, resolution: 0.01 }, // electrodo EC se ensucia: +0.3%/día
  ph: { sigma: 0.02, driftPerDay: 0.005, resolution: 0.01 }, // electrodo pH envejece hacia arriba
  temp: { sigma: 0.06, driftPerDay: 0, resolution: 0.0625 }, // DS18B20: sin deriva, cuantiza a 1/16 °C
  level: { sigma: 0.8, driftPerDay: 0, resolution: 0.5 }, // ultrasónico: ruidoso, sin deriva
  air_temp: { sigma: 0.15, driftPerDay: 0, resolution: 0.1 },
  humidity: { sigma: 1.5, driftPerDay: 0.1, resolution: 1 }, // higrómetro capacitivo deriva leve
};

// elapsedDays ancla la deriva (determinística, sin estado extra que persistir).
export function measure(
  metric: string,
  trueValue: number,
  elapsedDays: number,
  rng: () => number,
): number {
  const spec = SENSOR_SPECS[metric];
  if (!spec) return trueValue;
  const drift = spec.relative
    ? trueValue * spec.driftPerDay * elapsedDays
    : spec.driftPerDay * elapsedDays;
  const noisy = trueValue + drift + gaussian(rng) * spec.sigma;
  return Number((Math.round(noisy / spec.resolution) * spec.resolution).toFixed(4));
}
