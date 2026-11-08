import { z } from 'zod';
import { GarminSessionSchema } from './garmin.js';
import type { SessionStorage, StoredSession } from './session.js';

const storedSessionSchema = z.object({
  session: GarminSessionSchema,
  bootstrapFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  refreshPending: z.boolean(),
}).strict();
const envelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string().max(32),
  ciphertext: z.string().max(100000),
}).strict();
export type EncryptedSession = z.infer<typeof envelopeSchema>;

export interface EncryptedStorage {
  get(): Promise<unknown>;
  put(value: EncryptedSession): Promise<void>;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export class EncryptedSessionStorage implements SessionStorage {
  private key: CryptoKey | undefined;
  private readonly purpose = new TextEncoder().encode('garmin:owner:session:v1');

  constructor(private readonly storage: EncryptedStorage, private readonly encodedKey: string) {}

  private async getKey(): Promise<CryptoKey> {
    if (this.key) return this.key;
    const bytes = decode(this.encodedKey);
    if (bytes.byteLength !== 32) throw new Error('Garmin encryption key must contain 32 random bytes.');
    this.key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return this.key;
  }

  async get(): Promise<StoredSession | undefined> {
    const value = await this.storage.get();
    if (value === undefined) return undefined;
    const encrypted = envelopeSchema.parse(value);
    const iv = decode(encrypted.iv);
    if (iv.byteLength !== 12) throw new Error('Invalid encrypted Garmin session.');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.purpose },
      await this.getKey(), decode(encrypted.ciphertext));
    return storedSessionSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  }

  async put(value: StoredSession): Promise<void> {
    const validated = storedSessionSchema.parse(value);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.purpose },
      await this.getKey(), new TextEncoder().encode(JSON.stringify(validated)));
    await this.storage.put({ version: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
  }
}
