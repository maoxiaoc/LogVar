import test from 'node:test';import assert from 'node:assert/strict';
for(const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']){
 test(base+': match labels reflect actual comments',async t=>{
  const {annotateMatchSources}=await import(base+'/utils/match-source-labels.js');
  const response=()=>new Response(JSON.stringify({isMatched:true,matches:[{episodeId:1,animeTitle:'示例(2026)【动画】from renren&tencent',episodeTitle:'【renren&tencent】 第01集'}]}),{headers:{'content-type':'application/json'}});
  const label=async(comments)=> (await(await annotateMatchSources(response(),async()=>comments,100)).json()).matches[0];
  await t.test('only sources in valid returned comments appear in titles',async()=>{const m=await label([{p:'1,1,16777215,[tencent]',m:'实际弹幕'}]);assert.equal(m.animeTitle,'示例(2026)【动画】 from tencent');assert.equal(m.episodeTitle,'【tencent】 第01集');});
  await t.test('merge includes only contributing sources and preserves candidate order',async()=>{const m=await label([{p:'1,1,1,[tencent]',m:'a'},{p:'2,1,1,[renren]',m:'b'}]);assert.match(m.animeTitle,/from renren&tencent$/);assert.match(m.episodeTitle,/^【renren&tencent】/);});
  await t.test('empty, failure and deadline never invent a source',async()=>{for(const cb of [async()=>[],async()=>{throw Error('failed')},()=>new Promise(()=>{})]){const m=(await(await annotateMatchSources(response(),cb,5)).json()).matches[0];assert.equal(m.animeTitle,'示例(2026)【动画】');assert.equal(m.episodeTitle,'第01集');}});
 });
 test(base+': most mode uses filtered counts',async()=>{
  const {Globals,globals}=await import(base+'/configs/globals.js');const {getSourceByKey}=await import(base+'/sources/registry.js');const {addAnime}=await import(base+'/utils/cache-util.js');const {getComment}=await import(base+'/apis/dandan-api.js');
  Globals.init({SOURCE_ORDER:'tencent,iqiyi',MAX_DANMU_SOURCE:'true',BLOCKED_WORDS:'广告',LOG_LEVEL:'error'});
  const sources=['tencent','iqiyi'].map(getSourceByKey),original=sources.map(s=>[s.getEpisodeDanmu,s.formatComments]);
  sources[0].getEpisodeDanmu=async()=>[{p:'1,1,16777215',m:'广告一'},{p:'2,1,16777215',m:'广告二'},{p:'3,1,16777215',m:'真实一'}];
  sources[1].getEpisodeDanmu=async()=>[{p:'4,1,16777215',m:'真实二'},{p:'5,1,16777215',m:'真实三'}];
  sources.forEach(s=>s.formatComments=x=>x);
  try{addAnime({animeId:123456,bangumiId:'123456',animeTitle:'示例(2026)【动画】from tencent&iqiyi',type:'动画',typeDescription:'动画',imageUrl:'',startDate:'2026-01-01',episodeCount:1,rating:0,isFavorited:false,source:'tencent',links:[{title:'【tencent&iqiyi】第01集',url:'tencent:https://v.qq.com/test$$$iqiyi:https://www.iqiyi.com/v_test.html'}]});
   const episode=globals.animes.find(a=>a.animeId===123456).links[0].id;
   const data=await(await getComment('/api/v2/comment/'+episode,'json',false,'127.0.0.1')).json();
   assert.equal(data.count,2);assert.deepEqual(data.comments.map(c=>c.m),['真实二','真实三']);assert.ok(data.comments.every(c=>c.p.includes('[iqiyi]')));
  }finally{sources.forEach((s,i)=>{[s.getEpisodeDanmu,s.formatComments]=original[i]});}
 });
}
