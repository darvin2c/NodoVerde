// Node-RED lab — mínimo. Editor en /, dashboard en /dashboard (FlowFuse Dashboard 2.0).
// Sin auth: servicio de LABORATORIO, solo localhost en compose.
module.exports = {
  flowFile: "flows.json",
  uiHost: "0.0.0.0",
  port: 1880,
  diagnostics: { enabled: false },
  logging: { console: { level: "info", metrics: false, audit: false } },
  exportGlobalContextKeys: false,
};
