import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authorize } from './auth.js';
import type { Env } from './env.js';
import { registerGarminTools } from './garmin.js';
import { boundedBody } from './body.js';
export { GarminAccount } from './account.js';

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const scope: unknown = 'auth' in ctx ? ctx.auth : undefined;
    if (typeof scope !== 'object' || scope === null || !('scope' in scope) || !Array.isArray(scope.scope) || !scope.scope.includes('garmin:read')) {
      return new Response('Read permission is required', { status: 403 });
    }
    const server = new McpServer({ name: 'Private Garmin', version: '0.1.0' }, {
      instructions: 'Read-only Garmin data. Dates use the account local calendar. Activity lists are paginated; never imply a page covers the full history. Unavailable metrics are not zero.',
    });
    const account = env.GARMIN_ACCOUNT.get(env.GARMIN_ACCOUNT.idFromName('owner'));
    registerGarminTools(server, (path, params) => account.read(path, params));
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 16384 });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      // Cloudflare routes the URL host to this Worker. Do not trust forwarded headers.
      env = { ...env, PUBLIC_ORIGIN: env.PUBLIC_ORIGIN || url.origin };
      if (url.origin !== env.PUBLIC_ORIGIN) return new Response('Unknown origin', { status: 400 });
      const origin = request.headers.get('Origin');
      if (origin && ![env.PUBLIC_ORIGIN, 'https://chatgpt.com', 'https://chat.openai.com', 'https://claude.ai'].includes(origin)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (request.method === 'POST') {
        let bytes: Uint8Array;
        try { bytes = await boundedBody(request, 16384); }
        catch { return new Response('Request too large', { status: 413 }); }
        request = new Request(request, { body: bytes });
      }
      const provider = new OAuthProvider<Env>({
        apiRoute: '/mcp',
        apiHandler: mcpHandler,
        defaultHandler: { fetch: (req, bindings) => new URL(req.url).pathname === '/authorize'
          ? authorize(req, bindings)
          : Promise.resolve(new Response('Not found', { status: 404 })) },
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/oauth/token',
        clientRegistrationEndpoint: '/oauth/register',
        scopesSupported: ['garmin:read', 'offline_access'],
        requiredScopes: ['garmin:read'],
        clientIdMetadataDocumentEnabled: true,
        resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, authorization_servers: [env.PUBLIC_ORIGIN] },
      });
      const response = await provider.fetch(request, env, ctx);
      const secured = new Response(response.body, response);
      secured.headers.set('Cache-Control', 'no-store');
      secured.headers.set('X-Content-Type-Options', 'nosniff');
      secured.headers.set('Referrer-Policy', 'no-referrer');
      secured.headers.set('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      return secured;
    } catch {
      return new Response('The Garmin connection is temporarily unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};
