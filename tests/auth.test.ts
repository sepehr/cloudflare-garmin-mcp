import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesAccessCode, consentPage } from '../src/consent.js';
import { boundedBody } from '../src/body.js';

test('access codes compare only against a valid SHA-256 digest', async () => {
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fixture-code'))).toString('hex');
  assert.equal(await matchesAccessCode('fixture-code', digest), true);
  assert.equal(await matchesAccessCode('wrong', digest), false);
  assert.equal(await matchesAccessCode('anything', ''), false);
  assert.equal(await matchesAccessCode('anything', 'x'.repeat(64)), false);
});

test('consent page escapes untrusted client metadata and handle', () => {
  const page = consentPage({ clientId: 'client', clientName: '<script>BAD</script>', redirectUri: 'https://client.test/cb', redirectHost: 'client.test', redirectIsLoopback: false, scope: ['garmin:read'] }, '\"><script>HANDLE</script>');
  assert.equal(page.includes('<script>'), false);
  assert.ok(page.includes('client.test'));
  assert.ok(page.includes('garmin:read'));
});

test('streamed request size is bounded even without Content-Length', async () => {
  const request = new Request('https://test.example', { method: 'POST', body: 'x'.repeat(200) });
  await assert.rejects(boundedBody(request, 100));
});
