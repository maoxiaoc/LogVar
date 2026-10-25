// Reissue 1.0.8 with shared automatic caching, retaining its wait-all behavior.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import currentMetadata from './metadata.js';
import { verifyIqiyiRetries } from './iqiyi-retry-check.mjs';

const input = new URL('./legacy-core.js.txt', import.meta.url);
const output = new URL('../dist/logvar-1.0.8.js', import.meta.url);
const metadata = {...currentMetadata,version:'1.0.8',modules:currentMetadata.modules.filter(module=>module.id!=='testDanmuFlow')};
let code = 'var WidgetMetadata = ' + JSON.stringify(metadata, null, 2) + ';\n' + await readFile(input, 'utf8');
assert.equal(metadata.globalParams.find(p=>p.name==='groupMinute').type,'input');

function replaceOnce(from, to) {
  assert.ok(code.includes(from), 'Archived adapter mismatch: ' + from.slice(0, 80));
  code = code.replace(from, to);
}
// The bundled metadata is also used for the private state key and defaults.
code = code.replaceAll('"logvar.forward.local"', '"logvar.danmu"');
const inlineInput = /(name: "groupMinute", title: "[^"]*", type: )"count"/;
assert.ok(inlineInput.test(code));
code = code.replace(inlineInput, '$1"input"');
replaceOnce('Number(params.groupMinute ?? 1)', 'Number(String(params.groupMinute ?? "").trim() || "1")');
// Keep the archived source pipeline, but avoid IQIYI's timer-only retry path
// on native players without timers. Exactly one alternate official route.
const iqiyiStart = code.indexOf('// danmu_api/sources/iqiyi.js');
const iqiyiEnd = code.indexOf('var IqiyiSource = _IqiyiSource;', iqiyiStart);
assert.ok(iqiyiStart >= 0 && iqiyiEnd > iqiyiStart);
let iqiyi = code.slice(iqiyiStart, iqiyiEnd);
function replaceIqiyi(from, to) {
  assert.ok(iqiyi.includes(from), 'Archived IQIYI adapter mismatch: ' + from);
  iqiyi = iqiyi.replace(from, to);
}
replaceIqiyi('doSearch = async (bypassCache = !1) => {', 'doSearch = async (bypassCache = !1, requestUrl = url) => {');
replaceIqiyi('httpGet(url, {', 'httpGet(requestUrl, {');
replaceIqiyi('MAX_RETRIES = 2, data = await doSearch();', `MAX_RETRIES = globalThis.__LOGVAR_HAS_TIMERS__ ? 2 : 0, data = await doSearch();
        if (!globalThis.__LOGVAR_HAS_TIMERS__ && (!data || String(data.code) === "-1")) {
          log("info", "[iqiyi] 搜索主接口异常，无计时器环境改用备用接口一次");
          data = await doSearch(true, url.replace("https://mesh.if.iqiyi.com/", "https://www.iqiyi.com/prelw/"));
        }`);
iqiyi = iqiyi.replaceAll('data.code === "-1"', 'String(data.code) === "-1"');
replaceIqiyi('MAX_EPISODE_RETRIES = 2, fetchEpisodeData = async (bypassCache = !1) => {',
  'MAX_EPISODE_RETRIES = globalThis.__LOGVAR_HAS_TIMERS__ ? 2 : 0, fetchEpisodeData = async (bypassCache = !1, requestUrl = url) => {');
const baseAt = iqiyi.indexOf('async _fetchBaseInfoData(entityId)');
assert.ok(baseAt >= 0);
const baseTail = iqiyi.slice(baseAt);
assert.ok(baseTail.includes('httpGet(url, {'));
iqiyi = iqiyi.slice(0, baseAt) + baseTail.replace('httpGet(url, {', 'httpGet(requestUrl, {');
replaceIqiyi('data = await fetchEpisodeData();', `data = await fetchEpisodeData();
      if (!globalThis.__LOGVAR_HAS_TIMERS__ && (!data || data.status_code !== 0 || !data.data || !data.data.template)) {
        log("info", "[iqiyi] 分集主接口异常，无计时器环境改用备用接口一次");
        data = await fetchEpisodeData(true, url.replace("https://www.iqiyi.com/prelw/", "https://mesh.if.iqiyi.com/"));
      }`);
