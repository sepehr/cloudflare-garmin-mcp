import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { fetchGarmin, GarminHttpError, GarminSessionSchema, refreshSession, registerGarminTools, type Fetcher, type GarminRead } from '../src/garmin.js';

const session = { di_token: 'FAKE_ACCESS', di_refresh_token: 'FAKE_REFRESH', di_client_id: 'FAKE_CLIENT' };

async function connect(t: TestContext, read: GarminRead): Promise<Client> {
  const server = new McpServer({ name: 'test-garmin', version: '1' });
  registerGarminTools(server, read);
  const client = new Client({ name: 'test-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const resultSchema = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() })), isError: z.boolean().optional() });
function data(result: unknown): unknown {
  const parsed = resultSchema.parse(result);
  assert.equal(parsed.isError, undefined);
  const text = parsed.content[0]?.text;
  assert.ok(text);
  return JSON.parse(text) as unknown;
}

test('native fetch uses fixed HTTPS origin, Bearer header and abort timeout', async () => {
  const fetcher: Fetcher = async (input, init) => {
    assert.equal(String(input), 'https://connectapi.garmin.com/activity-service/activity/123?date=2026-11-08');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer FAKE_ACCESS');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    return Response.json({ id: 123 });
  };
  assert.deepEqual(await fetchGarmin(session, '/activity-service/activity/123', { date: '2026-11-08' }, fetcher), { id: 123 });
});

test('unsafe API paths never reach fetch', async () => {
  const fetcher: Fetcher = async () => { assert.fail('fetch must not run'); };
  for (const path of ['//localhost/x', '//evil', '//attacker.example/x', 'https://attacker.example', '/x?token=x', '/x#fragment', '/x/../y', '/x/%2e%2e/y']) {
    await assert.rejects(fetchGarmin(session, path, {}, fetcher), /Invalid Garmin API path/);
  }
});

test('HTTP failures expose the status but not upstream response text', async () => {
  const fetcher: Fetcher = async () => new Response('FAKE_PRIVATE_ERROR_DETAIL', { status: 401 });
  await assert.rejects(fetchGarmin(session, '/x', {}, fetcher), error => error instanceof GarminHttpError && error.status === 401 && !String(error).includes('PRIVATE_ERROR'));
});

test('redirects are rejected without forwarding Garmin authorization to another host', async () => {
  let calls = 0;
  const fetcher: Fetcher = async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } });
  };
  await assert.rejects(fetchGarmin(session, '/x', {}, fetcher), error => error instanceof GarminHttpError && error.status === 302);
  assert.equal(calls, 1);
});

test('oversized and invalid JSON responses fail safely', async () => {
  await assert.rejects(fetchGarmin(session, '/x', {}, async () => new Response('x'.repeat(2_000_001))), /size limit/);
  await assert.rejects(fetchGarmin(session, '/x', {}, async () => new Response('FAKE_PRIVATE_HTML')), /unreadable response/);
});

