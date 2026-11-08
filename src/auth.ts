import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env.js';
import { matchesAccessCode, consentPage } from './consent.js';

export async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Origin') !== env.PUBLIC_ORIGIN) return new Response('Forbidden', { status: 403 });
    const body = await request.text();
    if (body.length > 8192) return new Response('Request too large', { status: 413 });
    const form = new URLSearchParams(body);
    const handle = form.get('handle') ?? '';
    if (form.get('decision') === 'deny') {
      const denied = await oauth.denyConsent(request, handle);
      denied.headers.set('Location', denied.redirectTo);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (form.get('decision') !== 'approve' || !await matchesAccessCode(form.get('access_code') ?? '', env.OWNER_ACCESS_HASH)) {
      return new Response('Access code not accepted. Go back and try again.', { status: 403 });
    }
    const approved = await oauth.approveConsent(request, handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'owner',
      metadata: {},
      scope: approved.request.scope,
      props: { userId: 'owner' },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return new Response('This authorization request is invalid or expired. Start the connection again.', { status: 400 });
    }
    throw error;
  }
}