code = code.slice(0, iqiyiStart) + iqiyi + code.slice(iqiyiEnd);
replaceOnce('let imdbId = dataOf(await Widget.tmdb.get(`/${type}/${tmdbId}/external_ids`))?.imdb_id;', `
      let imdbId;
      for (const prefix of ["", "/"]) {
        try {
          imdbId = dataOf(await Widget.tmdb.get(prefix + type + "/" + tmdbId + "/external_ids"))?.imdb_id;
          if (/^tt\\d+$/.test(imdbId || "")) break;
        } catch (_) {}
      }`);

// Reuse the maintained cache implementation and identity checks. The archived
// source fetch/merge pipelines stay intact and still await every source.
const cacheSource = (await readFile(new URL('cache.js',import.meta.url),'utf8'))
  .replace("import metadata from './metadata.js';",'const metadata = metadata_default;')
  .replace(/^export /gm,'');
const widgetSource = await readFile(new URL('widget.js',import.meta.url),'utf8');
function sharedFunctionBlock(start,end) {
  const at = widgetSource.indexOf(start), until = widgetSource.indexOf(end,at);
  assert.ok(at>=0 && until>at,'Shared cache adapter no longer matches');
  return widgetSource.slice(at,until);
}
const cacheHelpers = `
  const legacyCache = (() => {
    ${cacheSource}
    ${sharedFunctionBlock('function state()','function keepReturnedState(')}
    ${sharedFunctionBlock('function configKey(','function run(')}
    ${sharedFunctionBlock('export function displayModeTitle(','export function normalizeConfig(').replace(/^export /gm,'')}
    ${sharedFunctionBlock('function selectCommentResult(','export async function loadComments(').replace(/^export /gm,'')}
    return {getCached,putCached,clearModuleCache,beginCacheCallback,state,restoreCachedState,configKey,displayModeTitle,displaySearchResult,cachedEpisodeSource,cacheUnstoredWinner,publicId,originalId,selectCommentResult,rememberLoadedSource,prepareCurrentEpisode,preparedComments};
  })();
  function clearDanmuCache() {
    const task = pending.then(async () => {
      const result = await legacyCache.clearModuleCache();
      globals.searchCache.clear();
      globals.commentCache.clear();
      return [{id:'logvar-cache-cleared',type:'url',title:'✅ 弹幕缓存已清理',
        description:'已校验删除 '+result.removed+' 项缓存，已清理搜索结果、预加载弹幕、已下载弹幕和来源标签记录，并更新刷新标记。请重新搜索并选择该集。'}];
    });
    pending = task.catch(() => {});
    return task;
  }
`;
const searchStart = code.indexOf('function searchDanmu(params = {}) {');
const searchEnd = code.indexOf('function getDetailById(params = {}) {',searchStart);
const oldSearch = code.slice(searchStart,searchEnd);
const searchPrefix = 'function searchDanmu(params = {}) {\n    return run(params, async () => {\n';
const searchSuffix = '\n    });\n  }\n  ';
assert.ok(oldSearch.startsWith(searchPrefix) && oldSearch.endsWith(searchSuffix));
replaceOnce(oldSearch,`function searchDanmu(params = {}) {
    return run(params,async () => {
      const title = String(params.title || params.seriesName || '').trim();
      const key = JSON.stringify(['search',legacyCache.configKey(params),title,params.tmdbId,params.type,params.season]);
      const cached = await legacyCache.getCached(key,params);
      if (cached && legacyCache.restoreCachedState(cached.state)) return legacyCache.displaySearchResult(cached.result,params);
      const response = await (async () => {
        ${oldSearch.slice(searchPrefix.length,-searchSuffix.length)}
      })();
      if (response.animes?.some(a => a.animeId !== EMPTY_ANIME_ID))
        await legacyCache.putCached(key,{result:response,state:legacyCache.state()},30*60*1000);
      return legacyCache.displaySearchResult(response,params);
    });
  }
  `);
