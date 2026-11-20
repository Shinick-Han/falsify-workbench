// Stub. S4 owns the real MCP module and replaces this file at merge.
// handleAgentMcp(request, env, deps), deps = {createRecipe, missionsList, missionText} from ./booth-recipes.mjs.
export async function handleAgentMcp(request, env, deps) {
  void request; void env; void deps;
  const body = { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not implemented' } };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
