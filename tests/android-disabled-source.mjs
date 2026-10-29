import test from 'node:test';
import assert from 'node:assert/strict';
import {Globals} from '../app/src/main/assets/nodejs-project/danmu_api/configs/globals.js';
test('Android ignores previously enabled Aiyifan without enabling hidden sources',()=>{
 const previous=process.env.LOGVAR_ANDROID;process.env.LOGVAR_ANDROID='1';
 try {
  const g=Globals.init({SOURCE_ORDER:'renren,aiyifan,iqiyi',PLATFORM_ORDER:'renren&aiyifan,qiyi',MERGE_SOURCE_PAIRS:'renren&aiyifan&iqiyi'});
  assert.deepEqual(g.sourceOrderArr,['renren','iqiyi']);assert.deepEqual(g.platformOrderArr,['renren','qiyi',null]);
  assert.equal(JSON.stringify(g.mergeSourcePairs).includes('aiyifan'),false);
  const empty=Globals.init({SOURCE_ORDER:'aiyifan',PLATFORM_ORDER:'aiyifan',MERGE_SOURCE_PAIRS:'aiyifan'});
  assert.deepEqual(empty.sourceOrderArr,[]);assert.deepEqual(empty.mergeSourcePairs,[]);
  assert.deepEqual(Globals.init({SOURCE_ORDER:''}).sourceOrderArr,[]);
 } finally {if(previous===undefined)delete process.env.LOGVAR_ANDROID;else process.env.LOGVAR_ANDROID=previous;}
});
test('old Aiyifan links do not issue requests on Android',async()=>{
 const {default:Aiyifan}=await import('../app/src/main/assets/nodejs-project/danmu_api/sources/aiyifan.js');
 const previous=process.env.LOGVAR_ANDROID,fetchBefore=globalThis.fetch;process.env.LOGVAR_ANDROID='1';
 globalThis.fetch=()=>{throw new Error('Disabled source should not access the network')};
 try {const source=new Aiyifan();assert.deepEqual(await source.search('任意作品'),[]);assert.deepEqual(await source.getEpisodeDanmu('https://www.yfsp.tv/play/fixture?id=episode'),[]);}
 finally{globalThis.fetch=fetchBefore;if(previous===undefined)delete process.env.LOGVAR_ANDROID;else process.env.LOGVAR_ANDROID=previous;}
});