replaceOnce('let task = pending.then(async () => {','let task = pending.then(async () => {\n      if (await legacyCache.beginCacheCallback()) { globals.searchCache.clear(); globals.commentCache.clear(); }');
replaceOnce('`https://logvar.invalid/api/v2/bangumi/${params.animeId}`','`https://logvar.invalid/api/v2/bangumi/${legacyCache.originalId(params.animeId,"anime")}`');
replaceOnce('let id = Number(params.commentId);','let id = Number(legacyCache.originalId(params.commentId,"episode"));');
replaceOnce(`return (result.bangumi.episodes || []).map((episode) => ({
        ...episode,
        episodeTitle: displaySourceNames(episode.episodeTitle)
      }));`,`const episodes = [];
      const packet = await legacyCache.prepareCurrentEpisode(params.animeId,params);
      for (const episode of result.bangumi.episodes || []) {
        const id = Number(episode.episodeId);
        const ready = packet?.episodeId === id ? packet : null;
        const source = ready ? ready.source : params.sourceMode === 'most'
          ? await legacyCache.cachedEpisodeSource(findUrlById(id),findTitleById(id),params) : null;
        episodes.push({...episode,episodeId:legacyCache.publicId(id,'episode',params,source||'',ready?.token),episodeTitle:legacyCache.displayModeTitle(episode.episodeTitle,params.sourceMode,source)});
      }
      return episodes;`);
replaceOnce('async function loadComments(url, title) {','async function loadComments(url, title, params = {}, selectionOnly = false) {');
replaceOnce(', results = await Promise.all(unique.map(async (part) => {',`;
    const key = JSON.stringify(['comments',legacyCache.configKey(params),url,title]);
    let results = await legacyCache.getCached(key,params);
    const fromCache = results !== null;
    if (!results) results = await Promise.all(unique.map(async (part) => {`);
replaceOnce('    }));\n    return alignSourceTimelines(results.map((result) => result.comments), results.map((result) => result.source), results.map((result) => result.id)), selectComments(results, globals.maxDanmuSource ? "most" : "mergeAll");',`    }));
    let cachedRaw = fromCache;
    if (!fromCache && results.some(result => result.comments.length))
      cachedRaw = await legacyCache.putCached(key,results,10*60*1000);
    alignSourceTimelines(results.map(result=>result.comments),results.map(result=>result.source),results.map(result=>result.id));
    await legacyCache.cacheUnstoredWinner(key,results,cachedRaw);
    const selection = legacyCache.selectCommentResult(results,globals.maxDanmuSource?'most':'mergeAll');
    await legacyCache.rememberLoadedSource(url,params,selection);
    return selectionOnly ? selection : selection.comments;`);
replaceOnce('await loadComments(url, findTitleById(id))','await legacyCache.preparedComments(params.commentId,params) || await loadComments(url, findTitleById(id), params)');
replaceOnce('return __toCommonJS(widget_exports);',cacheHelpers+'\nreturn {...__toCommonJS(widget_exports),clearDanmuCache};');
code += '\nfunction clearDanmuCache(params) { return LogvarForward.clearDanmuCache(params); }\n';
assert.ok(!code.includes('function withStage('), 'Legacy version must not inherit the new timing windows');
assert.ok(!metadata.globalParams.some(p => p.name === 'cacheMode'));
new vm.Script(code, { filename: 'logvar-1.0.8.js' });

