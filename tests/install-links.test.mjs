import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installLinks } from '../site/install.js';

test('desktop install links preserve the remote URL without embedded credentials', () => {
  const endpoint = 'https://garmin.example.test/mcp';
  const links = installLinks(endpoint);
  const redirect = new URL(links.vscode).searchParams.get('url');
  assert.ok(redirect.startsWith('vscode:mcp/install?'));
  assert.deepEqual(JSON.parse(decodeURIComponent(redirect.split('?')[1])), { name: 'garmin', type: 'http', url: endpoint });
  const cursor = new URL(links.cursor);
  assert.equal(cursor.protocol, 'cursor:');
  assert.equal(cursor.hostname, 'anysphere.cursor-deeplink');
  assert.equal(cursor.searchParams.get('name'), 'garmin');
  assert.deepEqual(JSON.parse(atob(cursor.searchParams.get('config'))), { url: endpoint });
});

test('unsafe URLs cannot create install links', () => {
  for (const value of ['http://example.test/mcp', 'https://user:fixture-secret@example.test/mcp',
    'https://example.test/mcp?token=fixture-secret', 'https://example.test/mcp#fragment',
    'javascript:alert(1)', 'https://example.test/other', 'https://bad host/mcp',
    'https://example.test\\attacker/mcp', 'https://example.test:99999/mcp', 'x'.repeat(2049)]) {
    assert.throws(() => installLinks(value));
  }
});
