import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createPackage } from '@electron/asar';

// Stored ZIPs keep the native integration fixture small and independent of OS zip tools.
function zip(entries: Array<{ name: string; content: Buffer }>): Buffer {
 const local:Buffer[]=[], central:Buffer[]=[];let offset=0;
 for(const {name:filename,content} of entries){
  const name=Buffer.from(filename);let crc=0xffffffff;
  for(const byte of content){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}crc=(crc^0xffffffff)>>>0;
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(content.length,18);header.writeUInt32LE(content.length,22);header.writeUInt16LE(name.length,26);
  const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x0314,4);record.writeUInt16LE(20,6);record.writeUInt32LE(crc,16);record.writeUInt32LE(content.length,20);record.writeUInt32LE(content.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE((0o100644<<16)>>>0,38);record.writeUInt32LE(offset,42);
  local.push(header,name,content);central.push(record,name);offset+=header.length+name.length+content.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}

test('real Electron prepares ASAR bytes, preserves validation and cleans up without changing the installed app',async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'orrery-electron-update-')));
 try{
  const require=createRequire(import.meta.url),electronRoot=dirname(require.resolve('electron/package.json'));
  const executable=join(electronRoot,'dist',(await readFile(join(electronRoot,'path.txt'),'utf8')).trim());
  const source=join(directory,'source');await mkdir(source);await writeFile(join(source,'marker.txt'),'ASAR reading remains enabled');
  const compiled=join(source,'updater.cjs');
  await build({entryPoints:[fileURLToPath(new URL('../src/update-install.ts',import.meta.url))],outfile:compiled,bundle:true,platform:'node',format:'cjs',target:'node24'});
  const asar=join(directory,'control.asar');await createPackage(source,asar);
  const archive=join(directory,'update.zip');await writeFile(archive,zip([
   {name:'Orrery/Orrery.exe',content:Buffer.from('MZdummy')},
   {name:'Orrery/resources/app.asar',content:await readFile(asar)},
   {name:'Orrery/resources/orrery-update.json',content:Buffer.from(JSON.stringify({format:1,version:'1.2.3',platform:'win32',arch:'x64'}))},
  ]));
  const bundle=join(asar,'updater.cjs');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(executable,[fileURLToPath(new URL('./update-electron-fixture.cjs',import.meta.url)),bundle,archive,asar,directory],{env,timeout:30_000});
  assert.match(stdout,/"prepared":true/);assert.match(stdout,/"globalAsarEnabled":true/);
 }finally{await rm(directory,{recursive:true,force:true})}
});
