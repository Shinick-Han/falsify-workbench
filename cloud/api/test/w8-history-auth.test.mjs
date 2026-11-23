import assert from 'node:assert/strict';
import test from 'node:test';
import {confluenceInternal} from '../src/confluence.mjs';
import {handleW8, matchW8} from '../src/w8-team.mjs';

test('history requests Jira read access and retains the paper library scopes', async () => {
  const origin = 'https://workbench.example';
  const url = new URL('https://relay.example/v1/w8/history/auth/start');
  const request = new Request(url, {method: 'POST', headers: {'Content-Type':'application/json', Origin:origin},
    body: JSON.stringify({nonce:'x'.repeat(20),returnOrigin:origin})});
  const env = {ATLASSIAN_CLIENT_ID:'falsify-test-client',ATLASSIAN_CLIENT_SECRET:'local-synthetic-secret',CONFLUENCE_SESSION_KEY:Buffer.alloc(32,7).toString('base64'),
    ATLASSIAN_CALLBACK_URL: 'https://relay.example/v1/confluence/auth/callback', CONFLUENCE_PARENT_PAGE_ID:'8355842'};
  const response = await handleW8({url,request,env,settings:{origins:new Set([origin])},match:matchW8(url.pathname)});
  assert.equal(response.status,200);
  const scopes = new URL((await response.json()).authorizeUrl).searchParams.get('scope').split(' ');
  assert.deepEqual(scopes.filter(scope => scope.includes('jira')), ['read:jira-work']);
  assert.ok(scopes.includes('read:confluence-user'));
});

test('both product containers for the same Falsify site supply scopes, other sites confer none',async () => {
  const site='https://falsify.atlassian.net';
  const fetchImpl=async () => Response.json([{id:'one',url:site,scopes:['read:page:confluence']},
    {id:'one',url:site,scopes:['read:jira-work']},{id:'two',url:'https://another.atlassian.net',scopes:['write:jira-work']}]);
  const budget = {signal: new AbortController().signal, end: Date.now() + 5000};
  fetchImpl.budget = budget;
  const actual=await confluenceInternal.accessibleResource(fetchImpl,'fixture');
  assert.deepEqual(actual,{id:'one',scopes:['read:page:confluence','read:jira-work']});
  const ambiguous = async () => Response.json([{id:'one',url:site},{id:'two',url:site}]);
  ambiguous.budget = budget;
  await assert.rejects(confluenceInternal.accessibleResource(ambiguous,'fixture'),
    {code:'site_not_allowed'});
});
