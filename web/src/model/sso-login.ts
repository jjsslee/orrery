import type { SsoLoginStatus } from '@orrery/shared';
import { api } from '../api/client';

type LoginApi = Pick<typeof api, 'ssoLogin' | 'ssoLoginStatus' | 'ssoLoginCancel'>;
/** One UI attempt; late start/poll responses cannot reconnect a different profile. */
export class SsoLoginFlow {
  private generation = 0;
  private id?: string;
  private startRequest?: Promise<SsoLoginStatus>;
  private cleanup: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;
  constructor(private readonly client: LoginApi = api, private readonly pollMs = 1000) {}

  cancel(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.wake?.();
    this.wake = undefined;
    const id = this.id;
    this.id = undefined;
    const start = this.startRequest;
    this.startRequest = undefined;
    const cancel = id ? this.client.ssoLoginCancel(id) : start?.then((status) => this.client.ssoLoginCancel(status.id));
    this.cleanup = Promise.all([this.cleanup, cancel?.catch(() => {})]);
  }

  async start(profile: string, update: (status: SsoLoginStatus) => void, complete: () => Promise<void>, fail: (message: string) => void): Promise<void> {
    this.cancel();
    const generation = this.generation;
    const current = () => generation === this.generation;
    try {
      await this.cleanup;
      if (!current()) return;
      this.startRequest = this.client.ssoLogin(profile);
      let status = await this.startRequest;
      if (!current()) return;
      this.startRequest = undefined;
      this.id = status.id;
      update(status);
      while (status.state === 'pending') {
        await new Promise<void>((resolve) => { this.wake = resolve; this.timer = setTimeout(resolve, this.pollMs); });
        this.wake = undefined;
        if (!current()) return;
        status = await this.client.ssoLoginStatus(status.id);
        if (!current()) return;
        update(status);
      }
      this.id = undefined;
      if (status.state === 'succeeded') await complete();
    } catch (err) {
      if (!current()) return;
      this.cancel();
      fail((err as Error).message);
    }
  }
}