// Check the same archived file in both host response formats and both modes.
for (const player of ['forward', 'rex']) {
  await verifyIqiyiRetries(code, player);
  const tmdbPaths = [];
  let requests = 0, now = Date.now(), searchFixture = false, largePayload = false;
  const store = new Map([[`${metadata.id}.state.v1`, JSON.stringify({animes:[],episodeNum:10002,
    episodeIds:[{id:10002,url:'dandan:11$$$dandan:22',title:'【dandan】 第1集'}]})]]);
  const makeContext = () => {
  const context = vm.createContext({setTimeout,clearTimeout,
    Date:class extends Date {static now(){return now}},
    console:{log(){},info(){},warn(){},error(){}},Widget:{
      storage:{async get(k){return store.get(k)},async set(k,v){store.set(k,v)}},
      tmdb:{async get(path){
        tmdbPaths.push(path);
        if (player === 'rex' && path.startsWith('/') || player === 'forward' && !path.startsWith('/')) throw new Error('path format');
        return {imdb_id:'tt12345'};
      }},
      http:{async get(input){
        requests++;
        if (input.includes('douban')) return {status:200,statusCode:200,data:{}};
        if (searchFixture) {
          const path = new URL(new URL(input).searchParams.get('path'),'https://fixture.invalid').pathname;
          const anime = {animeId:19847,animeTitle:'缓存作品',type:'tvseries',startDate:'2026-10-01'};
          const episodes = [{episodeId:198470001,episodeTitle:'第1话'}];
          const data = path==='/v2/search/anime'?{animes:[anime]}:
            path==='/v2/bangumi/19847'?{bangumi:{...anime,titles:[{title:anime.animeTitle}],episodes:[]}}:
            path==='/v2/search/episodes'?{animes:[{...anime,episodes}]}:null;
          if (data) return {[player==='rex'?'statusCode':'status']:200,data};
        }
        const first = decodeURIComponent(input).includes('/comment/11?');
        const comments = (first ? ['共同','甲'] : ['共同','乙','丙']).map((m,i)=>({p:`${i+1},1,25,16777215,0,0,user,1`,m:largePayload?m+'x'.repeat(1100000):m}));
        return {[player==='rex'?'statusCode':'status']:200,data:{comments}};
      }},
    }});
  new vm.Script(code).runInContext(context,{timeout:10000});
  return context;
  };
  const context = makeContext();
  assert.equal(context.WidgetMetadata.globalParams.find(p=>p.name==='groupMinute').type,'input');
  assert.ok(context.WidgetMetadata.modules.some(m=>m.functionName==='clearDanmuCache'));
  const api = context.LogvarForward;
  assert.equal(api.normalizeConfig({groupMinute:''}).GROUP_MINUTE,'1');
  assert.equal(api.normalizeConfig({groupMinute:'0.5'}).GROUP_MINUTE,'0.5');
  assert.ok(!api.normalizeConfig().SOURCE_ORDER.includes('aiyifan'));
  assert.equal((await context.getCommentsById({commentId:10002,enabledSources:'dandan',groupMinute:'0',sourceMode:'most'})).count,3);
  const firstRequests = requests;
  assert.equal((await context.getCommentsById({commentId:10002,enabledSources:'dandan',groupMinute:'0',sourceMode:'mergeAll'})).count,4);
  assert.equal(requests,firstRequests,'Switching mode must reuse raw comments automatically');
  const clearingElsewhere = makeContext();
  await clearingElsewhere.clearDanmuCache();
  const beforeReload = requests;
  await context.getCommentsById({commentId:10002,enabledSources:'dandan',groupMinute:'0',sourceMode:'most'});
  assert.equal(requests,beforeReload+2,'Clearing from another test runtime must invalidate the live runtime cache');
  const cold = makeContext();
  const params = {commentId:10002,enabledSources:'dandan',groupMinute:'0',sourceMode:'most'};
  assert.equal((await cold.getCommentsById(params)).count,3);
  assert.equal(requests,beforeReload+2,'Reloaded scripts must use persisted cache');
  now += 600001;
  await cold.getCommentsById(params);
  assert.equal(requests,beforeReload+4,'Expired comments must be fetched again');
  const cacheKey = `${metadata.id}.cache.v1`;
  const cached = JSON.parse(store.get(cacheKey));
  const searchEntry = {key:JSON.stringify(['search','sentinel']),expires:now+60000,value:{sentinel:true}};
  cached.push(searchEntry);
  store.set(cacheKey,JSON.stringify(cached));
  const clearing = makeContext(), beforeClear = requests, beforeState = store.get(`${metadata.id}.state.v1`);
  assert.match((await clearing.clearDanmuCache())[0].title,/已清理/);
  assert.equal(requests,beforeClear,'Clearing must not start network requests');
  assert.equal(store.get(`${metadata.id}.state.v1`),beforeState,'Clearing must preserve episode IDs');
  assert.deepEqual(JSON.parse(store.get(cacheKey)),[],'Clearing must remove search cache');
  await clearing.getCommentsById(params);
  assert.equal(requests,beforeClear+2,'Loading after clear must refetch');
  const broken = makeContext();
  broken.Widget.storage.set = async () => {throw new Error('storage failure')};
  await assert.rejects(()=>broken.clearDanmuCache(),/storage failure/);
  await context.searchDanmu({title:'路径测试',tmdbId:123,type:'tv',enabledSources:'dandan'});
  assert.deepEqual(tmdbPaths,player==='rex'?['tv/123/external_ids']:['tv/123/external_ids','/tv/123/external_ids']);
  searchFixture = true;
  const searching = makeContext(), searchParams = {title:'缓存作品',enabledSources:'dandan'};
  const found = await searching.searchDanmu(searchParams);
  assert.ok(found.animes.some(a=>a.animeId!=='__empty__'));
  const searchRequests = requests;
  const searchCold = makeContext();
  const mostFound = await searchCold.searchDanmu({...searchParams,sourceMode:'most'});
  assert.notEqual(mostFound.animes[0].animeId,found.animes[0].animeId);
  assert.ok(!mostFound.animes[0].animeTitle.includes('from '));
  assert.match((await searchCold.searchDanmu({...searchParams,sourceMode:'mergeAll'})).animes[0].animeTitle,/from 弹弹$/);
  assert.equal(requests,searchRequests,'Successful searches must persist for 30min across mode changes');
  const searchIdBeforeClear = mostFound.animes[0].animeId;
  await searchCold.clearDanmuCache();
  const requestsBeforeSearchReload = requests;
  const searchedAgain = await searchCold.searchDanmu({...searchParams,sourceMode:'most'});
  assert.ok(requests > requestsBeforeSearchReload,'Clear must fetch search results again in the live runtime');
  assert.notEqual(searchedAgain.animes[0].animeId,searchIdBeforeClear,'Clear must update player-facing identities');
  assert.ok(!searchedAgain.animes[0].animeTitle.includes('from '),'Old source winner must not survive clearing');
  const mostEpisodes = await searchCold.getDetailById({...searchParams,animeId:found.animes[0].animeId,sourceMode:'most'});
  assert.ok(!mostEpisodes[0].episodeTitle.includes('【'));
  const mergeEpisodes = await searchCold.getDetailById({...searchParams,animeId:found.animes[0].animeId,sourceMode:'mergeAll'});
  assert.match(mergeEpisodes[0].episodeTitle,/【弹弹】/);
  assert.notEqual(mergeEpisodes[0].episodeId,mostEpisodes[0].episodeId);
  await searchCold.getCommentsById({...searchParams,commentId:mostEpisodes[0].episodeId,sourceMode:'most'});
  assert.match((await searchCold.getDetailById({...searchParams,animeId:found.animes[0].animeId,sourceMode:'most'}))[0].episodeTitle,/【弹弹】/);
  assert.match((await searchCold.searchDanmu({...searchParams,sourceMode:'most'})).animes[0].animeTitle,/from 弹弹$/);
  const preloaded=await searchCold.searchDanmu({...searchParams,sourceMode:'most',episode:1});
  assert.match(preloaded.animes[0].animeTitle,/from 弹弹$/);
  const preloadedDetails=await searchCold.getDetailById({...searchParams,sourceMode:'most',episode:1,animeId:preloaded.animes[0].animeId});
  const requestMark=requests;
  const playback=makeContext();
  assert.ok((await playback.getCommentsById({...searchParams,sourceMode:'most',episode:1,commentId:preloadedDetails[0].episodeId})).count>0);
  assert.equal(requests,requestMark,'Playback must reuse the prepared batch');
  await searchCold.clearDanmuCache();
  largePayload = true;
  await searchCold.getCommentsById({...searchParams,commentId:mostEpisodes[0].episodeId,sourceMode:'most'});
  assert.ok(JSON.parse(store.get(`${metadata.id}.cache.v1`)).some(e=>JSON.parse(e.key).at(-1)==='winner'));
  assert.match((await searchCold.getDetailById({...searchParams,animeId:found.animes[0].animeId,sourceMode:'most'}))[0].episodeTitle,/【弹弹】/);
  now += 1800001;
  await searchCold.searchDanmu(searchParams);
  assert.ok(requests>searchRequests,'Expired searches must be fetched again');
}
await writeFile(output, code);
console.log('Built logvar-1.0.8.js: both host formats, editable interval, automatic cache reuse/expiry/cold starts, cache clearing, mode changes and search identities checked; original wait-all behavior retained.');
