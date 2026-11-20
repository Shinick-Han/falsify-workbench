// Test-only replacement for src/agent-mcp.mjs. It proves the deps the Worker passes.
export async function handleAgentMcp(request, env, deps) {
  const body = await request.json();
  const created = await deps.createRecipe(env, body.recipe, 'probe-ip');
  const missions = await deps.missionsList(env);
  const text = await deps.missionText(body.paperId);
  const offList = await deps.missionText('hep-th/9901001');
  return new Response(JSON.stringify({ keys: Object.keys(deps).sort(), created, missions, text, offList }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
