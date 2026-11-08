import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTarget, commandEnvironment, parseSession, install } from '../scripts/setup.mjs';

const account = 'a'.repeat(32);
const target = setupTarget(account, 'garmin-test', 'https://garmin-test.example.workers.dev');
const fixture = { di_token: 'fixture-access', di_refresh_token: 'fixture-refresh', di_client_id: 'fixture-client' };

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'garmin-setup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'garmin', main: 'src/index.ts', vars: { PUBLIC_ORIGIN: '' }, kv_namespaces: [{ binding: 'OAUTH_KV' }] }));
  return { root, stateRoot: join(root, 'private-state') };
}

function fakeCommands({ exists = false, failDeploy = false, login = JSON.stringify(fixture), wrongAccount = false } = {}) {
  const calls = [];
  return { calls, run: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[1] === 'whoami') return { code: 0, stdout: JSON.stringify({ loggedIn: true, accounts: [{ id: wrongAccount ? 'b'.repeat(32) : account }] }), stderr: '' };
    if (args[1] === 'secret') return exists ? { code: 0, stdout: '[]', stderr: '' } : { code: 1, stdout: '', stderr: 'Worker "garmin-test" not found.' };
    if (command === 'uv') return { code: 0, stdout: login, stderr: '' };
    if (args[1] === 'deploy') return { code: failDeploy ? 1 : 0, stdout: 'fixture-upstream-sensitive-body', stderr: 'fixture-upstream-sensitive-body' };
    throw new Error('Unexpected command in test.');
  } };
}

test('setup rejects invalid deployment targets before running commands', () => {
  for (const origin of ['http://example.com', 'https://example.com/', 'https://example.com/path', 'https://user:pass@example.com']) {
    assert.throws(() => setupTarget(account, 'garmin', origin));
  }
  assert.throws(() => setupTarget('not-an-account', 'garmin', target.origin));
  assert.throws(() => setupTarget(account, '../garmin', target.origin));
});

