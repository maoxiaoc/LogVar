import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import https from 'node:https';
import {once} from 'node:events';

for (const base of ['../server/danmu_api', '../app/src/main/assets/nodejs-project/danmu_api']) {
  test(base + ': proxy preserves App API requests', async t => {
    const source=readFileSync(new URL(base+'/server.js',import.meta.url),'utf8');
    const start=source.indexOf('function createProxyServer()');
    const end=source.indexOf('\n/**',start);
    const createProxyServer=vm.runInNewContext('('+source.slice(start,end).trim()+')', {
      http,https,URL,process:{env:{}},console:{log(){},error(){}},
      HttpsProxyAgent:class {constructor(){throw new Error('Unexpected external proxy in offline test');}}
    });
    let seen;
    const upstream=http.createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      seen={method:req.method,url:req.url,body,header:req.headers['x-sign']};
      setTimeout(()=>{res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));},30);
    });
    const gateway=createProxyServer();
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
    const url='http://127.0.0.1:'+gateway.address().port+'/proxy?url='+encodeURIComponent('http://127.0.0.1:'+upstream.address().port+'/api/List/GetTitleGetData?_t=123');
    try {
      await t.test('POST body, signing header and delayed response survive forwarding',async()=>{
        const body=JSON.stringify({SearchCriteria:'偷天父子兵'});
        const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-sign':'fixture'},body,signal:AbortSignal.timeout(2000)});
        assert.equal(response.status,201, response.status === 201 ? '' : await response.text());
        assert.deepEqual(await response.json(),{ok:true});
        assert.equal(seen.method,'POST');assert.equal(seen.body,body);assert.equal(seen.header,'fixture');
        assert.equal(seen.url,'/api/List/GetTitleGetData?_t=123');
      });
      await t.test('existing GET requests still work',async()=>{
        const response=await fetch(url,{signal:AbortSignal.timeout(2000)});
        assert.equal(response.status,201);assert.deepEqual(await response.json(),{ok:true});
        assert.equal(seen.method,'GET');assert.equal(seen.body,'');
      });
    }finally{gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>upstream.close(r))]);}
  });
}
