import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source=await readFile(new URL('./sw-runtime.js',import.meta.url),'utf8');
async function inspect(failure='') {
  const handlers={};const messages=[];const keys=[];let waited;
  const types={'/':'text/html','/index.html':'text/html','/app.js':'text/javascript','/app.css':'text/css'};
  runInNewContext(source,{
    APP_SHELL:Object.keys(types),CACHE_VERSION:'leader-field-test',URL,
    Request:class { constructor(path){this.url=new URL(path,'https://offline.example.invalid').href;this.destination='';} },
    self:{location:{origin:'https://offline.example.invalid'},addEventListener:(name,handler)=>{handlers[name]=handler;}},
    caches:{open:async key=>{keys.push(key);if(failure==='storage') throw new Error('unavailable');return{match:async request=>{
      const pathname=new URL(request.url).pathname;
      if(failure==='missing'&&pathname==='/app.js') return undefined;
      return {ok:failure!=='bad-status',type:failure==='opaque'?'opaque':'basic',headers:{get:()=>failure==='wrong-mime'?'text/html':types[pathname]}};
    }};}}
  });
  handlers.message({data:{type:'OFFLINE_READINESS_CHECK'},ports:[{postMessage:m=>messages.push(m)}],waitUntil:p=>{waited=p;}});
  await waited;
  assert.deepEqual(keys,['leader-field-test']);
  assert.equal(messages.length,1);
  assert.equal(messages[0].type,'OFFLINE_READINESS_RESULT');
  assert.equal(messages[0].cacheVersion,'leader-field-test');
  assert.equal(messages[0].ready,!failure);
  handlers.message({data:{type:'OFFLINE_READINESS_CHECK'},ports:[],waitUntil:()=>assert.fail('No port')});
  assert.equal(messages.length,1);
}
for(const failure of ['', 'missing','bad-status','opaque','wrong-mime','storage']) await inspect(failure);
console.log('ok - controlling service worker proves complete active cache, rejects missing/non-OK/opaque/wrong-type/unreadable assets and ignores missing reply ports');
