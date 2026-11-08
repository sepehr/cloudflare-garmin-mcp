import { GarminHttpError, GarminSessionSchema, fetchGarmin, refreshSession, type GarminSession } from './garmin.js';

export interface StoredSession {
  session: GarminSession;
  bootstrapFingerprint: string;
  refreshPending: boolean;
}
export interface SessionStorage {
  get(): Promise<StoredSession | undefined>;
  put(value: StoredSession): Promise<void>;
}
interface Upstream {
  read: typeof fetchGarmin;
  refresh: typeof refreshSession;
}

export class SessionManager {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: SessionStorage, private readonly bootstrap: string,
    private readonly upstream: Upstream = { read: fetchGarmin, refresh: refreshSession }) {}

  read(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const result = this.tail.then(() => this.readSerially(path, params));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<StoredSession> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.bootstrap));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const stored = await this.storage.get();
    if (stored?.bootstrapFingerprint === fingerprint) return stored;
    const session = GarminSessionSchema.safeParse(JSON.parse(this.bootstrap));
    if (!session.success) throw new Error('Garmin session setup is invalid.');
    const value = { session: session.data, bootstrapFingerprint: fingerprint, refreshPending: false };
    await this.storage.put(value);
    return value;
  }

  private async readSerially(path: string, params: Record<string, string>): Promise<unknown> {
    let stored = await this.load();
    if (stored.refreshPending) throw new Error('Reconnect Garmin from the local sign-in tool.');
    if (expiresSoon(stored.session.di_token)) stored = await this.refresh(stored);
    try {
      return await this.upstream.read(stored.session, path, params);
    } catch (error) {
      if (!(error instanceof GarminHttpError) || error.status !== 401) throw error;
      stored = await this.refresh(stored);
      return this.upstream.read(stored.session, path, params);
    }
  }

  private async refresh(stored: StoredSession): Promise<StoredSession> {
    // A dropped refresh response may already have rotated the remote token.
    // Keep the marker until the replacement is durably stored; do not guess and retry.
    await this.storage.put({ ...stored, refreshPending: true });
    const session = await this.upstream.refresh(stored.session);
    const updated = { ...stored, session, refreshPending: false };
    await this.storage.put(updated);
    return updated;
  }
}

export function expiresSoon(accessToken: string, now = Date.now()): boolean {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return false;
    const parsed: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof parsed === 'object' && parsed !== null && 'exp' in parsed && typeof parsed.exp === 'number'
      && parsed.exp * 1000 < now + 60000;
  } catch {
    return false;
  }
}
