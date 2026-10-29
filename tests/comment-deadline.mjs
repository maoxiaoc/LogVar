import test from 'node:test';import assert from 'node:assert/strict';
for(const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']){
 test(base+': bounded merged comments',async t=>{
  const {collectCommentGroups}=await import(base+'/utils/comment-deadline.js');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  await t.test('first usable source starts grace window; unfinished result cannot alter returned values',async()=>{
   let late=0;const groups=[[{index:0,factory:async()=>{await sleep(4);return ['a'];}}],[{index:1,factory:async()=>{await sleep(80);late++;return ['b','c'];}}]];
   const result=await collectCommentGroups(groups,2,2,{graceMs:15,totalMs:150,gapMs:1,isReady:data=>data.length>0});
   assert.equal(result.partial,true);assert.deepEqual(result.values,[['a'],[]]);await sleep(90);assert.equal(late,1);assert.deepEqual(result.values,[['a'],[]]);
  });
  await t.test('completed groups preserve source order, same-source serialization and limit',async()=>{
   let active=0,peak=0;const starts=[];const make=(index,wait)=>({index,factory:async()=>{starts.push(index);peak=Math.max(peak,++active);await sleep(wait);active--;return [index];}});
   const result=await collectCommentGroups([[make(0,6),make(2,1)],[make(1,2)],[make(3,1)]],4,2,{graceMs:100,totalMs:200,gapMs:1,isReady:data=>data.length>0});
   assert.equal(result.partial,false);assert.deepEqual(result.values,[[0],[1],[2],[3]]);assert.ok(peak<=2);assert.ok(starts.indexOf(2)>starts.indexOf(0));
  });
  await t.test('no comments stops at total budget',async()=>{
   const result=await collectCommentGroups([[{index:0,factory:async()=>{await sleep(80);return [];}}]],1,1,{graceMs:10,totalMs:15});
   assert.equal(result.partial,true);assert.deepEqual(result.values,[[]]);await sleep(90);
  });
 });
}
