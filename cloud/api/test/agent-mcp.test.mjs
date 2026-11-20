import assert from 'node:assert/strict';
import test from 'node:test';
import {handleAgentMcp, MCP_MAX_BODY, MCP_TOOLS} from '../src/agent-mcp.mjs';

const MISSIONS = [{id: 'ragas', title: 'Ragas', source: 'arxiv', paperId: '2309.15217', license: 'cc-by-4.0', course: 'quick', pageHint: 5, hint: 'Table 1'}];
const PAPER = {paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0', url: 'https://arxiv.org/abs/2309.15217',
  pages: [{page: 1, text: 'first page'}, {page: 5, text: 'Ragas 0.95 0.78 0.70'}]};

function fakeDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    missionsList: async () => MISSIONS,
    missionText: async id => (id === PAPER.paperId ? PAPER : null),
    createRecipe: async (env, recipe, ip) => {
      calls.push({env, recipe, ip});
      return {status: 201, body: {code: 'R-7K3QXM', url: 'https://example.test/event.html#recipe=R-7K3QXM', expiresAt: '2026-11-22T12:00:00.000Z'}};
    },
    ...overrides,
  };
}

function post(body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://api.test/mcp', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers}, body: text});
}

async function rpc(body, deps = fakeDeps(), headers) {
  const response = await handleAgentMcp(post(body, headers), {}, deps);
  const text = await response.text();
  return {response, status: response.status, body: text ? JSON.parse(text) : null};
}

const call = (name, args, id = 3) => ({jsonrpc: '2.0', id, method: 'tools/call', params: {name, arguments: args}});

test('initialize echoes a supported protocol version and falls back otherwise', async () => {
  for (const [asked, expected] of [['2025-03-26', '2025-03-26'], ['2025-06-18', '2025-06-18'], ['2099-01-01', '2025-06-18'], [undefined, '2025-06-18']]) {
    const {status, body, response} = await rpc({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: asked, capabilities: {}, clientInfo: {name: 't', version: '1'}}});
    assert.equal(status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(response.headers.get('Content-Type'), /application\/json/);
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, expected);
    assert.deepEqual(body.result.capabilities, {tools: {}});
    assert.equal(body.result.serverInfo.name, 'falsify-booth');
    assert.match(body.result.instructions, /human/);
    assert.match(body.result.instructions, /cannot submit/);
  }
});

test('notifications/initialized and client responses get 202 with no body', async () => {
  const note = await handleAgentMcp(post({jsonrpc: '2.0', method: 'notifications/initialized'}), {}, fakeDeps());
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
  const reply = await handleAgentMcp(post({jsonrpc: '2.0', id: 9, result: {}}), {}, fakeDeps());
  assert.equal(reply.status, 202);
});

test('ping and tools/list', async () => {
  assert.deepEqual((await rpc({jsonrpc: '2.0', id: 'p', method: 'ping'})).body, {jsonrpc: '2.0', id: 'p', result: {}});
  const {body} = await rpc({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  assert.deepEqual(body.result.tools.map(t => t.name), ['list_missions', 'get_mission_text', 'create_recipe']);
  for (const tool of body.result.tools) {
    assert.ok(tool.description.length > 40);
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.deepEqual(MCP_TOOLS.find(t => t.name === 'create_recipe').inputSchema.required, ['paperId', 'edits']);
});

test('list_missions returns text plus structuredContent', async () => {
  const {body} = await rpc(call('list_missions', {}));
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.content[0].type, 'text');
  assert.match(body.result.content[0].text, /2309\.15217/);
  assert.deepEqual(body.result.structuredContent, {missions: MISSIONS});
});

test('get_mission_text returns one page or the whole paper, and isError for unknown papers or pages', async () => {
  const one = (await rpc(call('get_mission_text', {paperId: '2309.15217', page: 5}))).body.result;
  assert.deepEqual(one.structuredContent.pages, [{page: 5, text: 'Ragas 0.95 0.78 0.70'}]);
  assert.equal(one.structuredContent.pageCount, 2);
  assert.match(one.content[0].text, /--- page 5 ---\nRagas 0\.95/);
  const all = (await rpc(call('get_mission_text', {paperId: '2309.15217'}))).body.result;
  assert.equal(all.structuredContent.pages.length, 2);
  for (const args of [{paperId: '2401.00001'}, {paperId: '2309.15217', page: 3}, {paperId: '2309.15217', page: 0}, {}]) {
    const result = (await rpc(call('get_mission_text', args))).body.result;
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.content[0].type, 'text');
  }
});

test('create_recipe forces source agent, passes the client IP and tells the agent to hand the url over', async () => {
  const deps = fakeDeps();
  const args = {paperId: '2309.15217', edits: [{page: 5, find: '0.95', replace: '0.50'}], defectType: 'number', reason: 'r', agent: {name: 'Claude Code', model: 'm'}, source: 'manual'};
  const {body} = await rpc(call('create_recipe', args), deps, {'CF-Connecting-IP': '203.0.113.9'});
  assert.equal(deps.calls.length, 1);
  assert.deepEqual(deps.calls[0].recipe, {schema: 'falsify.booth.recipe.v1', paperId: '2309.15217', edits: args.edits, defectType: 'number', reason: 'r', agent: args.agent, source: 'agent'});
  assert.equal(deps.calls[0].ip, '203.0.113.9');
  assert.equal(body.result.structuredContent.code, 'R-7K3QXM');
  assert.equal(body.result.structuredContent.url, 'https://example.test/event.html#recipe=R-7K3QXM');
  assert.match(body.result.content[0].text, /Give this link to your human: https:\/\/example\.test/);
  assert.match(body.result.content[0].text, /cannot submit/);
});

test('create_recipe rejects unknown argument keys with isError instead of dropping them', async () => {
  const deps = fakeDeps();
  const args = {paperId: '2309.15217', edits: [{find: '0.95', replace: '0.50'}], extra: 1, email: 'x'};
  const {status, body} = await rpc(call('create_recipe', args), deps);
  assert.equal(status, 200);
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /Unknown arguments: extra, email. create_recipe accepts only paperId, edits, defectType, reason, agent/);
  assert.equal(body.result.structuredContent.error.field, 'extra');
  assert.equal(deps.calls.length, 0);
  const tolerated = await rpc(call('create_recipe', {schema: 'falsify.booth.recipe.v1', source: 'agent', paperId: '2309.15217', edits: [{find: 'a', replace: 'b'}]}), deps);
  assert.notEqual(tolerated.body.result.isError, true);
  assert.equal(deps.calls.length, 1);
});

