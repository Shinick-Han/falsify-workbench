// Public Confluence gateway only. OAuth client secret, session key and paper records never belong in this file.
// provider is fixed: the workbench has no private D1/R2 record backend in the UI.
// hostedAi opts into server-side RED/BLUE execution with the operator's key. The browser sends a guest
// session and the paper file; there is no login, and no provider key, provider URL or local path is read here.
// A guest session is minted on the first run or apply, not when the page loads. This file holds no guest token.
// Hosted execution is enabled for the deployed operator-funded API.
globalThis.FalsifyCloudConfig = Object.freeze({
  apiBase: 'https://falsify-cloud-api.ai-gongbu.workers.dev',
  provider: 'confluence',
  hostedAi: Object.freeze({
    enabled: true,
    apiBase: 'https://falsify-cloud-api.ai-gongbu.workers.dev'
  }),
  openAccess: Object.freeze({ enabled: true })
});
