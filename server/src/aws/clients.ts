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
 * All clients share the same credential provider so STS/SSO refreshes
 * happen once.
 */
export class ClientFactory {
  private readonly cache = new Map<string, SdkClient>();

  constructor(
    public readonly region: string,
    private readonly credentials: CredentialProvider,
  ) {}

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
