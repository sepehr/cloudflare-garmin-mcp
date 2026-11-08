import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env extends WorkerBindings {
  OAUTH_PROVIDER: OAuthHelpers;
}
