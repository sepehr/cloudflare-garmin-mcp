import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';

const origin = 'https://private-garmin.test';
const accessCode = 'fixture-owner-code-not-a-real-secret';

test('real Workers runtime enforces OAuth and serves a read-only Garmin MCP tool', async () => {
  let upstreamCalls = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: 'dist/index.js',
    compatibilityDate: '2026-11-08',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'],
    durableObjects: { GARMIN_ACCOUNT: { className: 'GarminAccount', useSQLite: true } },
    bindings: {
      PUBLIC_ORIGIN: '',
      OWNER_ACCESS_HASH: createHash('sha256').update(accessCode).digest('hex'),
      GARMIN_SESSION: JSON.stringify({ di_token: 'fixture-garmin-access', di_refresh_token: 'fixture-garmin-refresh', di_client_id: 'fixture-client' }),
      GARMIN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, 'https://connectapi.garmin.com');
      assert.equal(url.pathname, '/activitylist-service/activities/search/activities');
      assert.equal(request.headers.get('Authorization'), 'Bearer fixture-garmin-access');
      upstreamCalls++;
      return Response.json([{ activityId: 123, activityName: 'Fixture walk' }]);
    },
  }));
  try {
    const denied = await runtime.dispatchFetch(`${origin}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401);
    assert.ok(denied.headers.get('WWW-Authenticate')?.includes('resource_metadata'));
    assert.equal(upstreamCalls, 0);

    const discovery = await runtime.dispatchFetch(`${origin}/.well-known/oauth-authorization-server`, {
      headers: { 'X-Forwarded-Host': 'attacker.test', 'X-Forwarded-Proto': 'http', Forwarded: 'host=attacker.test;proto=http' },
    });
    assert.equal(discovery.status, 200);
    const metadata = await discovery.json() as { issuer: string; authorization_endpoint: string };
    assert.equal(metadata.issuer, origin);
    assert.equal(metadata.authorization_endpoint, `${origin}/authorize`);

    const registration = await runtime.dispatchFetch(`${origin}/oauth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Fixture ChatGPT', redirect_uris: ['https://client.test/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json() as { client_id: string };
    const verifier = 'fixture-pkce-verifier-'.repeat(4);
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.test/callback', response_type: 'code', scope: 'garmin:read offline_access', state: 'fixture-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${origin}/mcp` });
    const page = await runtime.dispatchFetch(`${origin}/authorize?${query}`);
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'none'"));
    const html = await page.text();
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    assert.ok(handle);
    const cookie = page.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const form = (code: string) => new URLSearchParams({ handle, decision: 'approve', access_code: code }).toString();
    const wrongCode = await runtime.dispatchFetch(`${origin}/authorize`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form('wrong'),
    });
    assert.equal(wrongCode.status, 403);
    const crossSite = await runtime.dispatchFetch(`${origin}/authorize`, {
      method: 'POST', headers: { Origin: 'https://attacker.test', Cookie: cookie }, body: form(accessCode),
    });
    assert.equal(crossSite.status, 403);
    const missingCookie = await runtime.dispatchFetch(`${origin}/authorize`, {
      method: 'POST', headers: { Origin: origin }, body: form(accessCode), redirect: 'manual',
    });
    assert.equal(missingCookie.status, 400);
    const accepted = await runtime.dispatchFetch(`${origin}/authorize`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form(accessCode), redirect: 'manual',
    });
    assert.equal(accepted.status, 302);
    const redirect = new URL(accepted.headers.get('Location') ?? '');
    assert.equal(redirect.origin, 'https://client.test');
    assert.equal(redirect.searchParams.get('state'), 'fixture-state');
    const code = redirect.searchParams.get('code');
    assert.ok(code);
    const replay = await runtime.dispatchFetch(`${origin}/authorize`, {
      method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form(accessCode), redirect: 'manual',
    });
    assert.equal(replay.status, 400);
    const wrongVerifier = await runtime.dispatchFetch(`${origin}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'https://client.test/callback', code_verifier: 'wrong-verifier-'.repeat(4), resource: `${origin}/mcp` }).toString(),
    });
    assert.equal(wrongVerifier.status, 400);
    const tokenResponse = await runtime.dispatchFetch(`${origin}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, redirect_uri: 'https://client.test/callback', code_verifier: verifier, resource: `${origin}/mcp` }).toString(),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json() as { access_token: string };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` };
    const rpc = async (body: unknown) => {
      const response = await runtime.dispatchFetch(`${origin}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ result?: { tools?: { name: string; annotations: { readOnlyHint: boolean } }[]; content?: { text: string }[]; isError?: boolean }; error?: unknown }>;
    };
    const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    assert.equal(initialized.error, undefined);
    const catalog = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(catalog.result?.tools?.length, 20);
    assert.ok(catalog.result?.tools?.every(tool => tool.annotations.readOnlyHint));
    const activity = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_activities', arguments: { limit: 1 } } });
    assert.equal(activity.result?.isError, undefined);
    assert.ok(activity.result?.content?.[0]?.text.includes('Fixture walk'));
    assert.equal(upstreamCalls, 1);
    const write = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delete_activity', arguments: { activity_id: 123 } } });
    assert.ok(write.error || write.result?.isError);
    assert.equal(upstreamCalls, 1);
    const restrictedQuery = new URLSearchParams(query);
    restrictedQuery.set('scope', 'offline_access');
    const restrictedPage = await runtime.dispatchFetch(`${origin}/authorize?${restrictedQuery}`);
    const restrictedHtml = await restrictedPage.text();
    const restrictedHandle = restrictedHtml.match(/name="handle" value="([^"]+)"/)?.[1];
    assert.ok(restrictedHandle);
    const restrictedCookie = restrictedPage.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const restrictedApproval = await runtime.dispatchFetch(`${origin}/authorize`, {
      method: 'POST', headers: { Origin: origin, Cookie: restrictedCookie }, redirect: 'manual',
      body: new URLSearchParams({ handle: restrictedHandle, decision: 'approve', access_code: accessCode }).toString(),
    });
    assert.equal(restrictedApproval.status, 302);
    const restrictedCode = new URL(restrictedApproval.headers.get('Location') ?? '').searchParams.get('code');
    assert.ok(restrictedCode);
    const restrictedTokenResponse = await runtime.dispatchFetch(`${origin}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: restrictedCode, redirect_uri: 'https://client.test/callback', code_verifier: verifier, resource: `${origin}/mcp` }).toString(),
    });
    assert.equal(restrictedTokenResponse.status, 200);
    const restrictedTokens = await restrictedTokenResponse.json() as { access_token: string };
    const restrictedCall = await runtime.dispatchFetch(`${origin}/mcp`, {
      method: 'POST', headers: { ...headers, Authorization: `Bearer ${restrictedTokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    });
    assert.equal(restrictedCall.status, 403);
    assert.equal(upstreamCalls, 1);
  } finally { await runtime.dispose(); }
});
