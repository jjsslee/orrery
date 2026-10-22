/**
 * Credential sources.
 * Today Orrery reads local shared-config profiles; the CredentialSourceSpec
 * union in @orrery/shared leaves room for assume-role / environment / SSO
 * device flows without touching collectors.
 */
import { fromIni, fromEnv, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import type { CredentialSourceSpec, ProfileInfo } from '@orrery/shared';

export type CredentialProvider = ReturnType<typeof fromIni>;

export function resolveCredentials(spec: CredentialSourceSpec): CredentialProvider {
  switch (spec.kind) {
    case 'profile':
      // ignoreCache: the SDK otherwise keeps the first read of ~/.aws for the life of the process,
      // so a profile made with `aws configure` while Orrery runs would stay invisible.
      return fromIni({ profile: spec.profile, ignoreCache: true });
    case 'environment':
      return fromEnv();
    case 'assume-role':
      return fromTemporaryCredentials({
        params: { RoleArn: spec.roleArn, ExternalId: spec.externalId, RoleSessionName: 'orrery-readonly' },
        masterCredentials: spec.baseProfile ? fromIni({ profile: spec.baseProfile }) : undefined,
      });
  }
}

export function describeSource(spec: CredentialSourceSpec): string {
  switch (spec.kind) {
    case 'profile':
      return `profile:${spec.profile}`;
    case 'environment':
      return 'environment';
    case 'assume-role':
      return `assume-role:${spec.roleArn}`;
  }
}

/** Parse `?profile=` / `?source=` query parameters into a spec. */
export function sourceFromQuery(q: Record<string, unknown>): CredentialSourceSpec {
  const kind = typeof q.source === 'string' ? q.source : 'profile';
  if (kind === 'environment') return { kind: 'environment' };
  if (kind === 'assume-role' && typeof q.roleArn === 'string') {
    return { kind: 'assume-role', roleArn: q.roleArn, baseProfile: typeof q.profile === 'string' ? q.profile : undefined };
  }
  const profile = typeof q.profile === 'string' && q.profile.length > 0 ? q.profile : process.env.AWS_PROFILE ?? 'default';
  if (!/^[A-Za-z0-9_.@:+=,-]{1,128}$/.test(profile)) throw new Error(`프로필 이름이 올바르지 않습니다: ${profile}`);
  return { kind: 'profile', profile };
}

function detectMethod(config: Record<string, string> | undefined, creds: Record<string, string> | undefined): string {
  if (creds?.aws_access_key_id) return creds.aws_session_token ? 'static (session)' : 'static';
  if (config?.sso_session || config?.sso_start_url) return 'sso';
  if (config?.role_arn) return 'assume-role';
  if (config?.credential_process) return 'process';
  if (config?.aws_access_key_id) return 'static';
  if (config?.web_identity_token_file) return 'web-identity';
  return 'unknown';
}

export async function listProfiles(): Promise<ProfileInfo[]> {
  const { configFile, credentialsFile } = await loadSharedConfigFiles({ ignoreCache: true });
  const names = new Set<string>([...Object.keys(configFile), ...Object.keys(credentialsFile)]);
  const out: ProfileInfo[] = [];
  for (const name of names) {
    if (name.startsWith('sso-session')) continue;
    const config = configFile[name] as Record<string, string> | undefined;
    const creds = credentialsFile[name] as Record<string, string> | undefined;
    out.push({
      name,
      region: config?.region ?? creds?.region,
      method: detectMethod(config, creds),
      isDefault: name === 'default',
    });
  }
  return out.sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name)));
}

export async function defaultRegionFor(spec: CredentialSourceSpec): Promise<string> {
  if (spec.kind === 'profile') {
    const { configFile } = await loadSharedConfigFiles({ ignoreCache: true });
    const region = (configFile[spec.profile] as Record<string, string> | undefined)?.region;
    if (region) return region;
  }
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
}
