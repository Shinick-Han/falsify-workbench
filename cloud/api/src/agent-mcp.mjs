// Agent MCP endpoint (recipe contract v1 section 2): a stateless MCP Streamable HTTP server.
// JSON responses only, no SSE, no sessions. S3 routes POST /mcp here and supplies deps:
//   createRecipe(env, recipe, ip) -> {status, body}
//   missionsList(env) -> [mission]
//   missionText(paperId) -> {paperId, title, license, url?, pages:[{page, text}]} | null
// An agent never submits. create_recipe returns a url the agent hands to its human, who reviews,
// consents and submits on the event page.

export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26']);
export const MCP_DEFAULT_PROTOCOL = '2025-06-18';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_MAX_BODY = 16 * 1024;

const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Max-Age': '600',
});

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const ARXIV_ID_PATTERN = '^(\\d{4}\\.\\d{4,5}(v\\d+)?|[a-z-]+(\\.[A-Z]{2})?/\\d{7}(v\\d+)?)$';
const DEFECT_TYPES = ['number', 'figure', 'citation', 'logic', 'method', 'other'];

export const MCP_INSTRUCTIONS = [
  'Falsify booth (AWS Community Day 2026): plant 1-3 plausible, checkable defects in a CC BY arXiv paper so an AI reviewer (BLUE) can try to find them.',
  'Workflow: list_missions -> get_mission_text -> create_recipe.',
  'Each edit is a find/replace on the paper text; "find" must occur verbatim in the page text from get_mission_text.',
  'create_recipe returns a short code and a url. You cannot submit. Give the url (or the code) to your human:',
  'they open it on the booth page, review the before/after, consent and submit themselves. Recipes expire after 6 hours.',
  'Never put personal data in a recipe. AI-planted entries are eligible for the same prizes as manual ones.',
].join(' ');

const EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['find', 'replace'],
  properties: {
    page: {type: 'integer', minimum: 1, maximum: 500, description: '1-based page number where "find" occurs. Recommended.'},
    find: {type: 'string', minLength: 1, maxLength: 300, description: 'Exact text from the page to replace. Copy it from get_mission_text. Whitespace and line-end hyphenation are normalised when matching.'},
    replace: {type: 'string', maxLength: 300, description: 'Replacement text. Must differ from find. An empty string deletes.'},
    context: {type: 'string', maxLength: 600, description: 'Optional surrounding text, used only to choose among several matches of find.'},
  },
};

