// Event page only. The default Pages entry keeps cloud-config.js.
// Public gateway only. Secrets, session keys and paper records never belong in this file.
// provider stays confluence. hostedAi, openAccess and booth are enabled for this page.
globalThis.FalsifyCloudConfig = Object.freeze({
  apiBase: 'https://falsify-cloud-api-event.ai-gongbu.workers.dev',
  provider: 'confluence',
  hostedAi: Object.freeze({
    enabled: true,
    apiBase: 'https://falsify-cloud-api-event.ai-gongbu.workers.dev'
  }),
  openAccess: Object.freeze({ enabled: true }),
  booth: Object.freeze({ enabled: true })
});
