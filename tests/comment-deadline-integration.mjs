import test from 'node:test';import assert from 'node:assert/strict';
for(const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']){
 test(base+': merged comment cache does not retain partial result',async t=>{
  const {Globals,globals}=await import(base+'/configs/globals.js');const {getSourceByKey}=await import(base+'/sources/registry.js');
  const {addAnime}=await import(base+'/utils/cache-util.js');const {getComment}=await import(base+'/apis/dandan-api.js');
  Globals.init({SOURCE_ORDER:'tencent,iqiyi',LOG_LEVEL:'error',MAX_DANMU_SOURCE:'false',COMMENT_CACHE_MINUTES:'30',COMMENT_CACHE_MIN_COUNT:'0'});
  const ten=getSourceByKey('tencent'),iq=getSourceByKey('iqiyi'),oldTen=ten.getEpisodeDanmu,oldIq=iq.getEpisodeDanmu,oldTenFormat=ten.formatComments,oldIqFormat=iq.formatComments,oldTimer=globalThis.setTimeout;
  const sleep=ms=>new Promise(r=>oldTimer(r,ms));let fastCalls=0,slowCalls=0;
  ten.getEpisodeDanmu=async()=>{fastCalls++;return [{p:'1,1,25,16777215,0,0,0,0',m:'fast'}];};
  iq.getEpisodeDanmu=async()=>{slowCalls++;if(slowCalls===1)await sleep(90);return [{p:'2,1,25,16777215,0,0,0,0',m:'slow1'},{p:'3,1,25,16777215,0,0,0,0',m:'completely-different'}];};
  ten.formatComments=iq.formatComments=values=>values;
  globalThis.setTimeout=(fn,ms,...args)=>oldTimer(fn,ms===10000?20:ms===30000?200:ms,...args);
  try {
   addAnime({animeId:123456,bangumiId:'fixture-123456',animeTitle:'测试(2026)',source:'tencent',links:[{title:'【腾讯&iqiyi】 第1集',url:'tencent:https://v.qq.com/x/fixture$$$iqiyi:https://www.iqiyi.com/v_fixture.html'}]});
   const {getBangumi}=await import(base+'/apis/dandan-api.js');const details=await(await getBangumi('/api/v2/bangumi/123456')).json();const id=details.bangumi.episodes[0].episodeId;
   const first=await(await getComment('/api/v2/comment/'+id,'json',false,'127.0.0.1')).json();assert.equal(first.count,1);
   await sleep(100);
   const second=await(await getComment('/api/v2/comment/'+id,'json',false,'127.0.0.1')).json();assert.equal(second.count,3);assert.equal(fastCalls,2);assert.equal(slowCalls,2);
   const third=await(await getComment('/api/v2/comment/'+id,'json',false,'127.0.0.1')).json();assert.equal(third.count,3);assert.equal(fastCalls,2);
   globals.maxDanmuSource=true;
   addAnime({animeId:123457,bangumiId:'fixture-123457',animeTitle:'测试最多(2026)',source:'tencent',links:[{title:'【腾讯&iqiyi】 第1集',url:'tencent:https://v.qq.com/x/fixture2$$$iqiyi:https://www.iqiyi.com/v_fixture2.html'}]});
   const maxDetail=await(await getBangumi('/api/v2/bangumi/123457')).json();
   const max=await(await getComment('/api/v2/comment/'+maxDetail.bangumi.episodes[0].episodeId,'json',false,'127.0.0.1')).json();
   assert.equal(max.count,2);assert.deepEqual(max.comments.map(x=>x.m),['slow1','completely-different']);
  }finally{globalThis.setTimeout=oldTimer;ten.getEpisodeDanmu=oldTen;iq.getEpisodeDanmu=oldIq;ten.formatComments=oldTenFormat;iq.formatComments=oldIqFormat;}
 });
}
