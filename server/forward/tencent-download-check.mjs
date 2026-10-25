import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

function tencentHost(code, player, {hangPage = false, emptyFirst = false} = {}) {
  const requests = [], traces = [];
  let baseCalls = 0;
  const url = 'https://v.qq.com/x/cover/test/fixturevid.html';
  const episode = {id:10002,url,title:'【qq】 第1集'};
  const store = new Map([['logvar.danmu.state.v1',JSON.stringify({
    animes:[{animeId:501,bangumiId:'501',animeTitle:'测试作品 from tencent',episodeCount:1,links:[episode]}],
    episodeNum:10002,episodeIds:[episode]})]]);
  const context = vm.createContext({
    console:{log(...args){traces.push(args.join(' '))},info(){},warn(){},error(){}},
    Widget:{storage:{async get(key){return store.get(key)},async set(key,value){store.set(key,value)}},
      http:{async get(input) {
        requests.push(input);
        // Reproduce a native player request that never returns from the HTML
        // page, while both actual danmu endpoints are available immediately.
        let data;
        if (new URL(input).hostname === 'v.qq.com') {
          if (hangPage) return new Promise(()=>{});
          data = '<title>测试作品</title>';
        }
        else if(input.includes('/barrage/base/')) {
          baseCalls++;
          data = {segment_index:emptyFirst && baseCalls === 1 ? {} : {first:{segment_start:0,segment_name:'0/300000'}}};
        }
        else if(input.includes('/barrage/segment/')) data = {barrage_list:[{time_offset:1000,content:'腾讯正常弹幕',up_count:'0'}]};
        else assert.fail('Unexpected Tencent request');
        return {[player === 'rex' ? 'statusCode' : 'status']:200,data};
      }},
    },
  });
  new vm.Script(code).runInContext(context,{timeout:10000});
  return {context,requests,store,traces};
}

export async function verifyTencentEmptyPrepared(code, player) {
  const {context,requests,store} = tencentHost(code,player,{emptyFirst:true});
  const params = {animeId:501,episode:1,enabledSources:'tencent',sourceMode:'most',groupMinute:0};
  const [episode] = await context.getDetailById(params);
  const result = await context.getCommentsById({...params,commentId:episode.episodeId});
  assert.equal(result.count,1,'An empty prefetch must retry on playback instead of reusing cached zero comments');
  assert.equal(requests.filter(url=>url.includes('/barrage/base/')).length,2);
  const packets = JSON.parse(store.get('logvar.danmu.prepared.v1') || '[]');
  assert.ok(!packets.some(packet=>!packet.comments?.length),'Never persist empty prepared comments');
  // Also recover a zero-comment token already created by 1.0.17.
  const old = tencentHost(code,player);
  const key = JSON.stringify([JSON.stringify(old.context.LogvarForward.normalizeConfig(params)),
    'https://v.qq.com/x/cover/test/fixturevid.html','【qq】 第1集']);
  old.store.set('logvar.danmu.prepared.v1',JSON.stringify([{
    key,token:'old-empty',epoch:'0',expires:Date.now()+600000,episodeId:10002,source:null,comments:[],
  }]));
  const retried = await old.context.getCommentsById({...params,
    commentId:'lv2:episode:10002:aaaaaaaaaaaaaaaaaaaaaaaa:0:old-empty'});
  assert.equal(retried.count,1,'Old zero-comment tokens must fall back to a new download');
  assert.equal(old.requests.filter(url=>url.includes('/barrage/base/')).length,1);
}

export async function verifyTencentDownload(code, player) {
  const {context,requests,traces} = tencentHost(code,player,{hangPage:true});
  const playback = context.getCommentsById({commentId:10002,enabledSources:'tencent',sourceMode:'most',groupMinute:0});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(requests.some(input=>input.includes('/barrage/base/')),
    'Tencent playback must reach the danmu endpoint without waiting for an unrelated HTML title page');
  const result = await playback;
  assert.equal(result.count,1);
  assert.equal(result.comments[0].m,'腾讯正常弹幕');
  assert.ok(!requests.some(input=>new URL(input).hostname==='v.qq.com'));
  for(const phase of ['tencent-start','tencent-index','tencent-download','tencent-data'])
    assert.ok(traces.some(line=>line.includes('"phase":"'+phase+'"')),'Tencent progress must identify '+phase);
}

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {default:metadata} = await import('./metadata.js');
  const code = await readFile(new URL(`../dist/logvar-${metadata.version}.js`,import.meta.url),'utf8');
  for (const player of ['forward','rex']) {
    await verifyTencentEmptyPrepared(code,player);
    if(!process.argv.includes('--empty-only')) await verifyTencentDownload(code,player);
  }
  console.log('Tencent native playback reaches danmu directly when the HTML page is blocked.');
}
