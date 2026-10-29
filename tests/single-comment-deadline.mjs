import test from 'node:test';import assert from 'node:assert/strict';
for(const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']){
 test(base+': single-source timeout',async t=>{
  const {Globals}=await import(base+'/configs/globals.js');const {getSourceByKey}=await import(base+'/sources/registry.js');
  const {addAnime}=await import(base+'/utils/cache-util.js');const {getComment,getCommentByUrl,getBangumi}=await import(base+'/apis/dandan-api.js');
  const {fetchSingleComments}=await import(base+'/utils/comment-deadline.js');
  Globals.init({SOURCE_ORDER:'tencent',LOG_LEVEL:'error',COMMENT_CACHE_MINUTES:'30',COMMENT_CACHE_MIN_COUNT:'0'});
  const ten=getSourceByKey('tencent'),oldGet=ten.getComments,oldTimer=globalThis.setTimeout;const sleep=ms=>new Promise(r=>oldTimer(r,ms));let calls=0;
  ten.getComments=async()=>{const n=++calls;if(n===1||n===3)await sleep(80);return [{cid:1,p:'1,1,16777215,tencent',m:n===1||n===3?'late':'current'}];};
  globalThis.setTimeout=(fn,ms,...args)=>oldTimer(fn,ms===30000?20:ms,...args);
  try {
   await t.test('ID requests return promptly, do not cache timeout or late results',async()=>{
    addAnime({animeId:987654,bangumiId:'fixture-987654',animeTitle:'测试(2026)',source:'tencent',links:[{title:'【qq】 第1集',url:'https://v.qq.com/x/single-fixture'}]});
    const detail=await(await getBangumi('/api/v2/bangumi/987654')).json();const id=detail.bangumi.episodes[0].episodeId;
    const a=await(await getComment('/api/v2/comment/'+id,'json',false,'127.0.0.1')).json();assert.equal(a.count,0);
    const b=await(await getComment('/api/v2/comment/'+id,'json',false,'127.0.0.1')).json();assert.equal(b.count,1);assert.equal(b.comments[0].m,'current');
    await sleep(90);const c=await(await getComment('/api/v2/comment/'+id,'json',false,'127.0.0.1')).json();assert.equal(c.comments[0].m,'current');assert.equal(calls,2);
   });
   await t.test('URL requests also time out without caching empty or late data',async()=>{
    const url='https://v.qq.com/x/single-url-fixture';const a=await(await getCommentByUrl(url,'json',false)).json();assert.equal(a.count,0);
    const b=await(await getCommentByUrl(url,'json',false)).json();assert.equal(b.count,1);assert.equal(b.comments[0].m,'current');
    await sleep(90);const c=await(await getCommentByUrl(url,'json',false)).json();assert.equal(c.comments[0].m,'current');assert.equal(calls,4);
   });
   await t.test('segment requests keep their original response and are not cut off',async()=>{
    const value=await fetchSingleComments(async()=>{await sleep(40);return {segmentList:[{url:'fixture'}]};},{segment:true});
    assert.equal(value.segmentList.length,1);
   });
  }finally{ten.getComments=oldGet;globalThis.setTimeout=oldTimer;}
 });
}
