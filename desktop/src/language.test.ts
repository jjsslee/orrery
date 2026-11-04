import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLanguage, saveLanguage } from './language';

test('desktop language survives restart and malformed preferences fall back safely',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'orrery-language-'));
 try{
  assert.equal(await readLanguage(directory),undefined);
  for(const language of ['en','ko'] as const){await saveLanguage(directory,language);assert.equal(await readLanguage(directory),language)}
  assert.deepEqual(await readdir(directory),['language.json']);
  const previous=await readFile(join(directory,'language.json'),'utf8');
  await saveLanguage(directory,'../../dummy' as 'en');
  assert.equal(await readFile(join(directory,'language.json'),'utf8'),previous);
  for(const content of ['broken','null','{}','{"language":"fr"}']){await writeFile(join(directory,'language.json'),content);assert.equal(await readLanguage(directory),undefined)}
 }finally{await rm(directory,{recursive:true,force:true})}
});