test('create_recipe server failures become isError tool results', async () => {
  const cases = [
    [{status: 400, body: {error: {code: 'invalid_request', field: 'edits[0].find'}}}, /invalid_request \(field: edits\[0\]\.find\)/],
    [{status: 429, body: {error: {code: 'rate_limited'}}}, /Rate limited/],
    [{status: 413, body: {}}, /too large/],
  ];
  for (const [reply, pattern] of cases) {
    const deps = fakeDeps({createRecipe: async () => reply});
    const {status, body} = await rpc(call('create_recipe', {paperId: '2309.15217', edits: []}), deps);
    assert.equal(status, 200);
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, pattern);
    assert.equal(body.result.structuredContent.status, reply.status);
  }
  const thrown = fakeDeps({createRecipe: async () => { throw new Error('db down'); }});
  const {body} = await rpc(call('create_recipe', {paperId: '2309.15217', edits: []}), thrown);
  assert.equal(body.result.isError, true);
  assert.doesNotMatch(body.result.content[0].text, /db down/);
  const badArgs = (await rpc({jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'create_recipe', arguments: [1]}})).body;
  assert.equal(badArgs.result.isError, true);
});

test('protocol errors are JSON-RPC errors', async () => {
  const unknownTool = (await rpc(call('submit', {}))).body;
  assert.equal(unknownTool.error.code, -32602);
  assert.equal(unknownTool.id, 3);
  assert.equal((await rpc({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {}})).body.error.code, -32602);
  assert.equal((await rpc({jsonrpc: '2.0', id: 6, method: 'resources/list'})).body.error.code, -32601);
  assert.equal((await rpc({jsonrpc: '2.0', id: 7, method: 'toString'})).body.error.code, -32601);
  const parse = await rpc('{"jsonrpc":');
  assert.equal(parse.status, 400);
  assert.equal(parse.body.error.code, -32700);
  for (const bad of [{id: 1, method: 'ping'}, {jsonrpc: '2.0', id: {}, method: 'ping'}, 'null', '7', {jsonrpc: '2.0', id: 1}]) {
    const {status, body} = await rpc(bad);
    assert.equal(status, 400, JSON.stringify(bad));
    assert.equal(body.error.code, -32600);
  }
});

test('batch requests are rejected with -32600', async () => {
  const {status, body} = await rpc([{jsonrpc: '2.0', id: 1, method: 'ping'}]);
  assert.equal(status, 400);
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /Batch/);
});

test('bodies over 16 KB are 413 whether declared or streamed', async () => {
  const big = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ping', params: {pad: 'x'.repeat(MCP_MAX_BODY)}});
  assert.equal((await rpc(big)).status, 413);
  const stream = new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); }});
  const request = new Request('https://api.test/mcp', {method: 'POST', body: stream, duplex: 'half'});
  const response = await handleAgentMcp(request, {}, fakeDeps());
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, -32600);
});

test('GET, DELETE and OPTIONS; any Mcp-Protocol-Version header is accepted', async () => {
  for (const method of ['GET', 'DELETE']) {
    const response = await handleAgentMcp(new Request('https://api.test/mcp', {method}), {}, fakeDeps());
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST, OPTIONS');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  }
  const pre = await handleAgentMcp(new Request('https://api.test/mcp', {method: 'OPTIONS'}), {}, fakeDeps());
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Mcp-Protocol-Version/);
  assert.equal(pre.headers.get('Access-Control-Allow-Credentials'), null);
  for (const version of ['2025-03-26', '2024-11-05', 'garbage']) {
    const {status} = await rpc({jsonrpc: '2.0', id: 1, method: 'ping'}, fakeDeps(), {'Mcp-Protocol-Version': version});
    assert.equal(status, 200);
  }
});
