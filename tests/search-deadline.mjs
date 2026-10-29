import test from 'node:test';import assert from 'node:assert/strict';
for(const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']){
 test(base+': bounded source search',async t=>{
  const {collectSearchTasks}=await import(base+'/utils/search-deadline.js');
  const {addAnime}=await import(base+'/utils/cache-util.js');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await t.test('returns available results after grace and ignores late cache writes',async()=>{
   const scope={closed:false,startedAt:Date.now()},ready={animes:[],detailStore:new Map()},slow={animes:[],detailStore:new Map()};
   ready.promise=(async()=>{await sleep(5);ready.animes.push({episodeCount:1});ready.detailStore.set('x',{});})();
   slow.promise=sleep(100);const before=Date.now();const outcome=await collectSearchTasks([ready,slow],scope,{graceMs:20,totalMs:300});
   assert.equal(outcome.partial,true);assert.equal(outcome.results[0].status,'fulfilled');assert.ok(Date.now()-before<95);assert.equal(scope.closed,true);
   const late=new Map();late.__searchScope=scope;assert.equal(addAnime(null,late),false);await slow.promise;
  });
  await t.test('no useful result stops at total limit',async()=>{
   const scope={closed:false,startedAt:Date.now()},task={animes:[],detailStore:new Map(),promise:sleep(100)};
   const result=await collectSearchTasks([task],scope,{graceMs:10,totalMs:20});assert.equal(result.partial,true);assert.equal(scope.closed,true);await task.promise;
  });
  await t.test('all completed empty results are not partial',async()=>{
   const scope={closed:false,startedAt:Date.now()},task={animes:[],detailStore:new Map(),promise:Promise.resolve()};
   const result=await collectSearchTasks([task],scope,{graceMs:10,totalMs:100});assert.equal(result.partial,false);
  });
 });
}
