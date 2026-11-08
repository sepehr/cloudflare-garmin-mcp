import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionManager, type StoredSession } from '../src/session.js';
import { GarminHttpError, type GarminSession } from '../src/garmin.js';

const original: GarminSession = { di_token: 'fixture-access', di_refresh_token: 'fixture-refresh', di_client_id: 'fixture-client' };
const replacement = { ...original, di_token: 'new-access', di_refresh_token: 'new-refresh' };
function memory() {
  let value: StoredSession | undefined;
  return {
    async get() { return value === undefined ? undefined : structuredClone(value); },
    async put(next: StoredSession) { value = structuredClone(next); },
  };
}

test('simultaneous unauthorized reads refresh once and preserve the rotated session after restart', async () => {
  const store = memory();
  let refreshes = 0;
  const upstream = {
    async read(session: GarminSession) {
      if (session.di_token === original.di_token) throw new GarminHttpError(401);
      return { ok: true };
    },
    async refresh() { refreshes++; return replacement; },
  };
  const manager = new SessionManager(store, JSON.stringify(original), upstream);
  const responses = await Promise.all([manager.read('/test'), manager.read('/test')]);
  assert.deepEqual(responses, [{ ok: true }, { ok: true }]);
  assert.equal(refreshes, 1);
  const restarted = new SessionManager(store, JSON.stringify(original), upstream);
  assert.deepEqual(await restarted.read('/test'), { ok: true });
  assert.equal(refreshes, 1);
  assert.equal((await store.get())?.session.di_refresh_token, replacement.di_refresh_token);
});

test('an interrupted refresh does not retry the potentially consumed refresh token', async () => {
  const store = memory();
  let refreshes = 0;
  const upstream = {
    async read() { throw new GarminHttpError(401); },
    async refresh(): Promise<GarminSession> { refreshes++; throw new Error('Lost connection'); },
  };
  const manager = new SessionManager(store, JSON.stringify(original), upstream);
  await assert.rejects(manager.read('/test'));
  const restarted = new SessionManager(store, JSON.stringify(original), upstream);
  await assert.rejects(restarted.read('/test'), /Reconnect/);
  assert.equal(refreshes, 1);
});

test('a new local sign-in replaces an interrupted session', async () => {
  const store = memory();
  await store.put({ session: original, bootstrapFingerprint: 'old-fingerprint', refreshPending: true });
  const manager = new SessionManager(store, JSON.stringify(replacement), {
    async read(session) { return session.di_token === replacement.di_token; },
    async refresh() { throw new Error('Refresh should not be needed'); },
  });
  assert.equal(await manager.read('/test'), true);
});

test('failure to save rotated tokens blocks further upstream calls', async () => {
  const store = memory();
  let reads = 0;
  const manager = new SessionManager({
    get: store.get,
    async put(value) {
      if (value.session.di_token === replacement.di_token) throw new Error('Storage down');
      await store.put(value);
    },
  }, JSON.stringify(original), {
    async read() { reads++; throw new GarminHttpError(401); },
    async refresh() { return replacement; },
  });
  await assert.rejects(manager.read('/test'));
  await assert.rejects(manager.read('/test'), /Reconnect/);
  assert.equal(reads, 1);
});

test('rate limits do not trigger refresh or automatic retry', async () => {
  let reads = 0;
  const manager = new SessionManager(memory(), JSON.stringify(original), {
    async read() { reads++; throw new GarminHttpError(429); },
    async refresh() { throw new Error('Must not refresh'); },
  });
  await assert.rejects(manager.read('/test'), (error: unknown) => error instanceof GarminHttpError && error.status === 429);
  assert.equal(reads, 1);
});

test('an expired access token refreshes before the first read', async () => {
  const expired = { ...original, di_token: `header.${btoa(JSON.stringify({ exp: 1 }))}.signature` };
  const events: string[] = [];
  const manager = new SessionManager(memory(), JSON.stringify(expired), {
    async read(session) { events.push('read'); assert.equal(session.di_token, replacement.di_token); return {}; },
    async refresh() { events.push('refresh'); return replacement; },
  });
  await manager.read('/test');
  assert.deepEqual(events, ['refresh', 'read']);
});
