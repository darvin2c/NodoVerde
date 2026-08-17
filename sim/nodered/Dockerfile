# Node-RED + FlowFuse Dashboard 2.0 — MONITOR DE LABORATORIO del simulador (ADR-0017).
# No es producto: solo observa la física (:7751), el ctl (:7750) y el MQTT de laboratorio.
FROM nodered/node-red:5.0.4

USER root
COPY settings.js /data/settings.js
COPY flows.json /data/flows.json
RUN cd /data && npm install @flowfuse/node-red-dashboard && chown -R node-red:node-red /data
USER node-red
