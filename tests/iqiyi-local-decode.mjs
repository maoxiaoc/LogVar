import test from 'node:test';
import assert from 'node:assert/strict';
import {brotliCompressSync} from 'node:zlib';
for(const base of ['../server/danmu_api','../app/src/main/assets/nodejs-project/danmu_api']) {
 test(base+': iqiyi does not require international decode',async t=>{
  const {Globals}=await import(base+'/configs/globals.js');
  const {default:Iqiyi}=await import(base+'/sources/iqiyi.js');
  Globals.init({SOURCE_ORDER:'iqiyi',LOG_LEVEL:'error'});
  const source=new Iqiyi(),originalFetch=globalThis.fetch;
  const id='3343928609435100';let internationalCalls=0, allowInternational=false;
  globalThis.fetch=async input=>{
   const url=new URL(input);
   if(url.hostname==='pcw-api.iq.com'){internationalCalls++;if(allowInternational)return new Response(JSON.stringify({data:id}));throw new DOMException('International decode unreachable','AbortError');}
   if(url.hostname==='www.iqiyi.com')return new Response('<title>Fixture</title>');
   if(url.hostname==='pcw-api.iqiyi.com'){
    assert.equal(url.pathname,'/video/video/baseinfo/'+id);
    return new Response(JSON.stringify({code:'A00000',data:{durationSec:30,displayBarrage:true}}));
   }
   if(url.hostname==='cmts.iqiyi.com')return new Response(brotliCompressSync(Buffer.from('<root><content>测试弹幕</content><showTime>1</showTime><color>ffffff</color><likeCount>0</likeCount></root>')));
   assert.fail('Unexpected host: '+url.hostname);
  };
  try {
   await t.test('encoded video URL downloads comments while international decode is unreachable',async()=>{
    const comments=await source.getEpisodeDanmu('https://www.iqiyi.com/v_w3afcc4qeo.html');
    assert.equal(comments.length,1);assert.equal(comments[0].content,'测试弹幕');assert.equal(internationalCalls,0);
   });
   await t.test('numeric TVID stays unchanged',async()=>{
    const segments=await source.getEpisodeDanmuSegments('https://www.iqiyi.com/v_'+id+'.html');
    assert.equal(segments.segmentList.length,1);assert.match(segments.segmentList[0].url,new RegExp('/'+id+'_60_1_'));
    assert.equal(internationalCalls,0);
   });
   await t.test('unsafe base36 numbers keep the international decode fallback',async()=>{
    allowInternational=true;
    const segments=await source.getEpisodeDanmuSegments('https://www.iqiyi.com/v_zzzzzzzzzzzzzz.html');
    assert.equal(segments.segmentList.length,1);assert.equal(internationalCalls,1);
   });
  }finally{globalThis.fetch=originalFetch;}
 });
}
