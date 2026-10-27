// app/src/paper-recompose-worker-entry.mjs
function installMessageHandler(scope, loadCore) {
  let core;
  scope.onmessage = async ({ data }) => {
    if (data?.type !== "prepare" || !Number.isSafeInteger(data.id)) return;
    try {
      core ||= loadCore();
      const { runRequest } = await core;
      const result = await runRequest(data.request);
      scope.postMessage({ id: data.id, type: "result", result });
    } catch (error) {
      scope.postMessage({ id: data.id, type: "error", error: { message: String(error?.message || error), code: error?.code, details: error?.details } });
    }
  };
}
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  installMessageHandler(globalThis, () => import("./paper-recompose-worker-core.mjs"));
}
export {
  installMessageHandler
};
