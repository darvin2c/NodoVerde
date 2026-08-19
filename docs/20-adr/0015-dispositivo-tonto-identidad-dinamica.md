---
type: adr
title: "ADR-0015: Dispositivo tonto — identidad dinámica vía claiming y router"
description: Hardware publica solo por hw_id de fábrica; identidad (tenant/módulo) se asigna en DB vía claiming; router traduce entre plano dispositivo y plano interno
tags: [adr, mqtt, identidad, router, hardware, multi-tenant]
created: 2026-08-16
status: aceptado
---

# ADR-0015: Dispositivo tonto — identidad dinámica vía claiming y router

## Contexto

El hardware de campo (ESP32 + sensores/actuadores) debe ser **tonto**: solo notifica lecturas y actúa cuando se le ordena. La identidad lógica —a qué finca (`tenant`), a qué módulo y qué cultivo atiende— **jamás se quema en el firmware**. Quemar `tenant`/`module`/`cultivo` en el binario obliga a reflashear para mover un nodo entre módulos o fincas, rompe el principio de firmware genérico y no escala a producción (decenas de nodos por finca, reemplazos, préstamos entre fincas).

Principio multi-transporte: el nodo solo sabe **notificar y actuar**. El transporte concreto (WiFi, BLE, LoRa) es intercambiable; el chip no distingue si su lectura viaja por WiFi al broker o por LoRa a un gateway. La identidad lógica vive fuera del fierro, en la plataforma.

ADR-0007 estableció `tenant` en tablas y en topics MQTT, pero no distinguió qué plano lleva `tenant` y cuál no. ADR-0003 definió un bus único MQTT sin separar plano físico de plano lógico. Esta ADR cierra esa brecha.

## Decisión

Se adopta arquitectura de **dos planos MQTT** distinguibles por número de segmentos, unidos por un **router de identidad**:

### Plano dispositivo (lo que publica y escucha el fierro) — 5 segmentos

```
terra/{hw_id}/{device}/{metric}/reading        (sensores; qos según kind — el sim mantiene qos0 para lecturas)
terra/{hw_id}/{device}/{metric}/event
terra/{hw_id}/{device}/status/status           (retained + LWT)
terra/{hw_id}/{device}/confidence/confidence
```

El fierro **escucha** únicamente:

```
terra/{hw_id}/{device}/request/{action}        action ∈ {set, read, capture, calibrate}
```

- `hw_id`: 12 dígitos hexadecimales en minúsculas — MAC de fábrica sin dos puntos. Demo determinístico: `020000000001` .. `020000000004`.
- El hardware **jamás** conoce `tenant`, `module` ni `cultivo`. No los publica, no los suscribe, no los almacena.

### Plano interno (lo que consumen HA, Telegraf, cerebro y Grafana) — 6 segmentos

Idéntico al contrato vigente antes de esta ADR:

```
terra/{tenant}/{module}/{device}/{metric}/reading|event
terra/{tenant}/{module}/{device}/status/status
terra/{tenant}/{module}/{device}/confidence/confidence
terra/{tenant}/{module}/{device}/request/{action}
terra/{tenant}/{module}/{device}/cmd            (portero, futuro)
homeassistant/{component}/{unique_id}/config    (HA discovery — ver abajo)
```

### Claiming: la identidad vive en la DB

```sql
CREATE TABLE IF NOT EXISTS device_identities (
  hw_id      TEXT PRIMARY KEY,               -- MAC sin dos puntos, 12 hex min
  tenant     TEXT NOT NULL,
  module     TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant, module) REFERENCES modules(tenant, id)
);
```

- El dueño **declara** por chat o formulario "este `hw_id` pertenece a `demo/mod-3`". Esa declaración inserta/actualiza una fila en `device_identities`.
- Seed demo: `020000000001→demo/mod-1` ... `020000000004→demo/mod-4` (`claimed_by='seed'`).
- Reasignar un nodo = `UPDATE device_identities SET tenant=..., module=...` — cero reflasheo.

### Router de identidad (componente nuevo, crítico)

Servicio `router/` (TypeScript ESM, deps `mqtt` + `pg`):