test('child commands receive no inherited API keys or Garmin sessions', () => {
  const env = commandEnvironment({ PATH: '/bin', HOME: '/home/test', CLOUDFLARE_API_TOKEN: 'fixture-token', GARMINTOKENS: 'fixture-store', OPENAI_API_KEY: 'fixture-key', WRANGLER_WRITE_LOGS: 'true' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(env.GARMINTOKENS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.WRANGLER_WRITE_LOGS, 'false');
  assert.equal(env.WRANGLER_SEND_METRICS, 'false');
});

test('setup sends secrets only through stdin and keeps private recovery files', async t => {
  const paths = await workspace(t);
  const fake = fakeCommands();
  const output = [];
  await install(target, { ...paths, run: fake.run, report: line => output.push(line) });
  const deployment = fake.calls.find(call => call.args[1] === 'deploy');
  assert.ok(deployment.args.includes('--secrets-file'));
  assert.ok(deployment.args.includes('/dev/stdin'));
  const secrets = JSON.parse(deployment.options.input);
  assert.deepEqual(JSON.parse(secrets.GARMIN_SESSION), fixture);
  assert.equal(Buffer.from(secrets.GARMIN_ENCRYPTION_KEY, 'base64').length, 32);
  assert.match(secrets.OWNER_ACCESS_HASH, /^[a-f0-9]{64}$/);
  const statePath = join(paths.stateRoot, account, target.workerName, 'setup.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.encryptionKey, secrets.GARMIN_ENCRYPTION_KEY);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  const ownerFile = join(paths.stateRoot, account, target.workerName, 'owner-access-code.txt');
  assert.equal((await readFile(ownerFile, 'utf8')).trim(), state.ownerCode);
  assert.equal((await stat(ownerFile)).mode & 0o777, 0o600);
  const visible = JSON.stringify({ output, args: fake.calls.map(call => call.args) });
  for (const secret of [...Object.values(fixture), state.ownerCode, state.encryptionKey, 'fixture-upstream-sensitive-body']) assert.ok(!visible.includes(secret));
});

test('an existing Worker cannot have its encryption key replaced without the local backup', async t => {
  const paths = await workspace(t);
  const fake = fakeCommands({ exists: true });
  await assert.rejects(install(target, { ...paths, run: fake.run, report: () => {} }), /already exists/);
  assert.equal(fake.calls.some(call => call.command === 'uv' || call.args[1] === 'deploy'), false);
});

test('deployment failure preserves the encryption key for a retry', async t => {
  const paths = await workspace(t);
  const first = fakeCommands({ failDeploy: true });
  await assert.rejects(install(target, { ...paths, run: first.run, report: () => {} }), /Deployment did not complete/);
  const second = fakeCommands({ exists: true });
  await install(target, { ...paths, run: second.run, report: () => {} });
  const uploaded = calls => JSON.parse(calls.find(call => call.args[1] === 'deploy').options.input);
  assert.equal(uploaded(first.calls).GARMIN_ENCRYPTION_KEY, uploaded(second.calls).GARMIN_ENCRYPTION_KEY);
  assert.equal(uploaded(first.calls).OWNER_ACCESS_HASH, uploaded(second.calls).OWNER_ACCESS_HASH);
});

test('setup refuses an inaccessible account and malformed login without deployment', async t => {
  const paths = await workspace(t);
  const wrong = fakeCommands({ wrongAccount: true });
  await assert.rejects(install(target, { ...paths, run: wrong.run, report: () => {} }), /cannot access/);
  assert.equal(wrong.calls.some(call => call.args[1] === 'secret' || call.command === 'uv' || call.args[1] === 'deploy'), false);
  const malformed = fakeCommands({ login: 'fixture-private-error' });
  await assert.rejects(install(target, { ...paths, run: malformed.run, report: () => {} }), error => {
    assert.ok(!error.message.includes('fixture-private-error'));
    return /valid session/.test(error.message);
  });
  assert.equal(malformed.calls.some(call => call.args[1] === 'deploy'), false);
});

test('setup refuses a backup readable by other users', async t => {
  const paths = await workspace(t);
  const first = fakeCommands({ failDeploy: true });
  await assert.rejects(install(target, { ...paths, run: first.run, report: () => {} }));
  await chmod(join(paths.stateRoot, account, target.workerName, 'setup.json'), 0o644);
  const second = fakeCommands({ exists: true });
  await assert.rejects(install(target, { ...paths, run: second.run, report: () => {} }), /saved setup state/);
  assert.equal(second.calls.some(call => call.command === 'uv' || call.args[1] === 'deploy'), false);
});

test('dry run performs no login, secret inspection, or private state writes', async t => {
  const paths = await workspace(t);
  const fake = fakeCommands();
  await install(target, { ...paths, run: fake.run, report: () => {}, dryRun: true });
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0].args.includes('--dry-run'));
  assert.equal(fake.calls[0].options.input, '');
  await assert.rejects(stat(paths.stateRoot), { code: 'ENOENT' });
});

test('setup preserves provisioned KV bindings in the local deployment config', async t => {
  const paths = await workspace(t);
  const configPath = join(paths.root, 'wrangler.local.jsonc');
  await writeFile(configPath, JSON.stringify({ name: target.workerName, account_id: target.accountId, vars: { PUBLIC_ORIGIN: target.origin }, kv_namespaces: [{ binding: 'OAUTH_KV', id: 'fixture-provisioned-id' }] }));
  const fake = fakeCommands();
  await install(target, { ...paths, run: fake.run, report: () => {}, dryRun: true });
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).kv_namespaces[0].id, 'fixture-provisioned-id');
});

test('session validation strips extra fields and rejects invalid required values', () => {
  assert.deepEqual(parseSession(JSON.stringify({ ...fixture, password: 'fixture-extra' })), fixture);
  for (const invalid of [null, {}, { ...fixture, di_token: '' }, { ...fixture, di_token: 1 },
    { ...fixture, di_token: 'x'.repeat(16001) }, { ...fixture, di_refresh_token: 'x'.repeat(16001) },
    { ...fixture, di_client_id: 'unsafe client' }, { ...fixture, di_client_id: 'unsafe\nclient' },
    { ...fixture, di_client_id: 'x'.repeat(201) }]) assert.throws(() => parseSession(JSON.stringify(invalid)));
});
