import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EncryptedSessionStorage, type EncryptedSession } from '../src/encrypted-storage.js';
import type { StoredSession } from '../src/session.js';

const fixture: StoredSession = {
  session: { di_token: 'fixture-access-token', di_refresh_token: 'fixture-refresh-token', di_client_id: 'fixture-client' },
  bootstrapFingerprint: 'a'.repeat(64), refreshPending: false,
};
const key = Buffer.alloc(32, 9).toString('base64');
function memory() {
  let saved: unknown;
  return { async get(): Promise<unknown> { return structuredClone(saved); }, async put(value: EncryptedSession) { saved = structuredClone(value); } };
}

test('persistent session contains ciphertext and round-trips the original credentials', async () => {
  const raw = memory();
  const storage = new EncryptedSessionStorage(raw, key);
  assert.equal(await storage.get(), undefined);
  await storage.put(fixture);
  const persisted = JSON.stringify(await raw.get());
  assert.equal(persisted.includes(fixture.session.di_token), false);
  assert.equal(persisted.includes(fixture.session.di_refresh_token), false);
  assert.equal(persisted.includes('di_token'), false);
  assert.deepEqual(await storage.get(), fixture);
  const oldValue = await raw.get();
  await storage.put(fixture);
  assert.notDeepEqual(await raw.get(), oldValue);
});

test('wrong encryption key and modified ciphertext fail closed', async () => {
  const raw = memory();
  const storage = new EncryptedSessionStorage(raw, key);
  await storage.put(fixture);
  const wrongKey = new EncryptedSessionStorage(raw, Buffer.alloc(32, 3).toString('base64'));
  await assert.rejects(wrongKey.get());
  const original = await raw.get() as EncryptedSession;
  const changed = original.ciphertext[0] === 'A' ? 'B' : 'A';
  await raw.put({ ...original, ciphertext: changed + original.ciphertext.slice(1) });
  await assert.rejects(storage.get());
});

test('plaintext records are rejected rather than accepted as a legacy format', async () => {
  const storage = new EncryptedSessionStorage({ async get() { return fixture; }, async put() { assert.fail('must not rewrite unknown plaintext'); } }, key);
  await assert.rejects(storage.get());
});

test('invalid encryption key cannot write a session', async () => {
  const raw = memory();
  const storage = new EncryptedSessionStorage(raw, Buffer.alloc(16).toString('base64'));
  await assert.rejects(storage.put(fixture));
  assert.equal(await raw.get(), undefined);
});
