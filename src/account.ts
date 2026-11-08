import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { SessionManager } from './session.js';
import { EncryptedSessionStorage } from './encrypted-storage.js';

export class GarminAccount extends DurableObject<Env> {
  private readonly session: SessionManager;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = new EncryptedSessionStorage({
      get: () => ctx.storage.get<unknown>('session'),
      put: value => ctx.storage.put('session', value),
    }, env.GARMIN_ENCRYPTION_KEY);
    this.session = new SessionManager(storage, env.GARMIN_SESSION);
  }

  async read(path: string, params?: Record<string, string>): Promise<unknown> {
    return this.session.read(path, params);
  }
}
