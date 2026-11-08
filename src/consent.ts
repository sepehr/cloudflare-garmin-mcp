import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export async function matchesAccessCode(value: string, expectedHash: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || value.length > 256) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const expected = Uint8Array.from(expectedHash.match(/../g) ?? [], byte => parseInt(byte, 16));
  let different = 0;
  for (let index = 0; index < digest.length; index++) different |= (digest[index] ?? 0) ^ (expected[index] ?? 0);
  return different === 0;
}

export function consentPage(details: ConsentDescription, handle: string): string {
  const origin = details.clientDomain
    ? `Client domain: <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This client registered itself. Its name is not verified.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Connect private Garmin</title><h1>Connect private Garmin</h1>
<p>Allow <strong>${escapeHtml(details.clientName)}</strong> to read your Garmin data?</p>
<p>${origin} Access returns to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p>This sends access to a local app. Continue only if you started this connection.</p>' : ''}
<p>Requested access: ${details.scope.map(escapeHtml).join(', ')}.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label>Private access code <input type="password" name="access_code" required autocomplete="current-password" maxlength="256"></label>
<p>Use the separate code made during setup. Your Garmin password is not needed here.</p>
<button name="decision" value="approve">Allow read access</button>
<button name="decision" value="deny" formnovalidate>Deny</button></form></html>`;
}