test('refresh submits only the refresh grant and preserves rotated credentials', async () => {
  const fetcher: Fetcher = async (input, init) => {
    assert.equal(String(input), 'https://diauth.garmin.com/di-oauth2-service/oauth/token');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), session.di_refresh_token);
    assert.equal(body.get('client_id'), session.di_client_id);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${btoa('FAKE_CLIENT:')}`);
    return Response.json({ access_token: 'FAKE_NEW_ACCESS', refresh_token: 'FAKE_NEW_REFRESH' });
  };
  assert.deepEqual(await refreshSession(session, fetcher), { ...session, di_token: 'FAKE_NEW_ACCESS', di_refresh_token: 'FAKE_NEW_REFRESH' });
});

test('refresh keeps the old refresh token when Garmin omits its replacement', async () => {
  assert.deepEqual(await refreshSession(session, async () => Response.json({ access_token: 'FAKE_NEW_ACCESS' })), { ...session, di_token: 'FAKE_NEW_ACCESS' });
  await assert.rejects(refreshSession(session, async () => Response.json({ refresh_token: 'FAKE_NEW_REFRESH' })), /invalid refresh response/);
});

test('session validation rejects missing credentials and unsafe client IDs', () => {
  assert.equal(GarminSessionSchema.safeParse(session).success, true);
  assert.equal(GarminSessionSchema.safeParse({ ...session, di_token: '' }).success, false);
  assert.equal(GarminSessionSchema.safeParse({ ...session, di_client_id: 'bad\nheader' }).success, false);
});

test('catalog preserves all twenty core names and read-only annotations', async t => {
  const client = await connect(t, async () => ({}));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'get_activities', 'get_activities_by_date', 'get_activity', 'get_activity_splits',
    'get_body_battery', 'get_daily_steps', 'get_full_name', 'get_heart_rate_zones',
    'get_heart_rates_summary', 'get_hrv_data', 'get_sleep_data', 'get_sleep_summary',
    'get_stats', 'get_stress_summary', 'get_training_readiness', 'get_training_status',
    'get_unit_system', 'get_user_profile', 'get_user_summary', 'get_userprofile_settings',
  ].sort());
  assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));
});

test('activity pagination exposes continuation rather than claiming a complete range', async t => {
  const client = await connect(t, async (path, params) => {
    assert.equal(path, '/activitylist-service/activities/search/activities');
    assert.deepEqual(params, { startDate: '2026-11-01', endDate: '2026-11-08', start: '4', limit: '2' });
    return [{ id: 1 }, { id: 2 }];
  });
  assert.deepEqual(data(await client.callTool({ name: 'get_activities_by_date', arguments: { start_date: '2026-11-01', end_date: '2026-11-08', start: 4, limit: 2 } })), {
    activities: [{ id: 1 }, { id: 2 }], start: 4, limit: 2, count: 2, has_more: true, next_start: 6,
  });
});

test('short activity page marks pagination complete', async t => {
  const client = await connect(t, async () => []);
  assert.deepEqual(data(await client.callTool({ name: 'get_activities', arguments: {} })), { activities: [], start: 0, limit: 20, count: 0, has_more: false, next_start: null });
});

test('invalid dates, reverse ranges, excessive ranges and invalid IDs make no API calls', async t => {
  const client = await connect(t, async () => { assert.fail('invalid arguments reached Garmin'); });
  const cases = [
    { name: 'get_sleep_data', arguments: { date: '2026-02-30' } },
    { name: 'get_sleep_data', arguments: { date: '2026-2-03' } },
    { name: 'get_daily_steps', arguments: { start_date: '2026-11-08', end_date: '2026-11-01' } },
    { name: 'get_daily_steps', arguments: { start_date: '2026-10-01', end_date: '2026-11-01' } },
    { name: 'get_activity', arguments: { activity_id: '../account' } },
    { name: 'get_activity', arguments: { activity_id: 0 } },
    { name: 'get_activities', arguments: { limit: 51 } },
  ];
  for (const request of cases) {
    assert.equal(resultSchema.parse(await client.callTool(request)).isError, true);
  }
});

test('profile-bound requests use the profile displayName and encoded fixed query values', async t => {
  const requests: { path: string; params?: Record<string, string> }[] = [];
  const client = await connect(t, async (path, params) => {
    requests.push({ path, ...(params ? { params } : {}) });
    return path === '/userprofile-service/socialProfile' ? { displayName: 'FAKE_NAME', fullName: 'Fixture' } : {};
  });
  data(await client.callTool({ name: 'get_sleep_data', arguments: { date: '2026-11-08' } }));
  assert.deepEqual(requests, [
    { path: '/userprofile-service/socialProfile' },
    { path: '/wellness-service/wellness/dailySleepData/FAKE_NAME', params: { date: '2026-11-08', nonSleepBufferMinutes: '60' } },
  ]);
});

test('summary tolerates absent nullable measurements without inventing zero values', async t => {
  const client = await connect(t, async path => path === '/userprofile-service/socialProfile' ? { displayName: 'FAKE_NAME' } : { dailySleepDTO: { sleepTimeSeconds: 18000, sleepScores: null, remSleepSeconds: null }, restingHeartRate: null });
  assert.deepEqual(data(await client.callTool({ name: 'get_sleep_summary', arguments: { date: '2026-11-08' } })), { date: '2026-11-08', sleepTimeSeconds: 18000, sleepScore: {} });
});

test('opaque upstream errors cannot leak into tool results', async t => {
  const client = await connect(t, async () => { throw new Error('FAKE_SECRET_CREDENTIAL'); });
  const result = resultSchema.parse(await client.callTool({ name: 'get_user_profile', arguments: {} }));
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes('FAKE_SECRET_CREDENTIAL'));
});

test('all twenty tools resolve to their expected read-only Garmin endpoints', async t => {
  const paths: string[] = [];
  const client = await connect(t, async path => {
    paths.push(path);
    if (path === '/userprofile-service/socialProfile') return { displayName: 'FAKE_NAME', fullName: 'Fixture' };
    if (path === '/userprofile-service/userprofile/user-settings') return { userData: { measurementSystem: 'metric' } };
    if (path === '/biometric-service/heartRateZones') return [{ sport: 'DEFAULT' }];
    if (path === '/activitylist-service/activities/search/activities') return [];
    if (path.startsWith('/usersummary-service/usersummary/daily/')) return { calendarDate: '2026-11-08' };
    return {};
  });
  const cases: { name: string; args: Record<string, unknown>; path: string }[] = [
    { name: 'get_full_name', args: {}, path: '/userprofile-service/socialProfile' },
    { name: 'get_unit_system', args: {}, path: '/userprofile-service/userprofile/user-settings' },
    { name: 'get_user_profile', args: {}, path: '/userprofile-service/userprofile/user-settings' },
    { name: 'get_userprofile_settings', args: {}, path: '/userprofile-service/userprofile/settings' },
    { name: 'get_heart_rate_zones', args: {}, path: '/biometric-service/heartRateZones' },
    { name: 'get_activities', args: {}, path: '/activitylist-service/activities/search/activities' },
    { name: 'get_activities_by_date', args: { start_date: '2026-11-01', end_date: '2026-11-08' }, path: '/activitylist-service/activities/search/activities' },
    { name: 'get_activity', args: { activity_id: '123' }, path: '/activity-service/activity/123' },
    { name: 'get_activity_splits', args: { activity_id: 123 }, path: '/activity-service/activity/123/splits' },
    { name: 'get_body_battery', args: { start_date: '2026-11-01', end_date: '2026-11-08' }, path: '/wellness-service/wellness/bodyBattery/reports/daily' },
    { name: 'get_daily_steps', args: { start_date: '2026-11-01', end_date: '2026-11-08' }, path: '/usersummary-service/stats/steps/daily/2026-11-01/2026-11-08' },
    { name: 'get_stats', args: { date: '2026-11-08' }, path: '/usersummary-service/usersummary/daily/FAKE_NAME' },
    { name: 'get_user_summary', args: { date: '2026-11-08' }, path: '/usersummary-service/usersummary/daily/FAKE_NAME' },
    { name: 'get_training_readiness', args: { date: '2026-11-08' }, path: '/metrics-service/metrics/trainingreadiness/2026-11-08' },
    { name: 'get_training_status', args: { date: '2026-11-08' }, path: '/metrics-service/metrics/trainingstatus/aggregated/2026-11-08' },
    { name: 'get_sleep_data', args: { date: '2026-11-08' }, path: '/wellness-service/wellness/dailySleepData/FAKE_NAME' },
    { name: 'get_sleep_summary', args: { date: '2026-11-08' }, path: '/wellness-service/wellness/dailySleepData/FAKE_NAME' },
    { name: 'get_heart_rates_summary', args: { date: '2026-11-08' }, path: '/wellness-service/wellness/dailyHeartRate/FAKE_NAME' },
    { name: 'get_stress_summary', args: { date: '2026-11-08' }, path: '/wellness-service/wellness/dailyStress/2026-11-08' },
    { name: 'get_hrv_data', args: { date: '2026-11-08' }, path: '/hrv-service/hrv/2026-11-08' },
  ];
  for (const item of cases) {
    paths.length = 0;
    data(await client.callTool({ name: item.name, arguments: item.args }));
    assert.equal(paths.at(-1), item.path, item.name);
  }
});

test('empty and privacy-protected daily summaries are unavailable rather than successful health data', async t => {
  for (const unavailable of [{}, { privacyProtected: true }]) {
    const client = await connect(t, async path => path === '/userprofile-service/socialProfile'
      ? { displayName: 'FAKE_NAME' } : unavailable);
    for (const name of ['get_stats', 'get_user_summary']) {
      const result = resultSchema.parse(await client.callTool({ name, arguments: { date: '2026-11-08' } }));
      assert.equal(result.isError, true);
    }
  }
});
