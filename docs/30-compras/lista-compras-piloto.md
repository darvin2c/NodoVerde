---
type: guia
title: Lista de compras — Piloto hidropónico Fase 5 (Perú)
description: BOM completo del primer módulo real (electrónica + actuadores + cultivo), con proveedores locales e importación, precios referenciales y notas de instalación
tags: [compras, piloto, hardware, hidroponia, peru]
created: 2026-08-22
status: vigente
---

# Lista de compras — Piloto Fase 5 (1 módulo hidropónico)

Basada en `esphome/nodohidro-esp32dev.yaml` (diseño canónico del nodo, ADR-0015) y los
cultivos del sim (`sim/config/crops/lechuga.yaml`, `tomate.yaml`). Precios referenciales
USD / PEN al 2026-08. **La demo no requiere comprar nada** — el sim emula cada ítem.

---

## 1. Electrónica del nodo (un ESP32 por módulo)

| # | Componente | Detalle técnico | Cant. | ~USD | Dónde en Perú |
|---|---|---|---|---|---|
| 1 | **ESP32 DevKit** (WROOM-32, 38 pines) | `board: esp32dev` | 1 (+1 repuesto) | 5–8 c/u | MTLAB, Hi-Fi SAC (Jr. Paruro, Lima), Electromanía, Tesla Electronic — todas con envío nacional |
| 2 | **ADS1115** (ADC 16-bit I2C, módulo) | Convierte señal analógica EC (A0) y pH (A1) | 1 | 3–6 | Mismas tiendas de electrónica |
| 3 | **Sonda pH + placa acondicionadora** (conector BNC) | DFRobot Gravity pH V2 o equivalente; verificar compatibilidad 3.3V | 1 | 40–60 | MTLAB (sensor pH con sonda BNC); importar DFRobot original vía web oficial/Digikey/Mouser |
| 4 | **Sonda EC + placa** | DFRobot Gravity EC (DFR0300) | 1 | 60–90 | Tesla Electronic (módulo TDS/EC); importar DFRobot para la versión original |
| 5 | **Aislador galvánico analógico** | **Obligatorio**: pH + EC en el mismo tanque sin aislamiento = lecturas erráticas (ground loop) | 1 | 15–25 | Importar (DFRobot SEN0169 o similar) |
| 6 | **DS18B20 sumergible** (sonda inox + cable) | Temp agua, one-wire GPIO4; compensa pH/EC | 1 | 3–5 | Cualquier tienda de electrónica local |
| 7 | **JSN-SR04T** (ultrasónico estanco, cable 2.5 m) | Nivel del tanque | 1 | 8–12 | Tiendas locales / Mercado Libre Perú |
| 8 | **YF-S201** (caudalímetro 1/2") | Tubería de recirculación | 1 | 3–6 | Tiendas locales / Mercado Libre Perú |
| 9 | **SHT31** (módulo I2C) | Clima: temp/HR aire (mismo bus I2C del ADS1115) | 1 | 6–10 | MTLAB / Electromanía |
| 10 | **ESP32-CAM** (o cámara IP barata) | `cam-01`: fotos al cerebro (MinIO) | 1 | 8–12 | Tiendas locales |
| 11 | **Fuente 12V/5A + buck 12V→5V** | Alimenta bombas (12V) y electrónica (5V) | 1 | 8–15 | Ferretería eléctrica / Paruro |

## 2. Actuadores (los 5 del YAML)

| # | Componente | Detalle | Cant. | ~USD | Dónde |
|---|---|---|---|---|---|
| 12 | **Módulo relés 8 canales** (5V, optoacoplados) | pump-recirc, valve-fill, doser-a/b/ph | 1 | 6–10 | Electrónica local |
| 13 | **Bombas peristálticas 12V** (~1.5 ml/s, con manguera) | Dosificadoras nutriente A, B y pH-down | 3 | 12–20 c/u | Mercado Libre Perú / importar |
| 14 | **Bomba sumergible** (caudal según mesa, 12V o 220V) | Recirculación NFT | 1 | 15–30 | Sodimac/Promart o tienda hidroponía (Hidropónika, Hidrohuerto) |
| 15 | **Electroválvula 12V** (1/2", normalmente cerrada) | Relleno del tanque | 1 | 8–15 | Mercado Libre / ferretería |

## 3. Seguridad física (interlocks — no negociable, matriz de dueños)

| # | Componente | Detalle | Cant. | ~USD |
|---|---|---|---|---|
| 16 | **Flotador de nivel** (switch) en serie con la bomba | Bomba jamás enciende en seco, aunque caiga todo el software | 2 | 3–5 c/u |
| 17 | Fusibles + portafusibles | Uno por línea de actuador | 1 set | 5 |

## 4. Montaje y protección

| # | Componente | Cant. | ~USD |
|---|---|---|---|
| 18 | Caja estanca IP65 (≥20×15 cm) para ESP32+ADS1115+relés | 1 | 10–20 |
| 19 | Prensacables M12/M16 | 6–8 | 1 c/u |
| 20 | Cable AWG22, termorretráctil, conectores estancos | 1 kit | 10 |
| 21 | Riel DIN + bornera (montaje prolijo) | 1 | 8 |

## 5. Calibración y consumibles (crítico — ADR-0010, confianza honesta)

| # | Componente | Cant. | ~USD | Dónde |
|---|---|---|---|---|
| 22 | **Buffers pH 4.0 y 7.0** | 1 set | 10–15 | MTLAB / tiendas de instrumentación (Asocie Perú, La Victoria) |
| 23 | **Patrones EC 1.41 y 2.76 mS/cm** (los que asume el YAML) | 1 set | 10–15 | Instrumentación / importar |
| 24 | Solución de almacenamiento KCl (sonda pH) | 1 | 8 | Instrumentación |
| 25 | Solución limpieza de electrodos | 1 | 8 | Instrumentación |

## 6. Cultivo hidropónico (la mesa)

| # | Componente | Detalle | Cant. | ~USD | Dónde en Perú |
|---|---|---|---|---|---|
| 26 | **Sistema NFT** (tubos PVC 4" con tapas, o canales NFT comerciales) | Pendiente 1–2%; para ~30–50 plantas | 1 | 50–150 | Hidropónika, Hidrohuerto, RMR Perú (módulos NFT completos) — o fabricación local con PVC de Sodimac |
| 27 | **Tanque reservorio** 100–200 L (opaco, con tapa) | Depósito de solución nutritiva | 1 | 20–40 | Sodimac/Promart/ferretería |
| 28 | **Canastillas (net pots) 2"** + esponjas de siembra | 1 por planta | 50 | 0.15 c/u | Hidropónika / Hidrohuerto / Mercado Libre |
| 29 | **Solución nutritiva A + B** para verduras de hoja (concentrada, p/200 L) | **Nunca mezclar A y B concentradas**; solo diluidas en el tanque | 1 kit | 15–30 | Hidropónika (kit A-B-C v/hoja 200L), We Grow, Agroplaza |
| 30 | **Ácido pH-down** (p. ej. fosfórico/nítrico grado hidroponía) | Lo dosifica `doser-ph-01` | 1 L | 10–15 | Tiendas hidroponía |
| 31 | **Semillas lechuga** para hidroponía (Batavia, crespa, seda) | Cultivo del sim: `lechuga` | 1–2 sobres | 3–8 | Hidropónika, Hidrohuerto, Landa Produce, agropecuarias de Lambayeque |
| 32 | **Semillas tomate** (segundo cultivo del sim, `tomate`) | Para el segundo módulo/lote | 1 sobre | 3–8 | Idem |
| 33 | **Sustrato de germinación** (lana de roca o coco) + bandejas de germinación | Viveiro antes de trasplantar a NFT | 1 kit | 10–20 | Tiendas hidroponía |

## 7. Infraestructura de red y servidor

| # | Componente | Detalle | ~USD |
|---|---|---|---|
| 34 | Router WiFi dedicado (cobertura al invernadero; sirve DNS para `mqtt.finca.local`) | 1 | 25–50 |
| 35 | Mini PC / Raspberry Pi 5 (8 GB) o PC reutilizada — corre todo el stack docker | 1 | 0–120 |

---

## Totales referenciales

| Escenario | Estimado |
|---|---|
| Piloto con sensores **Gravity/locales** | **~USD 350–500** (electrónica + cultivo + red) |
| Piloto con **Atlas Scientific EZO** (pH+EC ≈ USD 300 el par) | ~USD 650–800 |
| Solo la mesa de cultivo (sin electrónica) | ~USD 100–250 |

## Proveedores Perú — resumen con contacto

### Electrónica (Lima, todas con envío nacional / WhatsApp)

| Tienda | Zona | Web | Fuerte en |
|---|---|---|---|
| **MTLAB** | San Martín de Porres | [mtlab.pe](https://mtlab.pe) | Sensores pH con sonda BNC, módulos maker |
| **Hi-Fi SAC** | Jr. Paruro, Centro de Lima | [hifisac.com](https://hifisac.com) | ESP32, kits, variedad |
| **Electromanía Perú** | Online | [electromania.pe](https://www.electromania.pe) | Placas ESP32, sensores |
| **Tesla Electronic** | Online, envíos | [teslaelectronic.com.pe](https://www.teslaelectronic.com.pe) | TDS/EC, kits Arduino/ESP32 |
| **Asocie Perú** | La Victoria | [asocieperu.com](https://asocieperu.com) | Instrumentación multiparámetro (pH/EC/temp), soluciones de calibración |

> **Jr. Paruro (Cercado de Lima)** es el punto neurálgico de componentes: precios competitivos, stock variable — confirmar por WhatsApp antes de comprar.

### Hidroponía (Lima, envíos a provincias incl. Lambayeque)

| Tienda | Web | Ofrece |
|---|---|---|
| **Hidropónika** | [tienda.hidroponika.com.pe](https://tienda.hidroponika.com.pe) — WhatsApp +51 941 555 012 | Nutrientes A-B-C, semillas, kits, asesoría; envíos a provincia |
| **Hidrohuerto** | [hidrohuerto.com](https://hidrohuerto.com) — WhatsApp +51 978 007 948 | Sistemas NFT, nutrientes, semillas, guías |
| **We Grow** | [wegrow.com.pe](https://wegrow.com.pe) — WhatsApp +51 966 566 650 | Nutrientes, equipos |
| **RMR Perú** | [rmr-peru.com/hidroponia.htm](https://www.rmr-peru.com/hidroponia.htm) | Módulos NFT, soluciones |
| **Agroplaza** | [agroplaza.pe](https://www.agroplaza.pe) | Solución A/B |
| **Sodimac / Promart** | tiendas nacionales | Tanques, PVC, bombas, ferretería |

### Importación (lo que NO conviene comprar local)

Sondas EC/pH originales DFRobot Gravity, aislador galvánico, y —si se escala a
producción— Atlas Scientific EZO: web oficial DFRobot, Digikey, Mouser.
**Evitar clones de AliExpress en sondas**: derivan en semanas y destruyen la
confianza del dato (ADR-0010).

## Notas de instalación

1. **Geografía**: todos los sensores van en la cabecera del tanque (<2 m de cable); el ESP32 en caja IP65 junto a él. Nunca cable entre módulos — cada módulo tiene su nodo y habla por WiFi.
2. **Voltaje**: el ESP32 es 3.3V lógico; verificar que las placas acondicionadoras de pH/EC lo toleren (las Gravity V2 sí).
3. **Aislamiento primero**: instalar el aislador (#5) desde el día 1, no después de ver lecturas erráticas.
4. **Interlocks físicos** (#16–17) se cablean en serie con la carga, **independientes del relé**: funcionan aunque el ESP32 muera.
5. **Calibración de puesta en marcha**: mapear V→mS/cm y V→pH con las soluciones patrón y documentar en acta de instalación (los defaults del YAML son solo de diseño).
6. **Firmware**: compilar `esphome/nodohidro-esp32dev.yaml` con `mqtt_broker` apuntando al hostname del broker (limitación compile-time de ESPHome, plan de evaluación en ADR-0015). WiFi se provisiona por captive portal (`Terra-NodoHidro-Fallback`).
7. **Claiming**: tras el primer arranque, declarar `hw_id` → módulo en la plataforma (chat/PWA). Cero reflasheo para mover el nodo.
