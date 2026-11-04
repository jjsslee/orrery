import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate, isLanguage, detectLanguage } from '@orrery/shared';
import { ENGLISH } from '../../../shared/src/translations/en';
import { getLanguage, setLanguage, uiText, locale } from '../i18n';
import { fmtProp, fmtRelative } from './format';
import { TopBar } from '../panels/TopBar';
import { useStore } from '../model/store';

test('catalog preserves interpolation parameters and translates dynamic server messages', () => {
  for (const [source, english] of Object.entries(ENGLISH)) {
    assert.deepEqual([...english.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(), [...source.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort(), source);
  }
  assert.equal(translate('ko', '모니터링'), '모니터링');
  assert.equal(translate('en', '모니터링'), 'Monitoring');
  const name='정상 {0} <demo>';
  const tagged=translate('en', Object.assign(['',' 점검'],{raw:['',' 점검']}) as unknown as TemplateStringsArray, name);
  assert.ok(tagged.includes(name));
  assert.ok(!/[가-힣]/.test(translate('en', '5분 전')));
  assert.equal(translate('en', '정상 · 모니터링'), 'Healthy · Monitoring');
  assert.equal(isLanguage('en-US'), false);
  assert.equal(detectLanguage('ko-KR'), 'ko');
  assert.equal(detectLanguage('fr-FR'), 'en');
});

test('language preference persists, updates document and leaves connection/filter/resource state untouched', () => {
  const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  const saved=new Map<string,string>();
  const document={documentElement:{lang:'ko'}};
  Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:{setItem:(k:string,v:string)=>saved.set(k,v)}}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:document});
  const before=useStore.getState();
  try {
    setLanguage('en');
    assert.equal(saved.get('orrery.language'),'en');
    assert.equal(document.documentElement.lang,'en');
    assert.equal(locale(),'en-US');
    assert.equal(uiText('언어'),'Language');
    assert.equal(fmtProp(true),'Yes');
    assert.equal(fmtProp('정상'),'정상');
    assert.equal(fmtProp('정상','설명'),'정상');
    assert.equal(fmtProp('정상','상태'),'Healthy');
    assert.equal(fmtProp('2개, 100 GiB (gp3, 암호화)','볼륨'),'2 volumes, 100 GiB (gp3, Encrypted)');
    assert.match(fmtRelative(Date.now()-300_000),/5/);
    const html=renderToStaticMarkup(createElement(TopBar));
    assert.match(html,/aria-label="Language"/);
    assert.match(html,/>Topology<\/button>/);
    assert.match(html,/>Monitoring<\/button>/);
    assert.equal(useStore.getState(),before);
    setLanguage('ko');
    assert.match(renderToStaticMarkup(createElement(TopBar)),/>토폴로지<\/button>/);
    assert.equal(useStore.getState(),before);
    Object.defineProperty(globalThis,'window',{configurable:true,value:{get localStorage(){throw new Error('denied')}}});
    assert.doesNotThrow(()=>setLanguage('en'));
    assert.equal(getLanguage(),'en');
  } finally {
    setLanguage('ko');
    if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');
    if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else Reflect.deleteProperty(globalThis,'document');
  }
});

test('saved language wins over browser defaults on a fresh frontend load',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'window');
 try{
  for(const [saved,browser,expected] of [['en','ko-KR','en'],['ko','en-US','ko'],['fr','ko-KR','ko'],[null,'ja-JP','en']] as const){
   Object.defineProperty(globalThis,'window',{configurable:true,value:{navigator:{language:browser},localStorage:{getItem:()=>saved}}});
   const module=await import(new URL(`../i18n.ts?fresh=${saved}-${browser}`,import.meta.url).href);
   assert.equal(module.getLanguage(),expected);
  }
 }finally{if(original)Object.defineProperty(globalThis,'window',original);else Reflect.deleteProperty(globalThis,'window')}
});

test('metric titles translate as complete labels and unknown titles never become time fragments',()=>{
 assert.equal(translate('en','오류 수'),'Errors');
 assert.equal(translate('en','최장 대기 시간'),'Oldest message age');
 assert.equal(translate('ko','최장 대기 시간'),'최장 대기 시간');
 assert.equal(translate('en','재시도 시간'),'재시도 시간');
 assert.equal(translate('en','3시간'),'3 hours');
 assert.equal(translate('en','12시간'),'12h');
 assert.equal(translate('en','180분 집계'),'180-minute aggregation');
 for(const raw of ['__proto__','constructor','toString'])assert.equal(translate('en',raw),raw);
});
