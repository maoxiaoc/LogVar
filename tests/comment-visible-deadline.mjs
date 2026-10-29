import test from 'node:test';import assert from 'node:assert/strict';
for(const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']){
 test(base+': only visible comments start grace window',async()=>{
  const {Globals}=await import(base+'/configs/globals.js');const {collectCommentGroups,hasVisibleComments}=await import(base+'/utils/comment-deadline.js');
  Globals.init({LOG_LEVEL:'error',BLOCKED_WORDS:'屏蔽',DANMU_LIMIT:'0'});
  const blocked=[{p:'1,1,16777215,source',m:'这条屏蔽'}, {p:'NaN,1,16777215,source',m:'无效时间'},{p:'2,1,16777215,source',m:'  '}];
  const good=[{p:'3,1,16777215,source',m:'真正有效'}];
  assert.equal(hasVisibleComments(blocked),false);assert.equal(hasVisibleComments(good),true);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const groups=[[{index:0,factory:async()=>blocked}],[{index:1,factory:async()=>{await sleep(55);return good;}}],[{index:2,factory:async()=>{await sleep(160);return good;}}]];
  const started=Date.now();const result=await collectCommentGroups(groups,3,3,{graceMs:25,totalMs:300});
  assert.ok(Date.now()-started>=50,'blocked/invalid source must not start grace period');
  assert.equal(result.partial,true);assert.deepEqual(result.values[1],good);assert.deepEqual(result.values[2],[]);
  await sleep(165);
 });
}
