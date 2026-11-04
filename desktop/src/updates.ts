import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';

export const RELEASES = 'https://github.com/jjsslee/orrery/releases';
const LATEST = 'https://api.github.com/repos/jjsslee/orrery/releases/latest';
const MAX_ZIP = 600 * 1024 * 1024;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
export type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface Update {
  version: string;
  name: string;
  url: string;
  size: number;
  sha256: string;
}

function versionParts(version: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('정식 버전 번호를 확인할 수 없습니다.');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('버전 번호가 너무 큽니다.');
  return parts;
}

export function newerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const before = versionParts(current);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== before[i]) return next[i] > before[i];
  }
  return false;
}

export function assetName(platform: string, arch: string): string {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `Orrery-macos-${arch}.zip`;
  if (platform === 'win32' && arch === 'x64') return 'Orrery-windows-x64.zip';
  throw new Error('이 운영체제·CPU의 자동 업데이트는 지원하지 않습니다.');
}

/** Only stable releases from the compiled-in repository; never a URL supplied by the renderer. */
export function selectUpdate(data: unknown, current: string, platform: string, arch: string): Update | undefined {
  const release = data as { draft?: boolean; prerelease?: boolean; tag_name?: string; assets?: Array<{ name: string; browser_download_url: string; size: number; digest: string; state: string }> } | null;
  if (!release || typeof release.tag_name !== 'string') throw new Error('릴리즈 정보를 확인할 수 없습니다.');
  if (release.draft || release.prerelease) return;
  const version = release.tag_name.replace(/^v/, '');
  if (!newerVersion(version, current)) return;
  const name = assetName(platform, arch);
  const asset = release.assets?.find((item) => item.name === name);
  if (!asset) throw new Error('이 PC용 업데이트 파일이 아직 게시되지 않았습니다. 잠시 후 다시 확인하세요.');
  const url = `${RELEASES}/download/${release.tag_name}/${name}`;
  if (asset.browser_download_url !== url || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ZIP || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('업데이트 파일의 주소·크기·SHA-256을 확인할 수 없어 설치를 중단했습니다.');
  }
  return { version, name, url, size: asset.size, sha256: asset.digest.slice(7) };
}

export async function checkUpdate(current: string, platform: string, arch: string, request: UpdateFetch = fetch): Promise<Update | undefined> {
  assetName(platform, arch);
  const response = await request(LATEST, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Orrery-Updater', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub 업데이트 확인에 실패했습니다(HTTP ${response.status}). 잠시 후 다시 시도하세요.`);
  return selectUpdate(await response.json(), current, platform, arch);
}

/** Bound redirects, bytes and time; digest is the SHA-256 returned by GitHub's release asset API. */
export async function downloadUpdate(update: Update, destination: string, request: UpdateFetch = fetch, cancellation?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(10 * 60_000);
  const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
  signal.throwIfAborted();
  let url = update.url;
  let response: Response | undefined;
  for (let i = 0; i < 6; i++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw new Error('허용되지 않은 다운로드 주소입니다.');
    response = await request(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'Orrery-Updater' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('다운로드 이동 주소가 없습니다.');
    url = new URL(location, url).href;
    response = undefined;
  }
  if (!response?.ok || !response.body) throw new Error('업데이트 파일을 다운로드하지 못했습니다.');
  const file = await open(destination, 'wx', 0o600).catch(async (error) => { await response!.body!.cancel(); throw error; });
  const reader = response.body.getReader();
  let complete = false;
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > update.size || bytes > MAX_ZIP) throw new Error('업데이트 파일이 예상 크기를 초과했습니다.');
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
    }
    if (bytes !== update.size || hash.digest('hex') !== update.sha256) throw new Error('업데이트 파일 검증에 실패했습니다. 기존 앱은 변경하지 않았습니다.');
    complete = true;
  } finally {
    await reader.cancel().catch(() => {});
    await file.close();
    if (!complete) await rm(destination, { force: true });
  }
}
