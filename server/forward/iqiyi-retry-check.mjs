import assert from 'node:assert/strict';
import vm from 'node:vm';

// Run the actual bundled source in a timerless native host, for either build.
export async function verifyIqiyiRetries(code, player) {
  function probe(respond) {
    const requests = [], errors = [];
    const context = vm.createContext({
      console: {log(){}, info(){}, warn(){}, error(...args){errors.push(args.join(' '));}},
      Widget: {storage:{async get(){}, async set(){}}, http:{async get(url) {
        requests.push(url);
        return {[player === 'rex' ? 'statusCode' : 'status']:200, data:await respond(url)};
      }}},
    });
    const marker = 'function getSourceByKey(key) {';
    assert.ok(code.includes(marker));
    new vm.Script(code.replace(marker, 'globalThis.probeSource = getSourceByKey;\n' + marker))
      .runInContext(context, {timeout:10000});
    return {source:context.probeSource('iqiyi'), requests, errors};
  }
  const validSearch = {code:'0',data:{templates:[{template:101,
    albumInfo:{title:'测试电影',channel:'电影',qipuId:'211411014'}}]}};
  for (const primary of [null, {code:'-1'}, {code:-1}]) {
    const p = probe(url => url.startsWith('https://mesh.if.iqiyi.com/') ? primary : validSearch);
    assert.equal((await p.source.search('测试电影')).length,1);
    assert.equal(p.requests.length,2);
    assert.match(p.requests[1],/^https:\/\/www\.iqiyi\.com\/prelw\/portal\/lw\/search/);
    assert.ok(!p.errors.some(e=>e.includes('不支持计时器')));
  }
  for (const response of [{code:'-1'}, {code:'0',data:{templates:[]}}, validSearch]) {
    const p = probe(() => response);
    assert.equal((await p.source.search('测试电影')).length,response === validSearch ? 1 : 0);
    assert.equal(p.requests.length,response.code === '-1' ? 2 : 1,
      'At most one alternate request; no retry for normal empty results');
  }
  for (const primary of [null, {status_code:1}, {status_code:0,data:{}}]) {
    for (const success of [true,false]) {
      const p = probe(url => success && url.startsWith('https://mesh.if.iqiyi.com/')
        ? {status_code:0,data:{template:{}}} : primary);
      assert.equal(!!await p.source._fetchBaseInfoData('211411014'),success);
      assert.equal(p.requests.length,2,'Base-info fallback is bounded');
      assert.match(p.requests[1],/^https:\/\/mesh\.if\.iqiyi\.com\/tvg\/v2\/lw\/base_info/);
      assert.ok(!p.errors.some(e=>e.includes('不支持计时器')));
    }
  }
  const validDetails = probe(() => ({status_code:0,data:{template:{}}}));
  assert.ok(await validDetails.source._fetchBaseInfoData('211411014'));
  assert.equal(validDetails.requests.length,1);
}