export const MCP_TOOLS = Object.freeze([
  {
    name: 'list_missions',
    title: 'List booth missions',
    description: 'Lists the booth mission papers (arXiv id, title, license, course, page hint and a hint for what to change). Start here. Mission papers have their text available through get_mission_text.',
    inputSchema: {type: 'object', additionalProperties: false, properties: {}},
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
  {
    name: 'get_mission_text',
    title: 'Read a mission paper',
    description: 'Returns the extracted text of a mission paper, page by page. Pass page to read one page (recommended; the whole paper can be long). Copy "find" strings for create_recipe verbatim from this text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['paperId'],
      properties: {
        paperId: {type: 'string', pattern: ARXIV_ID_PATTERN, description: 'arXiv id of a mission paper, for example 2309.15217.'},
        page: {type: 'integer', minimum: 1, maximum: 500, description: 'Optional 1-based page number.'},
      },
    },
    annotations: {readOnlyHint: true, openWorldHint: false},
  },
  {
    name: 'create_recipe',
    title: 'Create a defect recipe for your human',
    description: 'Stores a defect recipe (1-5 find/replace edits, ideally 1-3 plausible ones) for 6 hours and returns a code and a url. This does NOT submit anything. Give the url to your human: they open it on the booth page, review the before/after, consent and submit. Never include personal data. The paper must be a mission paper or a CC BY arXiv paper.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['paperId', 'edits'],
      properties: {
        paperId: {type: 'string', pattern: ARXIV_ID_PATTERN, description: 'arXiv id, for example 2309.15217.'},
        edits: {type: 'array', minItems: 1, maxItems: 5, items: EDIT_SCHEMA, description: 'Find/replace edits on the paper text.'},
        defectType: {type: 'string', enum: DEFECT_TYPES, description: 'Optional defect category.'},
        reason: {type: 'string', maxLength: 500, description: 'Optional: why this is a defect (pre-fills the reason box; the human can edit it; never shown to the AI reviewer).'},
        agent: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {type: 'string', maxLength: 60, description: 'Agent name, for example Claude Code.'},
            model: {type: 'string', maxLength: 60, description: 'Model id.'},
          },
          description: 'Optional: who planted the defect.',
        },
      },
    },
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false},
  },
]);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function respond(status, body, extra = {}) {
  const headers = {...CORS, 'Cache-Control': 'no-store', ...extra};
  if (body === null) return new Response(null, {status, headers});
  headers['Content-Type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(body), {status, headers});
}

function rpcError(id, code, message, data) {
  const error = data === undefined ? {code, message} : {code, message, data};
  return {jsonrpc: '2.0', id: id ?? null, error};
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Reads at most MCP_MAX_BODY bytes; returns null (413) as soon as the body is larger.
async function readBody(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MCP_MAX_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parseMessage(text) {
  try {
    return {message: JSON.parse(text)};
  } catch {
    return {error: rpcError(null, PARSE_ERROR, 'Parse error')};
  }
}

function hasId(message) {
  return Object.hasOwn(message, 'id') && message.id !== null;
}

function validId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function envelopeError(message) {
  if (Array.isArray(message)) return rpcError(null, INVALID_REQUEST, 'Batch requests are not supported');
  if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  if (hasId(message) && !validId(message.id)) return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  return null;
}

function initializeResult(params) {
  const asked = isObject(params) ? params.protocolVersion : undefined;
  return {
    protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_DEFAULT_PROTOCOL,
    capabilities: {tools: {}},
    serverInfo: {name: 'falsify-booth', title: 'Falsify booth', version: MCP_SERVER_VERSION},
    instructions: MCP_INSTRUCTIONS,
  };
}

function toolResult(structured, text) {
  return {content: [{type: 'text', text}], structuredContent: structured};
}

function toolFailure(text, structured) {
  const result = {content: [{type: 'text', text}], isError: true};
  if (structured) result.structuredContent = structured;
  return result;
}

async function listMissions(env, deps) {
  const missions = (await deps.missionsList(env)) ?? [];
  const lines = missions.map(m => `- ${m.paperId} ${m.title}${m.pageHint ? ` (page ${m.pageHint})` : ''}${m.hint ? `: ${m.hint}` : ''}`);
  const text = missions.length
    ? `Mission papers (${missions.length}). Read one with get_mission_text.\n${lines.join('\n')}`
    : 'No missions are configured right now. You can still use any CC BY arXiv paper with create_recipe.';
  return toolResult({missions}, text);
}

function pageBlocks(pages) {
  return pages.map(p => `--- page ${p.page} ---\n${p.text}`).join('\n\n');
}

function missionTextArgs(args) {
  if (typeof args.paperId !== 'string' || !args.paperId) return 'paperId is required';
  if (args.page !== undefined && !(Number.isInteger(args.page) && args.page >= 1 && args.page <= 500)) return 'page must be an integer 1..500';
  return null;
}

async function getMissionText(env, deps, args) {
  const problem = missionTextArgs(args);
  if (problem) return toolFailure(problem);
  const paper = await deps.missionText(args.paperId);
  if (!paper) return toolFailure(`${args.paperId} is not a mission paper. Call list_missions for the ids. For other CC BY arXiv papers, read the text on arxiv.org.`);
  const pageCount = paper.pages.length;
  const pages = args.page === undefined ? paper.pages : paper.pages.filter(p => p.page === args.page);
  if (!pages.length) return toolFailure(`Page ${args.page} does not exist; ${paper.paperId} has ${pageCount} pages.`);
  const header = `${paper.title} (arXiv ${paper.paperId}, ${paper.license}), ${pageCount} pages.`;
  const structured = {paperId: paper.paperId, title: paper.title, license: paper.license, pageCount, pages};
  if (paper.url) structured.url = paper.url;
  return toolResult(structured, `${header}\n\n${pageBlocks(pages)}`);
}

const RECIPE_KEYS = ['paperId', 'edits', 'defectType', 'reason', 'agent'];

function recipeFrom(args) {
  const recipe = {schema: 'falsify.booth.recipe.v1'};
  for (const key of RECIPE_KEYS) {
    if (args[key] !== undefined) recipe[key] = args[key];
  }
  recipe.source = 'agent';
  return recipe;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ?? '';
}

function recipeFailure(status, body) {
  const error = isObject(body?.error) ? body.error : {code: 'error'};
  if (status === 429) {
    const after = body?.retryAfter ?? error.retryAfter;
    return toolFailure(`Rate limited. Try again later${after ? ` (after ${after} s)` : ''}.`, {status, error});
  }
  if (status === 413) return toolFailure('The recipe is too large (max 8 KB).', {status, error});
  const field = error.field ? ` (field: ${error.field})` : '';
  const hint = status === 400 ? ' Check that each "find" occurs verbatim in the page text and that replace differs from find.' : '';
  return toolFailure(`Recipe rejected: ${error.code ?? 'error'}${field}.${hint}`, {status, error});
}

async function createRecipe(request, env, deps, args) {
  const {status, body} = await deps.createRecipe(env, recipeFrom(args), clientIp(request));
  if (status !== 200 && status !== 201) return recipeFailure(status, body);
  const {code, url, expiresAt} = body;
  const next = 'Give this url to your human. They open it on the booth page, review the before/after, consent and submit. You cannot submit.';
  const text = [
    `Recipe ${code} created. It expires at ${expiresAt}.`,
    `Give this link to your human: ${url}`,
    `(or the code ${code}, typed into the "Agent 코드" tab on the booth page).`,
    'They review the before/after, consent and submit themselves; you cannot submit.',
  ].join('\n');
  return toolResult({code, url, expiresAt, next}, text);
}

const TOOL_HANDLERS = {
  list_missions: (request, env, deps) => listMissions(env, deps),
  get_mission_text: (request, env, deps, args) => getMissionText(env, deps, args),
  create_recipe: (request, env, deps, args) => createRecipe(request, env, deps, args),
};

async function callTool(request, env, deps, params) {
  if (!isObject(params) || typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'Invalid params: name is required');
  const handler = Object.hasOwn(TOOL_HANDLERS, params.name) ? TOOL_HANDLERS[params.name] : null;
  if (!handler) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
  const args = params.arguments ?? {};
  if (!isObject(args)) return toolFailure('arguments must be an object');
  try {
    return await handler(request, env, deps, args);
  } catch {
    return toolFailure('The booth server could not complete this tool call. Try again shortly.');
  }
}

const METHODS = {
  initialize: (request, env, deps, params) => initializeResult(params),
  ping: () => ({}),
  'tools/list': () => ({tools: MCP_TOOLS}),
  'tools/call': (request, env, deps, params) => callTool(request, env, deps, params),
};

async function dispatch(request, env, deps, message) {
  const method = Object.hasOwn(METHODS, message.method) ? METHODS[message.method] : null;
  if (!method) return rpcError(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  try {
    return {jsonrpc: '2.0', id: message.id, result: await method(request, env, deps, message.params)};
  } catch (error) {
    if (error instanceof RpcError) return rpcError(message.id, error.code, error.message, error.data);
    return rpcError(message.id, INTERNAL_ERROR, 'Internal error');
  }
}

async function handleMessage(request, env, deps, message) {
  const invalid = envelopeError(message);
  if (invalid) return respond(400, invalid);
  // Notifications (no id) and client responses get 202 with no body.
  if (!hasId(message) || typeof message.method !== 'string') {
    if (typeof message.method !== 'string' && !Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) {
      return respond(400, rpcError(message.id, INVALID_REQUEST, 'Invalid Request'));
    }
    return respond(202, null);
  }
  return respond(200, await dispatch(request, env, deps, message));
}

// The Mcp-Protocol-Version header is accepted whatever its value: this server is stateless and
// answers every supported version the same way.
export async function handleAgentMcp(request, env, deps) {
  if (request.method === 'OPTIONS') return respond(204, null);
  if (request.method !== 'POST') return respond(405, rpcError(null, INVALID_REQUEST, 'Method not allowed'), {Allow: 'POST, OPTIONS'});
  const text = await readBody(request);
  if (text === null) return respond(413, rpcError(null, INVALID_REQUEST, 'Request body too large'));
  const parsed = parseMessage(text);
  if (parsed.error) return respond(400, parsed.error);
  return handleMessage(request, env, deps, parsed.message);
}