- **device→interno:** subscribe al plano dispositivo (`reading`/`event`/`status`/`confidence`); resuelve `hw_id → (tenant, module)` consultando `device_identities` (cache en memoria con refresh); republica en plano interno con payload idéntico; `retain` por kind (status y readings de switches retenidos, resto no). `hw_id` desconocido → log + descartar.
- **interno→device:** subscribe a `terra/+/+/+/request/#`; resuelve `(tenant, module) → hw_id`; republica como `terra/{hw_id}/{device}/request/{action}`, payload intacto, `qos1`.
- **HA discovery:** al resolver un `hw_id` conocido por primera vez, publica configs de discovery (sensores + switches) bajo el plano interno (`state_topic` con 6 segmentos). Dispositivos por nodo: sensores `ec-01` (ec, mS/cm), `ph-01` (ph), `temp-01` (temp, °C), `level-01` (level, %), `flow-01` (flow, L/min), `climate-01` (air_temp °C + humidity %); switches `pump-recirc-01`, `valve-fill-01`, `doser-a-01`, `doser-b-01`, `doser-ph-01`.

Env: `MQTT_URL` (default `mqtt://localhost:1883`), `DATABASE_URL` (default `postgres://terra:changeme@localhost:5432/terra`).

### HA discovery lo publica la plataforma

`homeassistant/{component}/{unique_id}/config` lo publica **el router**, nunca el dispositivo. El fierro no sabe qué es Home Assistant.

### Conectividad ≠ identidad

WiFi y dirección del broker se provisionan por **captive portal** en el primer arranque. Eso es conectividad, no identidad: saber a qué red conectarse no le dice al nodo a qué finca o módulo pertenece. La identidad sigue viviendo solo en `device_identities`.

## Consecuencias

- **Firmware genérico único por diseño.** Un solo binario ESPHome para todos los nodos; la variante por módulo desaparece. Flashear es copiar el mismo firmware; la personalidad la da el claiming.
- **Reasignar nodo = UPDATE en DB, cero reflasheo.** Mover un nodo de `mod-2` a `mod-5` o de una finca a otra no toca el fierro. Útil para reemplazos, préstamos y re-balanceo de carga.
- **El sim emula `hw_id`s de fábrica.** `sim/farms/demo.yaml` describe el mundo por `hw_id` (`modules: [{hw_id: "020000000001", crop: lechuga}, ...]`); el campo `id` anterior se reemplaza por `hw_id` y `tenant` deja de usarse en los topics del sim. El sim publica/escucha solo plano dispositivo (5 segmentos) y ya no publica HA discovery.
- **El router está en el camino crítico de datos.** Sin router no hay telemetría en el plano interno ni comandos hacia el fierro. Debe ser stateless (salvo cache), con reconexión robusta a MQTT y Postgres, y métricas de `hw_id` desconocido / latencia de resolución.

## Limitación honesta

**ESPHome fija el broker MQTT en compile-time.** El captive portal provisiona WiFi, pero no la dirección del broker: `mqtt:` en el YAML ESPHome se resuelve al compilar. En producción la dirección del broker no puede depender de recompilar por finca sin romper el ideal de "un solo binario". Esta ADR **no inventa solución** (no propone DNS fijo, QR con broker, ni mDNS como resuelto): la estrategia para que un firmware genérico descubra el broker de su finca queda como **decisión pendiente del firmware**, a resolver antes del piloto de hardware (Fase 5). Documentar la limitación es preferible a prometer un mecanismo no probado.

### Plan de evaluación (acordado 2026-08-19, ejecutar con hardware real en Fase 5)

Hechos verificados contra la documentación de ESPHome (2026.7.4):

- El componente `qr_code` de ESPHome es **generador** (dibuja un QR de un string fijo en un display), **no escáner**. Provisionar el broker *hacia dentro* del dispositivo vía QR requiere cámara + decodificador: componente custom completo.
- El componente `mqtt` exige `broker:` en compile-time; no hay discovery de servicio mDNS (`_mqtt._tcp`) ni lectura de config desde flash. Cualquiera de esas vías = custom component en C++ que mantenemos nosotros.
- **Excepción nativa**: `broker:` acepta un *hostname* que el ESP32 resuelve por DNS al conectar — la única vía "un solo binario" con firmware 100% YAML stock.
- mDNS **sin auth** es falsificable en LAN (broker impostor → comandos falsos a actuadores físicos); adoptarlo exige auth en Mosquitto.

Orden de experimentos con el primer ESP32 (día 1 del piloto), de menor a mayor costo:

1. **mDNS / hostname** — compilar con `broker: mosquitto.local` y verificar si el ESP32 resuelve el `.local` (mDNS a nivel de resolución de nombre, soportado parcialmente por ESP-IDF, no garantizado por ESPHome) o el DNS de la red. Si resuelve → decisión cerrada con cero código custom; el servidor Mosquitto se anuncia por mDNS.
2. **DNS fijo con router de campo propio** — si (1) falla: `broker: broker.terraos.local`, el router de campo (que de todos modos hay que decidir: WiFi/LoRa/celular) sirve DNS+DHCP y resuelve el nombre a su Mosquitto. Sigue siendo firmware stock.
3. **QR / captive portal extendido (componente custom)** — solo si el piloto demuestra que los nodos deben enchufarse a redes ajenas sin infra propia. Incluye obligatoriamente auth en el broker. Es el mayor costo de mantenimiento: se adopta solo con evidencia del piloto, no por anticipado.

Regla: **no escribir firmware custom hasta que el hardware real demuestre que el hostname no basta.** La decisión es reversible en cualquier momento — el claiming (DB) ya aísla la identidad de la conectividad.

### Requisito multi-transporte (acordado 2026-08-19)

El sistema **debe soportar WiFi, LoRa y celular** como transportes del plano dispositivo. El principio multi-transporte ya estaba declarado arriba ("el chip no distingue si su lectura viaja por WiFi al broker o por LoRa a un gateway"); esta sección fija lo que eso implica:

- **Un binario por transporte, no un binario universal.** ESPHome cubre WiFi nativo y celular con componentes de módem externos; LoRaWAN queda fuera de ESPHome (stack propio o módulo tipo RAK). Lo inviolable se mantiene: los binarios difieren **solo en radio**, jamás en identidad — `tenant`/`module`/`cultivo` siguen viviendo solo en `device_identities`.
- **LoRa termina en gateway.** El nodo LoRa habla LoRaWAN; un gateway (ChirpStack, entra por trigger del backlog) traduce y publica al plano dispositivo MQTT en nombre del nodo, usando el mismo `hw_id`. Para el router y el resto de la plataforma, un nodo LoRa es indistinguible de uno WiFi.
- **Celular fija el broker discovery.** Un nodo celular no puede usar mDNS ni DNS local: necesita un **hostname público fijo** (broker alcanzable vía internet/VPN). Ese mismo hostname sirve para WiFi → el DNS fijo (versión pública) se convierte en la respuesta base del plan de evaluación de arriba, y mDNS queda como conveniencia para redes locales. Los experimentos de Fase 5 deben validar ambos escenarios.
- **LoRa = sensores y actuación lenta, no lazo fino.** LoRaWAN clase A solo recibe downlink tras un uplink y con duty cycle limitado: un `cmd/` puede esperar minutos. Clases de acción aptas por LoRa: relleno de tanque, recirculación programada. No aptas: dosificación fina de pH/nutrientes (ventana de verificación corta). El watchdog debe parametrizar sus ventanas de verificación cruzada **por transporte**; el portero debe conocer el transporte del módulo para rechazar acciones incompatibles. Esta parametrización es prerequisito de código cuando exista el primer nodo LoRa, no antes (regla de admisión).
- **Celular cuesta datos por nodo** y exige auth + TLS en el broker (tránsito por internet). Refuerza la decisión de auth ya necesaria por el riesgo mDNS.

## Enmienda a ADR-0007

Donde ADR-0007 dice "Los topics MQTT incluyen el tenant: `terraos/{tenant}/{parcela}/...`", debe leerse con esta ADR: **los topics del plano dispositivo NO llevan `tenant`** (solo `hw_id`); el `tenant` existe en el **plano interno** (`terra/{tenant}/{module}/...`) y en la DB (`device_identities` + tablas de dominio). El diseño multi-tenant se mantiene — cambia el lugar donde vive el `tenant` en el bus.

## Referencias

- Contrato autoritativo: `contract/asyncapi.yaml` v0.4.0 (ambos planos, schemas y reglas de retained/LWT).
- DB: `infra/db/init.sql` — tabla `device_identities` y seed demo.
- Router: `router/` — servicio de traducción.
- Sim: `sim/farms/demo.yaml` — mundo descrito por `hw_id`.
