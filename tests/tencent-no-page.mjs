import test from 'node:test';
import assert from 'node:assert/strict';
for (const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']) {
 test(base+': Tencent comments do not depend on playback page',async()=>{
  const {Globals}=await import(base+'/configs/globals.js');
  const {default:Tencent}=await import(base+'/sources/tencent.js');
  Globals.init({SOURCE_ORDER:'tencent',LOG_LEVEL:'error'});
  const source=new Tencent(),original=globalThis.fetch;const called=[];
  source.getEpisodeDanmuSegments=async()=>({segmentList:[{url:'https://dm.video.qq.com/barrage/segment/fixture'}]});
  globalThis.fetch=async input=>{const url=String(input);called.push(url);if(url.includes('v.qq.com'))throw new Error('Playback page unavailable');return new Response(JSON.stringify({barrage_list:[{content:'腾讯弹幕',time_offset:1000}]}));};
  try {const comments=await source.getEpisodeDanmu('https://v.qq.com/x/cover/test/fixture.html');assert.equal(comments.length,1);assert.equal(comments[0].content,'腾讯弹幕');assert.equal(called.length,1);assert.match(called[0],/barrage\/segment/);}finally{globalThis.fetch=original;}
 });
}
