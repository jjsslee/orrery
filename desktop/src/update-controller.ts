import { app, dialog, type BrowserWindow, type MenuItem } from 'electron';
import { acknowledgeUpdate, cancelPreparedUpdate, prepareUpdate, startUpdateHelper, updateNotice } from './update-install';
import { checkUpdate, type Update } from './updates';
import { createTranslator, type Language } from '@orrery/shared';

/** All update actions stay in the main process; the AWS renderer gains no filesystem or updater IPC. */
export class UpdateController {
  private busy = false;
  private stopping = false;
  private notifiedVersion: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private initial: ReturnType<typeof setTimeout> | undefined;
  private item: MenuItem | undefined;
  private preparation: Promise<void> | undefined;
  private cancellation: AbortController | undefined;
  private handoff = false;
  private quitScheduled = false;
  private statusKey = '업데이트 확인…';
  private readonly text = createTranslator(() => this.language());

  constructor(private readonly window: () => BrowserWindow | undefined, private readonly serverPid: () => number | undefined, private readonly language: () => Language = () => 'ko') {
    app.on('before-quit', (event) => {
      this.stopping = true;
      clearTimeout(this.initial);
      clearInterval(this.timer);
      if (this.preparation && !this.handoff) {
        event.preventDefault();
        this.cancellation?.abort();
        if (!this.quitScheduled) {
          this.quitScheduled = true;
          const quit = (): void => { app.quit(); };
          void this.preparation.then(quit, quit);
        }
      }
    });
  }

  bindMenu(item: MenuItem | undefined): void { this.item = item; this.status(this.statusKey); }

  start(): void {
    if (!app.isPackaged || this.stopping) return;
    this.initial = setTimeout(() => { void this.reportOutcome(); void this.check(false); }, 10_000);
    this.timer = setInterval(() => { void this.check(false); }, 6 * 60 * 60_000);
    this.timer.unref();
  }

  async ready(): Promise<void> {
    const token = process.argv.find((arg) => arg.startsWith('--orrery-update='))?.slice('--orrery-update='.length);
    try { await acknowledgeUpdate(app.getPath('userData'), app.getVersion(), app.getPath('exe'), token); }
    catch { /* No ready marker means the helper restores the previous app. */ }
  }

  private async reportOutcome(): Promise<void> {
    try {
      const outcome = await updateNotice(app.getPath('userData'));
      if (!outcome) return;
      const message = outcome.result === 'unchanged' ? this.text('업데이트를 적용하지 못했습니다. 기존 앱은 그대로입니다.') : outcome.result === 'rolled-back' ? this.text('새 버전을 시작하지 못해 이전 버전으로 복구했습니다.') : this.text('이전 업데이트를 완료하지 못했습니다.');
      await dialog.showMessageBox({ type: 'warning', title: this.text('Orrery 업데이트'), message, detail: this.text`앱 위치의 쓰기 권한과 보안 프로그램을 확인하세요.\n복구 파일과 기록: ${outcome.job.directory}`, buttons: [this.text('확인')] });
    } catch { /* Corrupt local state is reported if the user attempts another install. */ }
  }

  async check(manual: boolean): Promise<void> {
    if (this.busy || this.stopping) return;
    if (!app.isPackaged) {
      if (manual) await dialog.showMessageBox({ message: this.text('설치한 Orrery 앱에서 업데이트를 확인할 수 있습니다.'), buttons: [this.text('확인')] });
      return;
    }
    this.busy = true;
    this.status('업데이트 확인 중…');
    let installing = false;
    try {
      const update = await checkUpdate(app.getVersion(), process.platform, process.arch);
      if (this.stopping) return;
      if (!update) {
        if (manual) await dialog.showMessageBox({ message: this.text`최신 버전을 사용하고 있습니다(v${app.getVersion()}).`, buttons: [this.text('확인')] });
        return;
      }
      if (!manual && this.notifiedVersion === update.version) return;
      this.notifiedVersion = update.version;
      const answer = await dialog.showMessageBox({
        type: 'info', title: this.text('Orrery 업데이트'), message: this.text`새 버전 v${update.version}을 설치하시겠습니까?`,
        detail: this.text`현재 버전: v${app.getVersion()}\n다운로드: ${Math.ceil(update.size / 1024 / 1024)} MB\n\n다운로드가 끝나면 앱을 종료하고 새 버전으로 다시 시작합니다. 설정과 AWS 프로필은 유지됩니다.`,
        buttons: [this.text('업데이트'), this.text('나중에')], defaultId: 0, cancelId: 1,
      });
      if (answer.response !== 0 || this.stopping) return;
      installing = true;
      this.cancellation = new AbortController();
      this.preparation = this.install(update, this.cancellation.signal);
      await this.preparation;
    } catch (error) {
      if (!this.stopping && (manual || installing)) {
        const message = this.text(error instanceof Error ? error.message : '알 수 없는 오류');
        await dialog.showMessageBox({ type: 'error', title: this.text('Orrery 업데이트'), message: this.text('업데이트하지 못했습니다. 현재 앱은 계속 사용할 수 있습니다.'), detail: this.text`${message}\n\n네트워크와 앱 폴더의 쓰기 권한을 확인한 뒤 다시 시도하세요.`, buttons: [this.text('확인')] });
      }
    } finally {
      this.preparation = undefined;
      this.cancellation = undefined;
      this.busy = false;
      this.progress(-1);
      this.status('업데이트 확인…');
    }
  }

  private async install(update: Update, signal: AbortSignal): Promise<void> {
    this.status('업데이트 다운로드·검증 중…');
    this.progress(2);
    const pids = [process.pid, this.serverPid()].filter((pid): pid is number => typeof pid === 'number');
    const job = await prepareUpdate(update, app.getPath('userData'), app.getPath('exe'), process.platform, process.arch, pids, undefined, signal);
    if (this.stopping) { await cancelPreparedUpdate(job, app.getPath('userData')); return; }
    try { await startUpdateHelper(job, process.platform); }
    catch (error) { await cancelPreparedUpdate(job, app.getPath('userData')); throw error; }
    this.handoff = true;
    this.stopping = true;
    app.quit();
  }

  private status(label: string): void {
    this.statusKey = label;
    if (this.item) { this.item.label = this.text(label); this.item.enabled = !this.busy; }
  }

  private progress(value: number): void {
    const window = this.window();
    if (window && !window.isDestroyed()) window.setProgressBar(value);
  }
}
