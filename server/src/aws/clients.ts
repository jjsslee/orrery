import { attachReadOnlyGuard, type GuardableClient } from './readonly-guard.ts';
import type { CredentialProvider } from './credentials.ts';

interface SdkClientConfig {
  region: string;
  credentials: CredentialProvider;
  maxAttempts?: number;
  retryMode?: string;
}

interface SdkClient extends GuardableClient {
  destroy?: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientCtor<T extends SdkClient> = new (config: any) => T;

/**
 * Lazily constructs one guarded SDK client per (service, region).
 * All clients use one copied credential snapshot. A provider refresh must create
 * a new session and revalidate STS before any other-account data can be read.
 */
export class ClientFactory {
  private readonly cache = new Map<string, SdkClient>();

  private readonly credentials: CredentialProvider;
  private credentialExpiry?: number;

  constructor(public readonly region: string, provider: CredentialProvider) {
    let snapshot: Promise<Awaited<ReturnType<CredentialProvider>>> | undefined;
    this.credentials = async () => {
      snapshot ??= provider().then((value) => {
        this.credentialExpiry = value.expiration?.getTime();
        return Object.freeze({ ...value, expiration: value.expiration ? new Date(value.expiration.getTime()) : undefined });
      });
      const value = await snapshot;
      if (this.credentialExpiry !== undefined && this.credentialExpiry <= Date.now()) throw Object.assign(new Error('이 연결의 자격증명이 만료되었습니다. 다시 연결하세요.'), { name: 'ExpiredToken' });
      // SDK credential decorators may attach metadata; keep the private snapshot unchanged.
      return { ...value, expiration: value.expiration ? new Date(value.expiration.getTime()) : undefined };
    };
  }

  get credentialsExpireAt(): number | undefined { return this.credentialExpiry; }

  get<T extends SdkClient>(Ctor: ClientCtor<T>, regionOverride?: string): T {
    const region = regionOverride ?? this.region;
    const key = `${Ctor.name}@${region}`;
    const cached = this.cache.get(key);
    if (cached) return cached as T;
    const client = attachReadOnlyGuard(
      new Ctor({ region, credentials: this.credentials, maxAttempts: 8, retryMode: 'adaptive' }),
    );
    this.cache.set(key, client);
    return client;
  }

  destroy(): void {
    for (const c of this.cache.values()) c.destroy?.();
    this.cache.clear();
  }
}
