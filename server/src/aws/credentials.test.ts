import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRegionFor, listProfiles, resolveCredentials } from './credentials.ts';

// A first-run person: no profiles yet, then `aws configure` while Orrery keeps running.
const dir = mkdtempSync(join(tmpdir(), 'orrery-aws-'));
const configFile = join(dir, 'config');
const credentialsFile = join(dir, 'credentials');
writeFileSync(configFile, '');
writeFileSync(credentialsFile, '');
process.env.AWS_CONFIG_FILE = configFile;
process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile;

test('profiles and credentials added after startup are picked up without a restart', async () => {
  assert.deepEqual(await listProfiles(), []);
  await assert.rejects(resolveCredentials({ kind: 'profile', profile: 'late' })());

  writeFileSync(configFile, '[profile late]\nregion = ap-northeast-2\n');
  writeFileSync(credentialsFile, '[late]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = example\n');

  assert.deepEqual((await listProfiles()).map((p) => [p.name, p.region, p.method]), [['late', 'ap-northeast-2', 'static']]);
  assert.equal(await defaultRegionFor({ kind: 'profile', profile: 'late' }), 'ap-northeast-2');
  assert.equal((await resolveCredentials({ kind: 'profile', profile: 'late' })()).accessKeyId, 'AKIAEXAMPLE');
});
