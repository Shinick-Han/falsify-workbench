// Public Confluence gateway only. OAuth client secret, session key and paper records never belong in this file.
// provider is fixed: the workbench has no private D1/R2 record backend in the UI.
// hostedAi opts into server-side RED/BLUE execution with the operator's key. The browser still sends only its
// Falsify login session and the paper file; no provider key, provider URL or local path is read here.
// enabled is false by default: an operator must turn it on for the deployment that actually serves the runtime.
globalThis.FalsifyCloudConfig = Object.freeze({
  apiBase: 'https://falsify-cloud-api.ai-gongbu.workers.dev',
  provider: 'confluence',
  hostedAi: Object.freeze({
    enabled: false,
    apiBase: 'https://falsify-cloud-api.ai-gongbu.workers.dev'
  })
});
