import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerLocalSecurity } from './security';
import { registerLanguageRoute } from './language';

test('language preference accepts only supported values through existing local authenticated API',async()=>{
 const app=Fastify(), notifications:string[]=[];
 registerLocalSecurity(app,'dummy-language-token');
 registerLanguageRoute(app,language=>notifications.push(language));
 const headers={host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000',authorization:'Bearer dummy-language-token'};
 try{
  for(const language of ['en','ko']){
   const result=await app.inject({method:'POST',url:'/api/preferences/language',headers,payload:{language}});
   assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{language});
  }
  for(const payload of [{language:'fr'},{language:'../../tmp'},{language:1},{}])assert.equal((await app.inject({method:'POST',url:'/api/preferences/language',headers,payload})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/preferences/language',headers:{...headers,authorization:''},payload:{language:'en'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/preferences/language',headers:{...headers,origin:'https://example.com'},payload:{language:'en'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/preferences/language',headers,payload:{language:'en',padding:'x'.repeat(200)}})).statusCode,413);
  assert.deepEqual(notifications,['en','ko']);
 }finally{await app.close()}
});
