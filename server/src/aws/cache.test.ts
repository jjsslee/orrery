import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, readdir, chmod, symlink, writeFile, readFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Cache} from '../cache.ts';
import {scopeKey} from './sessions.ts';
import {describeSource} from './credentials.ts';
test('cache restricts new and existing directory/file permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-private-cache-'));
  try {
    await chmod(dir, 0o755);
    await new Cache(dir).set('dummy', { privateResource: 'dummy' });
    const file = join(dir, (await readdir(dir))[0]);
    if (process.platform !== 'win32') {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      await chmod(file, 0o644);
      await chmod(dir, 0o755);
      assert.deepEqual(await new Cache(dir).get('dummy', 10000), { privateResource: 'dummy' });
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy cache symlinks are rejected without reading or modifying their target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-cache-link-'));
  try {
    const cacheDir = join(dir, 'cache'), targetDir = join(dir, 'unrelated');
    await mkdir(targetDir);
    const target = join(targetDir, 'unrelated.txt');
    await writeFile(target, 'dummy unrelated data', { mode: 0o644 });
    // Windows junctions do not require the symlink privilege/developer mode.
    await symlink(targetDir, cacheDir, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(new Cache(cacheDir).initialize(), /일반/);
    assert.equal(await readFile(target, 'utf8'), 'dummy unrelated data');
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o644);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('distinct source keys cannot collide on disk',async()=>{const dir=await mkdtemp(join(tmpdir(),'orrery-cache-'));try{const c=new Cache(dir); await c.set('profile:a/b',1);await c.set('profile:a?b',2);assert.equal(await new Cache(dir).get('profile:a/b',10000),1);}finally{await rm(dir,{recursive:true,force:true});}});
test('assume role source includes base profile and never reveals external ID',()=>{const a=describeSource({kind:'assume-role',roleArn:'arn:aws:iam::000000000000:role/test',baseProfile:'one',externalId:'secret-test'});const b=describeSource({kind:'assume-role',roleArn:'arn:aws:iam::000000000000:role/test',baseProfile:'two',externalId:'secret-test'});assert.notEqual(a,b);assert.ok(!a.includes('secret-test'));});
test('status cache updates keep topology expiry and reject an older graph after replacement',async()=>{const dir=await mkdtemp(join(tmpdir(),'orrery-cache-'));const now=Date.now;let time=1000;Date.now=()=>time;try{const c=new Cache(dir);const old={value:1};await c.set('g',old);time=1050;await c.update('g',old,old);time=1101;assert.equal(await c.get('g',100),undefined);time=1102;const fresh={value:2};await c.set('g',fresh);await c.update('g',old,old);assert.deepEqual(await c.get('g',100),fresh);}finally{Date.now=now;await rm(dir,{recursive:true,force:true});}});


test('graph cache separates legacy data and each credential/account/region scope on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-graph-cache-'));
  try {
    const cache = new Cache(dir);
    await cache.set(scopeKey('graph-v6', 'profile:a', '000000000000', 'r1'), { legacy: true });
    assert.equal(await cache.get(scopeKey('graph-v7', 'profile:a', '000000000000', 'r1'), 10000), undefined);
    const scopes = [
      ['profile:a', '000000000000', 'r1'], ['profile:b', '000000000000', 'r1'],
      ['profile:a', '111111111111', 'r1'], ['profile:a', '000000000000', 'r2'],
    ];
    for (const [source, account, region] of scopes) await cache.set(scopeKey('graph-v7', source, account, region), { source, account, region });
    const reopened = new Cache(dir);
    for (const [source, account, region] of scopes) assert.deepEqual(await reopened.get(scopeKey('graph-v7', source, account, region), 10000), { source, account, region });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
