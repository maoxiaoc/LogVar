import assert from 'node:assert/strict';
import vm from 'node:vm';
import { brotliCompressSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { verifyIqiyiRetries } from './iqiyi-retry-check.mjs';
const target = process.argv.includes('--rex') ? 'rex' : 'forward';
const { default: currentMetadata } = await import(`../${target}/metadata.js`);
const metadata = {...currentMetadata,version:process.env.LOGVAR_TEST_VERSION || currentMetadata.version};

const code = await readFile(new URL(`../dist/logvar-${metadata.version}.js`, import.meta.url), 'utf8');
await verifyIqiyiRetries(code,target);
const rawComment = (time, text) => ({ p: `${time},1,25,16777215,0,0,user,1`, m: text });
const dataComment = (time, text) => ({ p: `${time},1,16777215,[test]`, m: text });
const stateKey = `${metadata.id}.state.v1`;

function host(store = new Map(), respond = async () => { throw new Error('Unexpected HTTP call'); }, timers = true, tmdb, inject = '') {
  const httpResponse = async (url, options, body) => {
    const response = await respond(url, options, body);
    if (target !== 'rex') return response;
    const { status, ...rest } = response;
    return { ...rest, statusCode: status };
  };
  const requests = [];
  const warnings = [];
  const traces = [];
  const context = vm.createContext({
    console: { log(...args) { traces.push(args.join(' ')); }, info() {}, warn(...args) { warnings.push(args.join(' ')); }, error(...args) { warnings.push(args.join(' ')); } },
    ...(timers ? (typeof timers === 'object' ? timers : { setTimeout, clearTimeout }) : {}),
    Widget: {
      ...(tmdb ? { tmdb: { async get(path) {
        if (target === 'rex') {
          if (path.startsWith('/')) throw new Error('Rex requires a relative TMDB path');
          return tmdb.get('/' + path);
        }
        if (!path.startsWith('/')) throw new Error('Forward fixture requires a leading slash');
        return tmdb.get(path);
      } } } : {}),
      storage: { async get(key) { return store.get(key); }, async set(key, value) { store.set(key, value); } },
      http: {
        async get(url, options) { requests.push({ method: 'GET', url, options }); return httpResponse(url, options); },
        async post(url, body, options) { requests.push({ method: 'POST', url, body, options }); return httpResponse(url, options, body); },
      },
    },
  });
  const testCode = inject ? code.replace('return __toCommonJS(widget_exports);', inject + '\nreturn __toCommonJS(widget_exports);') : code;
  new vm.Script(testCode).runInContext(context, { timeout: 10000 });
  return { context, api: context.LogvarForward, store, requests, warnings, traces };
}

const h = host();
assert.equal(typeof h.api.displayModeTitle,'function','来源标签必须按本次处理策略重新生成');
assert.equal(metadata.globalParams.find(p => p.name === 'groupMinute').type, 'input', '去重间隔必须是可键入数字的输入框');
assert.ok(!metadata.globalParams.some(p => p.name === 'cacheMode'), '缓存自动使用，不显示缓存策略选择');
assert.ok(metadata.modules.some(m => m.functionName === 'clearDanmuCache' && m.title === '清理弹幕缓存'));
assert.ok(code.startsWith('var WidgetMetadata = '));
for (const module of metadata.modules) assert.equal(typeof h.context[module.functionName], 'function');
assert.deepEqual(JSON.parse(JSON.stringify(h.context.WidgetMetadata)), metadata);
assert.equal(metadata.id, 'logvar.danmu');
assert.equal(metadata.title, 'LogVar');
// Rex's native importer rejects metadata without this field (device A/B test).
assert.match(h.context.WidgetMetadata.requiredVersion ?? '', /^\d+\.\d+\.\d+$/, 'Importer requires requiredVersion');
assert.deepEqual(metadata.globalParams[0].enumOptions.map(option => option.value), ['mergeAll', 'most']);
assert.ok(!metadata.globalParams.some(param => /sourceOrder|platformOrder|otherServer|priority/i.test(param.name)));
assert.equal(h.api.normalizeConfig({ enabledSources: 'youku,bilibili,tencent' }).SOURCE_ORDER,
  h.api.normalizeConfig({ enabledSources: 'tencent,youku,bilibili' }).SOURCE_ORDER);
const defaultSources = h.api.normalizeConfig().SOURCE_ORDER;
assert.equal(defaultSources.split(',').length, 8);
for (const enabledSources of [undefined, null, '', '  \t\n']) {
  assert.equal(h.api.normalizeConfig({ enabledSources }).SOURCE_ORDER, defaultSources);
}
assert.equal(h.api.normalizeConfig({ enabledSources: ' iqiyi,tencent ' }).SOURCE_ORDER, 'iqiyi,tencent');
assert.throws(() => h.api.normalizeConfig({ enabledSources: 'unknown' }), /不支持/);
assert.throws(() => h.api.normalizeConfig({ sourceMode: 'priority' }), /不支持/);
assert.throws(() => h.api.normalizeConfig({ groupMinute: -1 }), /0～30/);
assert.equal(h.api.normalizeConfig({ groupMinute: '' }).GROUP_MINUTE, '1');
assert.equal(h.api.normalizeConfig({ groupMinute: ' 0 ' }).GROUP_MINUTE, '0');
assert.equal(h.api.normalizeConfig({ groupMinute: '0.5' }).GROUP_MINUTE, '0.5');
assert.throws(() => h.api.normalizeConfig({ groupMinute: 'abc' }), /0～30/);
await h.context.searchDanmu({ title: '' });
for (const [source, display] of Object.entries({
  aiyifan: '爱壹帆', tencent: '腾讯', qq: '腾讯', renren: '人人', dandan: '弹弹',
  bilibili: 'B站', bilibili1: 'B站', qiyi: 'iqiyi', iqiyi: 'iqiyi', imgo: 'imgo', youku: 'youku',
})) {
  assert.equal(h.api.displaySourceNames(`测试作品 from ${source}`), `测试作品 from ${display}`);
  assert.equal(h.api.displaySourceNames(`【${source}】 第1集`), `【${display}】 第1集`);
}
assert.equal(h.api.displaySourceNames('测试作品 from renren＆dandan'), '测试作品 from 人人&弹弹');
assert.equal(h.api.displaySourceNames('【renren&dandan】 第1集'), '【人人&弹弹】 第1集');
assert.equal(h.api.displaySourceNames('qq 和 bilibili 的故事【电视剧】'), 'qq 和 bilibili 的故事【电视剧】');
assert.equal(h.api.displaySourceNames('测试作品 from constructor'), '测试作品 from constructor');
assert.equal(h.api.displayModeTitle('测试作品 from iqiyi&tencent','mergeAll'),'测试作品 from iqiyi&腾讯');
assert.equal(h.api.displayModeTitle('【iqiyi&tencent】 第2集','most','tencent'),'【腾讯】 第2集');
assert.equal(h.api.displayModeTitle('【合并：iqiyi&腾讯】 第2集','most','tencent'),'【腾讯】 第2集');
assert.equal(h.api.displayModeTitle('【取最多（候选：iqiyi&腾讯）】 第2集','mergeAll'),'【iqiyi&腾讯】 第2集');
assert.equal(h.api.displayModeTitle('【iqiyi&tencent】 第2集','most'),'第2集');
assert.equal(h.api.displayModeTitle('测试作品 from iqiyi&tencent','most'),'测试作品');
assert.equal(h.api.displayModeTitle('故事【电视剧】 from constructor','most'),'故事【电视剧】 from constructor');

const inputs = [
  { source: 'bilibili', comments: [dataComment(10, '重复'), dataComment(10, '重复'), dataComment(20, 'B站')] },
  { source: 'youku', comments: [dataComment(10, '重复'), dataComment(30, '优酷一'), dataComment(40, '优酷二')] },
];
assert.deepEqual(Array.from(h.api.selectComments(inputs, 'most'), item => item.m), ['重复', '优酷一', '优酷二']);
assert.equal(h.api.selectComments(inputs, 'mergeAll').length, 4);
assert.deepEqual(Array.from(h.api.normalizeSourceComments([
  { progress: 1000, mode: 1, color: 16777215, content: 'B站' },
  { timepoint: 2, ct: 1, color: 16777215, content: '腾讯/优酷/芒果' },
  { timepoint: NaN, content: '坏时间' },
  { p: 'NaN,1,16777215,[bad]', m: '坏时间' },
], 'test'), item => item.m), ['B站', '腾讯/优酷/芒果']);
assert.equal(h.api.selectComments([
  { source: 'tencent', comments: [{ timepoint: 2, ct: 1, color: 16777215, content: '腾讯' }] },
  { source: 'bilibili', comments: [{ progress: 1000, mode: 1, color: 16777215, content: 'B站' }] },
], 'mergeAll').length, 2);
assert.equal(h.api.selectComments([], 'most').length, 0);
assert.equal(h.api.selectComments([], 'mergeAll').length, 0);
assert.equal(h.api.cleanComments([null, {}, dataComment(-1, '负时间'), dataComment('NaN', '坏时间'), dataComment(1, ''), dataComment(1, '有效')]).length, 1);
const ties = [
  { source: 'youku', comments: [dataComment(1, '优酷')] },
  { source: 'bilibili', comments: [dataComment(1, 'B站')] },
];
assert.equal(h.api.selectComments(ties, 'most')[0].m, h.api.selectComments([...ties].reverse(), 'most')[0].m);
await h.context.searchDanmu({ title: '', blockedWords: '屏蔽' });
assert.equal(h.api.selectComments([
  { source: 'a', comments: Array.from({ length: 8 }, (_, i) => dataComment(i, '屏蔽')) },
  { source: 'b', comments: [dataComment(1, '保留')] },
], 'most')[0].m, '保留');

// Cold-start a real bundled callback using persisted episode identities. All
// platform traffic goes through the mocked Widget; Node globals are absent.
const store = new Map([[stateKey, JSON.stringify({
  animes: [], episodeIds: [{ id: 10002, url: 'dandan:11$$$dandan:22', title: '【dandan】 第1集' }], episodeNum: 10002,
})]]);
const respond = async url => {
  const path = decodeURIComponent(new URL(url).search.slice(1));
  const isFirst = path.includes('/comment/11?');
  assert.ok(path.includes('/comment/11?') || path.includes('/comment/22?'), url);
  return { status: 200, data: { comments: isFirst
    ? [rawComment(10, '共同'), rawComment(10, '共同'), rawComment(20, '第一来源')]
    : [rawComment(10, '共同'), rawComment(30, '第二来源一'), rawComment(40, '第二来源二')] } };
};
const merged = host(store, respond);
const all = await merged.context.getCommentsById({ commentId: 10002, enabledSources: 'dandan', groupMinute: 0, sourceMode: 'mergeAll' });
assert.equal(all.count, 4);
assert.equal(merged.requests.length, 2);
assert.ok(merged.requests.every(request => request.options.timeout === 15000));
assert.ok(merged.requests.every(request => !/localhost|127\.0\.0\.1|logvar\.invalid/.test(request.url)));
const largest = await merged.context.getCommentsById({ commentId: 10002, enabledSources: 'dandan', groupMinute: 0, sourceMode: 'most' });
assert.equal(largest.count, 3);
assert.ok(largest.comments.some(item => item.m === '第二来源二'));
assert.ok(!largest.comments.some(item => item.m === '第一来源'));
const cold = host(store, respond, false);
assert.equal((await cold.context.getCommentsById({ commentId: 10002, enabledSources: 'dandan', sourceMode: 'most' })).count, 3);
const partial = host(store, async url => {
  if (decodeURIComponent(url).includes('/comment/22?')) throw new Error('timeout');
  if (url.includes('nipaplay')) throw new Error('fallback offline');
  return respond(url);
});
assert.equal((await partial.context.getCommentsById({ commentId: 10002, enabledSources: 'dandan', cacheMode: 'refresh' })).count, 2);
await assert.rejects(() => partial.context.getCommentsById({ commentId: 'bad' }), /ID/);
await assert.rejects(() => partial.context.getCommentsById({ commentId: 999 }), /失效/);

// Replay the reported order: episode 1 in most, then episode 2 in mergeAll.
// Raw source cache must never freeze the previous mode, including cold starts.
{
  const saved = JSON.parse(store.get(stateKey));
  saved.episodeIds.push({id:10003,url:'dandan:33$$$dandan:44',title:'【dandan】 第2集'});
  saved.episodeNum = 10003;
  const switchedStore = new Map([[stateKey, JSON.stringify(saved)]]);
  const switched = host(switchedStore, input => respond(input.replace('33', '11').replace('44', '22')));
  assert.equal((await switched.context.getCommentsById({commentId:10002,enabledSources:'dandan',groupMinute:'0',sourceMode:'most'})).count, 3);
  assert.equal((await switched.context.getCommentsById({commentId:10003,enabledSources:'dandan',groupMinute:'0',sourceMode:'mergeAll'})).count, 4);
  const coldSwitch = host(switchedStore, () => assert.fail('Mode change must reuse raw cache'));
  assert.equal((await coldSwitch.context.getCommentsById({commentId:10003,enabledSources:'dandan',groupMinute:'0',sourceMode:'most'})).count, 3);
  assert.equal((await coldSwitch.context.getCommentsById({commentId:10003,enabledSources:'dandan',groupMinute:'0',sourceMode:'mergeAll'})).count, 4);
}

const invalidStore = host(new Map([[stateKey, '{bad']]));
assert.equal((await invalidStore.context.searchDanmu({ title: '' })).animes.length, 0);
assert.ok(invalidStore.warnings.length > 0);
const rejected = host();
await assert.rejects(() => rejected.context.searchDanmu({ enabledSources: 'no' }), /不支持/);
assert.equal((await rejected.context.searchDanmu({ title: '' })).animes.length, 0);

// A completed search with no matches produces a display-only placeholder.
const emptySearch = host(new Map(), async () => ({ status: 200, data: { animes: [] } }), false);
const emptyResult = await emptySearch.context.searchDanmu({ title: '没有匹配的作品', enabledSources: 'dandan' });
assert.deepEqual(JSON.parse(JSON.stringify(emptyResult)), {
  animes: [{ animeId: '__empty__', animeTitle: '😭 未匹配到资源' }],
});
assert.ok(emptySearch.requests.length > 0);
const emptySelection = host();
assert.equal(await emptySelection.context.getDetailById({ animeId: emptyResult.animes[0].animeId }), null);
assert.equal(await emptySelection.context.getCommentsById({ commentId: '__empty__' }), null);
assert.equal(await emptySelection.context.getCommentsById({ animeId: '__empty__' }), null);
assert.equal(emptySelection.requests.length, 0, 'Placeholder must not request platform data');
assert.equal(emptySelection.store.size, 0, 'Placeholder must not create a persisted episode identity');

// Replay the real Android regression through the actual bundled search and
// detail adapters, with one other source failing. Each callback uses a fresh VM.
const anime = { animeId: 19847, animeTitle: 'FX战士久留美', type: 'tvseries', startDate: '2026-10-01' };
const episodes = [{ episodeId: 198470001, episodeTitle: '第1话 FX⋯是什么？' }];
const lifecycleStore = new Map();
const lifecycleResponse = async url => {
  if (url.includes('qq.com')) throw new Error('tencent offline');
  const outer = new URL(url);
  assert.equal(outer.hostname, 'api.danmaku.weeblify.app');
  const inner = new URL(outer.searchParams.get('path'), 'https://fixture.invalid');
  let data;
  if (inner.pathname === '/v2/search/anime') data = { animes: [anime] };
  else if (inner.pathname === '/v2/bangumi/19847') data = { bangumi: { ...anime, titles: [{ title: anime.animeTitle }], episodes: [] } };
  else if (inner.pathname === '/v2/search/episodes') data = { animes: [{ ...anime, episodes }] };
  else if (inner.pathname === '/v2/comment/198470001') data = { comments: [rawComment(1, '完整流程测试')] };
  else assert.fail('Unexpected fixture request: ' + inner.pathname);
  return { status: 200, data: JSON.stringify(data) };
};
const lifecycleParams = { title: anime.animeTitle, enabledSources: 'tencent,dandan' };
const searching = host(lifecycleStore, lifecycleResponse, false);
const search = await searching.context.searchDanmu(lifecycleParams);
assert.equal(search.animes.length, 1);
assert.match(search.animes[0].animeTitle, /from 弹弹$/);
const storedSearch = JSON.parse(lifecycleStore.get(stateKey));
assert.ok(storedSearch.animes.some(item => item.animeTitle.endsWith('from dandan')));
assert.ok(storedSearch.episodeIds.some(item => item.title.includes('【dandan】')));
assert.ok(searching.requests.some(request => request.url.includes('qq.com')), 'Search must query other enabled sources too');
const detailing = host(lifecycleStore, lifecycleResponse, false);
const details = await detailing.context.getDetailById({ ...lifecycleParams, animeId: search.animes[0].animeId });
assert.equal(details.length, 1);
assert.match(details[0].episodeTitle, /【弹弹】/);
assert.deepEqual(JSON.parse(lifecycleStore.get(stateKey)), storedSearch, 'Display mapping must not mutate internal titles, IDs or URLs');
const labelReload = host(lifecycleStore, () => assert.fail('Strategy labels must refresh without refetching'));
const mostSearch = await labelReload.context.searchDanmu({...lifecycleParams,sourceMode:'most'});
assert.ok(!mostSearch.animes[0].animeTitle.includes('from '),'Unknown series winner must not display candidate sources');
const mostDetails = await labelReload.context.getDetailById({...lifecycleParams,animeId:search.animes[0].animeId,sourceMode:'most'});
assert.ok(!mostDetails[0].episodeTitle.includes('【'),'Unloaded episodes must not claim a source');
assert.notEqual(mostDetails[0].episodeId,details[0].episodeId);
const mergedAgain = await labelReload.context.searchDanmu({...lifecycleParams,sourceMode:'mergeAll'});
assert.match(mergedAgain.animes[0].animeTitle,/from 弹弹$/);
assert.match((await labelReload.context.getDetailById({...lifecycleParams,animeId:search.animes[0].animeId,sourceMode:'mergeAll'}))[0].episodeTitle,/【弹弹】/);
assert.deepEqual(JSON.parse(lifecycleStore.get(stateKey)),storedSearch,'Strategy labels are presentation only');
const commenting = host(lifecycleStore, lifecycleResponse, false);
const fullResult = await commenting.context.getCommentsById({ ...lifecycleParams, commentId: details[0].episodeId });
assert.equal(fullResult.count, 1);
assert.equal(fullResult.comments[0].m, '完整流程测试');
// The removed diagnostic entry must not be advertised or exported. Real danmu
// callbacks retain their documented object/array/object contract and timings.
{
  const flow = host(new Map(), lifecycleResponse, false);
  assert.ok(!metadata.modules.some(module => module.functionName === 'testDanmuFlow'));
  assert.equal(typeof flow.context.testDanmuFlow,'undefined');
  const params = {...lifecycleParams,bilibiliCookie:'never-print-this-cookie'};
  const search = await flow.context.searchDanmu(params);
  const details = await flow.context.getDetailById({...params,animeId:search.animes[0].animeId});
  const comments = await flow.context.getCommentsById({...params,commentId:details[0].episodeId});
  assert.equal(comments.count,1);
  const events = flow.traces.filter(line => line.startsWith('[LogVar耗时] ')).map(line => JSON.parse(line.slice('[LogVar耗时] '.length)));
  const returned = events.filter(event => event.phase === 'callback-return');
  assert.deepEqual(returned.map(event => [event.callback,event.shape]), [
    ['searchDanmu','object'],['getDetailById','array'],['getCommentsById','object'],
  ]);
  assert.ok(events.some(event => event.phase === 'source' && event.stage === 'search' && event.source === 'dandan'));
  assert.ok(events.some(event => event.phase === 'merge'));
  assert.ok(flow.traces.every(line => !line.includes('never-print-this-cookie')));
}
// Repeated season/detail handling reuses only successful Dandan detail data;
// empty or failed results remain retryable and a new runtime starts fresh.
{
  const detailResponse = url => ({status:200,data:{bangumi:{episodes: url.includes('/19847') ? episodes : [],titles:[]}}});
  const probe = host(new Map(),detailResponse,false,undefined,
    'globalThis.probeDandanDetails = id => getSourceByKey("dandan").getEpisodes(id);');
  assert.equal((await probe.context.probeDandanDetails(19847)).episodes.length,1);
  await probe.context.probeDandanDetails('19847');
  assert.equal(probe.requests.length,1);
  await probe.context.probeDandanDetails(123);
  await probe.context.probeDandanDetails(123);
  assert.equal(probe.requests.length,3,'Do not cache empty details');
  const fresh = host(new Map(),detailResponse,false,undefined,
    'globalThis.probeDandanDetails = id => getSourceByKey("dandan").getEpisodes(id);');
  await fresh.context.probeDandanDetails(19847);
  assert.equal(fresh.requests.length,1);
}
assert.match((await labelReload.context.getDetailById({...lifecycleParams,animeId:search.animes[0].animeId,sourceMode:'most'}))[0].episodeTitle,/【弹弹】/,'Loaded episodes display the actual cached winner');

// Exercise metadata-first matching through the real bundled source handlers.
const mediaParams = { ...lifecycleParams, tmdbId: 123, type: 'tv', season: 1, enabledSources: 'bilibili,dandan' };
const tmdb = { async get(path) { assert.equal(path, '/tv/123/external_ids'); return { imdb_id: 'tt12345' }; } };
const mediaResponse = async url => {
  if (url.includes('api.douban.com/v2/movie/imdb/')) {
    return { status: 200, data: { id: 'https://api.douban.com/movie/777', image: '' } };
  }
  if (url.includes('m.douban.com/rexxar/api/v2/movie/777')) {
    return { status: 200, data: JSON.stringify({ title: anime.animeTitle, year: '2026', is_tv: true,
      vendors: [{ id: 'bilibili', uri: 'https://www.bilibili.com/bangumi/play/ss123' },
        { id: 'qq', uri: 'https://v.qq.com/x/cover/disabled.html' },
        { id: 'bilibili', is_ad: true, uri: 'https://www.bilibili.com/bangumi/play/ss999' }] }) };
  }
  if (url.includes('pgc/view/web/season?season_id=123')) {
    return { status: 200, data: { code: 0, result: { episodes: [{ id: 12301, title: '1', long_title: 'FX⋯是什么？',
      link: 'https://www.bilibili.com/bangumi/play/ep12301' }] } } };
  }
  return lifecycleResponse(url);
};
const mediaStore = new Map();
const mediaHost = host(mediaStore, mediaResponse, false, tmdb);
const mediaResults = await mediaHost.context.searchDanmu(mediaParams);
assert.ok(mediaResults.animes.some(item => item.animeTitle.includes('B站')));
assert.ok(mediaResults.animes.some(item => item.animeTitle.includes('弹弹')));
assert.ok(!mediaHost.requests.some(r => /search\/type|qq\.com|ss999/.test(r.url)), 'Matched/disabled/ad sources must not be keyword searched or loaded');
assert.ok(mediaHost.requests.some(r => r.url.includes('weeblify')), 'Sources without metadata links must still be supplemented');
const mediaState = JSON.parse(mediaStore.get(stateKey));
assert.ok(mediaState.episodeIds.some(item => item.url.includes('$$$')), 'Metadata and title results must still merge');
const mediaCold = host(mediaStore, mediaResponse, false);
assert.ok((await mediaCold.context.getDetailById({ ...mediaParams, animeId: mediaResults.animes[0].animeId })).length);

// Metadata failures keep the existing title-search path usable.
const noIdentity = host(new Map(), lifecycleResponse, false, { async get() { throw new Error('TMDB offline'); } });
assert.equal((await noIdentity.context.searchDanmu({ ...lifecycleParams, tmdbId: 123, type: 'tv', season: 1 })).animes.length, 1);
assert.ok(noIdentity.warnings.some(text => text.includes('回退标题')));
const noLinks = host(new Map(), async url => url.includes('douban.com') ? { status: 200, data: {} } : lifecycleResponse(url), false, tmdb);
assert.equal((await noLinks.context.searchDanmu({ ...lifecycleParams, tmdbId: 123, type: 'tv', season: 1 })).animes.length, 1);

const seasonHost = host(new Map(), async url => {
  if (url.includes('api.imdbapi.dev')) {
    assert.ok(url.includes('season=2'));
    return { status: 200, data: { episodes: [{ episodeNumber: 1, id: 'tt22222' }] } };
  }
  if (url.includes('api.douban.com')) assert.ok(url.includes('/imdb/tt22222'), 'Season two must not use the series IMDb ID');
  return mediaResponse(url);
}, false, tmdb);
assert.ok((await seasonHost.context.searchDanmu({ ...mediaParams, enabledSources: 'bilibili', season: 2 })).animes[0].animeTitle.includes('B站'));
const missingSeason = host(new Map(), async url => url.includes('api.imdbapi.dev')
  ? { status: 200, data: { episodes: [] } } : lifecycleResponse(url), false, tmdb);
assert.equal((await missingSeason.context.searchDanmu({ ...lifecycleParams, tmdbId: 123, type: 'tv', season: 2 })).animes.length, 1);
assert.ok(!missingSeason.requests.some(r => r.url.includes('douban.com')), 'Missing season mapping must fall back rather than select season one');
const invalidMedia = host(new Map(), lifecycleResponse, false, { async get() { assert.fail('Invalid metadata must not invoke TMDB'); } });
assert.equal((await invalidMedia.context.searchDanmu({ ...lifecycleParams, tmdbId: '../123', type: 'tv' })).animes.length, 1);
assert.equal(h.api.mediaVendor({ uri: 'https://bilibili.com.evil.test/bangumi/play/ss123' }, 'tv'), null);
assert.equal(h.api.mediaVendor({ uri: 'https://www.bilibili.com/bangumi/play/ss123', is_ad: true }, 'tv'), null);
assert.equal(h.api.mediaVendor({ uri: 'https://www.mgtv.com/b/123/456.html' }, 'tv').id, '123');
assert.equal(h.api.mediaVendor({ uri: 'https://www.iqiyi.com/?tvid=123' }, 'movie').id, 'movie_123');

const movieHost = host(new Map(), async url => {
  assert.ok(!url.includes('imdbapi.dev'), 'Movie matching must not query TV seasons');
  const response = await mediaResponse(url);
  if (url.includes('m.douban.com')) response.data = { ...JSON.parse(response.data), is_tv: false };
  return response;
}, false, { async get(path) { assert.equal(path, '/movie/123/external_ids'); return { data: JSON.stringify({ imdb_id: 'tt12345' }) }; } });
assert.ok((await movieHost.context.searchDanmu({ ...mediaParams, type: 'movie', enabledSources: 'bilibili' })).animes[0].animeTitle.includes('B站'));
const disabledVendor = host(new Map(), mediaResponse, false, tmdb);
assert.equal((await disabledVendor.context.searchDanmu({ ...mediaParams, enabledSources: 'dandan' })).animes.length, 1);
assert.ok(!disabledVendor.requests.some(r => r.url.includes('bilibili.com')), 'Disabled metadata sources must not be loaded');
const failedDetails = host(new Map(), async url => {
  if (url.includes('bilibili.com')) throw new Error('platform details offline');
  return mediaResponse(url);
}, false, tmdb);
assert.ok((await failedDetails.context.searchDanmu(mediaParams)).animes.some(item => item.animeTitle.includes('弹弹')));
const identities = [];
const identityHost = host(new Map(), mediaResponse, false, { async get(path) { identities.push(path); return { imdb_id: 'tt12345' }; } });
await identityHost.context.searchDanmu({ ...mediaParams, enabledSources: 'bilibili' });
await identityHost.context.searchDanmu({ ...mediaParams, enabledSources: 'bilibili', tmdbId: 456 });
assert.deepEqual(identities, ['/tv/123/external_ids', '/tv/456/external_ids']);

// Removed sources in old player settings and persisted merged episodes cannot make HTTP calls.
assert.ok(!h.api.normalizeConfig().SOURCE_ORDER.split(',').includes('aiyifan'));
assert.equal(h.api.normalizeConfig({enabledSources:'aiyifan,dandan'}).SOURCE_ORDER, 'dandan');
assert.throws(() => h.api.normalizeConfig({enabledSources:'aiyifan'}), /启用来源为空/);
const disabledSourceSearch = host(new Map(), lifecycleResponse, false);
assert.ok((await disabledSourceSearch.context.searchDanmu({...lifecycleParams,enabledSources:'aiyifan,dandan'})).animes.some(item => item.animeTitle.includes('弹弹')));
assert.ok(!disabledSourceSearch.requests.some(item => /tripdata|yfsp/.test(item.url)));
const disabledSourceStore = new Map([[stateKey,JSON.stringify({animes:[],episodeIds:[{
 id:10002,url:'aiyifan:https://www.yfsp.tv/play/old?id=old&videoId=789$$$dandan:11',title:'【aiyifan&dandan】 第1集'
}],episodeNum:10002})]]);
for (const sourceMode of ['mergeAll','most']) {
 const coldDisabled = host(disabledSourceStore,respond,false);
 assert.equal((await coldDisabled.context.getCommentsById({commentId:10002,enabledSources:'aiyifan,dandan',sourceMode})).count,2);
 assert.ok(!coldDisabled.requests.some(item => /tripdata|yfsp/.test(item.url)));
}

// International decode outages must not suppress locally decodable IQIYI comments.
for (const [videoId, needsInternational] of [['w3afcc4qeo', false], ['3343928609435100', false], ['zzzzzzzzzzzzzz', true]]) {
  let internationalCalls = 0;
  const tvid = '3343928609435100';
  const iqiyiStore = new Map([[stateKey, JSON.stringify({
    animes: [], episodeIds: [{ id: 10002, url: 'https://www.iqiyi.com/v_' + videoId + '.html', title: '【qiyi】 第1集' }], episodeNum: 10002,
  })]]);
  const iqiyiResponse = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'pcw-api.iq.com') {
      internationalCalls++;
      if (!needsInternational) throw new Error('International decode unreachable');
      return { status: 200, data: { data: tvid } };
    }
    if (url.hostname === 'www.iqiyi.com') return { status: 200, data: '<title>Fixture</title>' };
    if (url.hostname === 'pcw-api.iqiyi.com') {
      assert.equal(url.pathname, '/video/video/baseinfo/' + tvid);
      return { status: 200, data: { code: 'A00000', data: { durationSec: 30, displayBarrage: true } } };
    }
    if (url.hostname === 'cmts.iqiyi.com') {
      assert.ok(url.pathname.includes('/' + tvid + '_60_1_'));
      assert.equal(options.base64Data, true);
      return { status: 200, data: brotliCompressSync(Buffer.from('<root><content>爱奇艺恢复弹幕</content><showTime>1</showTime><color>ffffff</color><likeCount>0</likeCount></root>')).toString('base64') };
    }
    assert.fail('Unexpected IQIYI request: ' + input);
  };
  for (const sourceMode of ['mergeAll', 'most']) {
    const iqiyi = host(iqiyiStore, iqiyiResponse, false);
    const result = await iqiyi.context.getCommentsById({ commentId: 10002, enabledSources: 'iqiyi', sourceMode, cacheMode: 'refresh' });
    assert.equal(result.count, 1, 'IQIYI must return comments when international decode is unavailable: ' + videoId);
    assert.equal(result.comments[0].m, '爱奇艺恢复弹幕');
  }
  assert.equal(internationalCalls, needsInternational ? 2 : 0);
}

// URL fallback must preserve encoded links and token values containing '='.
const urlHost = host();
assert.equal(vm.runInContext("new URL('../comment?p=a%3Db%3D#x', 'https://example.com/a/b').href", urlHost.context), 'https://example.com/comment?p=a%3Db%3D#x');
assert.equal(vm.runInContext("new URL('https://example.com/?q=a=b=').searchParams.get('q')", urlHost.context), 'a=b=');
// Virtual time exercises the actual bundled callbacks without 30-second sleeps.
function clock() {
  let now = 0, nextId = 0;
  const jobs = new Map();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const api = {
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setTimeout(fn, delay) { const id = ++nextId; jobs.set(id, { at: now + Math.max(0, delay), fn }); return id; },
    clearTimeout(id) { jobs.delete(id); },
  };
  return { api, flush, get now() { return now; }, async advance(ms) {
    await flush();
    const end = now + ms;
    for (;;) {
      const entry = [...jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, job]) => job.at <= end);
      if (!entry) break;
      now = entry[1].at; jobs.delete(entry[0]); entry[1].fn(); await flush();
    }
    now = end; await flush();
  } };
}

// Keep real dispatch, addAnime, merging and persistence; only replace source I/O.
const fixtureSources = `
for (const source of ['dandan', 'tencent', 'imgo', 'iqiyi']) {
  const instance = getSourceByKey(source);
  instance.search = async title => (await httpGet('https://fixture.invalid/search/' + source + '?title=' + encodeURIComponent(title))).data;
  instance.handleAnimes = async (items, title, out, details) => {
    if (!items.length) return;
    await httpGet('https://fixture.invalid/details/' + source + '?title=' + encodeURIComponent(title));
    const id = { dandan: 701, tencent: 702, imgo: 703, iqiyi: 704 }[source];
    const anime = { animeId: id, bangumiId: String(id), animeTitle: title + '(2026)【TV动画】from ' + source,
      source, type: 'tvseries', typeDescription: 'TV动画', episodeCount: 1, imageUrl: '',
      links: [{ name: '第1集', title: '【' + source + '】 第1集', url: 'fixture-' + source + '-' + title }] };
    addAnime(anime, details); out.push(anime);
  };
  instance.getEpisodeDanmu = async id => (await httpGet('https://fixture.invalid/comments/' + source + '?id=' + id)).data;
  instance.formatComments = data => data;
}
`;
const ok = data => ({ status: 200, data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixtureStore = () => new Map([[stateKey, JSON.stringify({ animes: [], episodeNum: 10002,
  episodeIds: [{ id: 10002, url: 'dandan:one$$$tencent:two$$$imgo:three', title: '【dandan&imgo&tencent】 第1集' }],
})]]);
const three = { enabledSources: 'dandan,tencent,imgo', groupMinute: 0 };

// First-render contract: the player receives its final work/episode titles
// before playback. It need not refresh or reselect to learn the true source.
for (const sourceMode of ['most','mergeAll']) {
  const episodes = [1,2,3].map(n=>({id:10001+n,url:`iqiyi:e${n}$$$tencent:e${n}`,title:`【iqiyi&tencent】 第${n}集`}));
  const saved={episodeNum:10004,episodeIds:episodes,animes:[{animeId:778,bangumiId:'778',animeTitle:'铁拳教育(2026)【韩剧】from iqiyi&tencent',links:episodes}]};
  const module=host(new Map([[stateKey,JSON.stringify(saved)]]),input=>{
    const parsed=new URL(input);
    assert.equal(parsed.searchParams.get('id'),'e3','Only the currently playing third episode may be prefetched');
    const source=parsed.pathname.split('/').at(-1);
    return ok(Array.from({length:source==='tencent'?3:2},(_,i)=>dataComment(i+1,source+'-'+i)));
  },true,undefined,fixtureSources);
  const params={title:'铁拳教育',sourceMode,enabledSources:'iqiyi,tencent',groupMinute:0,episode:3};
  const config={...module.api.normalizeConfig(params)};delete config.MAX_DANMU_SOURCE;
  const key=JSON.stringify(['search',JSON.stringify(config),params.title,undefined,undefined,undefined]);
  module.store.set(`${metadata.id}.cache.v1`,JSON.stringify([{key,expires:Date.now()+1800000,value:{result:{animes:[{animeId:778,animeTitle:saved.animes[0].animeTitle}]},state:saved}}]));
  const found=await module.context.searchDanmu(params);
  assert.match(found.animes[0].animeTitle,sourceMode==='most'?/from 腾讯$/:/from iqiyi&腾讯$/);
  const list=await module.context.getDetailById({...params,animeId:found.animes[0].animeId});
  assert.match(list[2].episodeTitle,sourceMode==='most'?/^【腾讯】/:/^【iqiyi&腾讯】/);
  const {episode,...withoutNumber}=params;
  const inherited=await module.context.getDetailById({...withoutNumber,animeId:found.animes[0].animeId});
  assert.equal(inherited[2].episodeTitle,list[2].episodeTitle,'The selected work carries its current-episode preparation into later callbacks');
  assert.equal(module.requests.length,2,'Search and details share a single full-episode fetch');
  const cold=host(module.store,()=>assert.fail('Playback must use exactly the prepared output'));
  const output=await cold.context.getCommentsById({...params,commentId:list[2].episodeId});
  assert.equal(output.count,sourceMode==='most'?3:5);
  await cold.context.clearDanmuCache();
  await assert.rejects(()=>cold.context.getCommentsById({...params,commentId:list[2].episodeId}),/过期|改变/);
}

// A failed/empty candidate must not be named as a contributor to a merge.
assert.equal(h.api.displayModeTitle('【iqiyi&tencent】 第3集','mergeAll','tencent'),'【腾讯】 第3集');

// Most labels are per episode and reflect the same full filtered count used by
// output. Unloaded/expired/cleared data must never show an assumed winner.
{
  const time = clock();
  const episodes = [1,2].map(n => ({id:10001+n,url:`iqiyi:e${n}$$$tencent:e${n}`,title:`【iqiyi&tencent】 第${n}集`}));
  const saved = {episodeNum:10003,episodeIds:episodes,animes:[{animeId:770,bangumiId:'770',
    animeTitle:'我不是大师(2026)【电视剧】from iqiyi&tencent',episodeCount:2,links:episodes}]};
  const labels = host(new Map([[stateKey,JSON.stringify(saved)]]), input => {
    const url = new URL(input), source = url.pathname.split('/').at(-1), first = url.searchParams.get('id') === 'e1';
    const count = first ? (source==='tencent'?3:2) : (source==='tencent'?1:4);
    return ok(Array.from({length:count},(_,i)=>dataComment(i+1,source+'-'+i)));
  },time.api,undefined,fixtureSources);
  const params = {animeId:770,enabledSources:'iqiyi,tencent',groupMinute:0,sourceMode:'most'};
  const config = {...labels.api.normalizeConfig(params)};
  delete config.MAX_DANMU_SOURCE;
  const searchParams = {...params,title:'我不是大师'};
  const searchKey = JSON.stringify(['search',JSON.stringify(config),searchParams.title,undefined,undefined,undefined]);
  labels.store.set(`${metadata.id}.cache.v1`,JSON.stringify([{key:searchKey,expires:time.now+1800000,
    value:{result:{animes:[{animeId:770,animeTitle:saved.animes[0].animeTitle}]},state:saved}}]));
  assert.ok(!(await labels.context.searchDanmu(searchParams)).animes[0].animeTitle.includes('from '));
  assert.deepEqual(Array.from(await labels.context.getDetailById(params),e=>e.episodeTitle),['第1集','第2集']);
  assert.equal(labels.requests.length,0,'Rendering unloaded labels must not prefetch comments');
  assert.equal((await labels.context.getCommentsById({...params,commentId:10002})).count,3);
  assert.match((await labels.context.searchDanmu({...searchParams,episode:1})).animes[0].animeTitle,/from 腾讯$/,'The work from suffix must show the loaded first-episode winner');
  assert.deepEqual(Array.from(await labels.context.getDetailById(params),e=>e.episodeTitle),['【腾讯】 第1集','第2集']);
  assert.equal((await labels.context.getCommentsById({...params,commentId:10003})).count,4);
  assert.match((await labels.context.searchDanmu({...searchParams,episode:2})).animes[0].animeTitle,/from iqiyi$/);
  assert.match((await labels.context.searchDanmu({...searchParams,episode:1})).animes[0].animeTitle,/from 腾讯$/,'Current episode must not borrow another episode winner');
  assert.match((await labels.context.searchDanmu(searchParams)).animes[0].animeTitle,/from iqiyi$/,'Without episode context use the most recently loaded episode of this work');
  assert.match((await labels.context.searchDanmu({...searchParams,sourceMode:'mergeAll'})).animes[0].animeTitle,/from iqiyi&腾讯$/);
  const coldLabels = host(labels.store,()=>assert.fail('Labels must reuse cached complete results'),time.api);
  assert.deepEqual(Array.from(await coldLabels.context.getDetailById(params),e=>e.episodeTitle),['【腾讯】 第1集','【iqiyi】 第2集']);
  assert.deepEqual(Array.from(await coldLabels.context.getDetailById({...params,sourceMode:'mergeAll'}),e=>e.episodeTitle),['【iqiyi&腾讯】 第1集','【iqiyi&腾讯】 第2集']);
  await coldLabels.context.clearDanmuCache();
  const beforeSearchReload = labels.requests.length;
  assert.ok(!(await labels.context.searchDanmu(searchParams)).animes[0].animeTitle.includes('from '),'Clearing must remove the work from suffix until loading again');
  assert.ok(labels.requests.slice(beforeSearchReload).some(r => r.url.includes('/search/')),'Clearing must search sources again');
  assert.deepEqual(Array.from(await coldLabels.context.getDetailById(params),e=>e.episodeTitle),['第1集','第2集']);
  await labels.context.getCommentsById({...params,commentId:10002});
  await time.advance(600001);
  assert.deepEqual(Array.from(await coldLabels.context.getDetailById(params),e=>e.episodeTitle),['第1集','第2集'],'Expired data must not claim a current winner');
  const restored = JSON.parse(labels.store.get(stateKey));
  assert.deepEqual(restored.animes.find(a => a.animeId === 770),saved.animes[0],'Display winners must never overwrite candidate identities');
  assert.deepEqual(restored.episodeIds.filter(e => e.id <= 10003),saved.episodeIds);
}

// Big episodes can exceed the raw-data cap. Keep only a compact observed
// winner so the label still works without increasing cache capacity.
{
  const episode = {id:10002,url:'iqiyi:e1$$$tencent:e1',title:'【iqiyi&tencent】 第1集'};
  const saved = {episodeNum:10002,episodeIds:[episode],animes:[{animeId:771,bangumiId:'771',animeTitle:'大弹幕测试',links:[episode]}]};
  const large = host(new Map([[stateKey,JSON.stringify(saved)]]), input => {
    const source = new URL(input).pathname.split('/').at(-1);
    return ok(Array.from({length:source==='tencent'?2:1},(_,i)=>dataComment(i+1,source+'x'.repeat(1100000))));
  },true,undefined,fixtureSources);
  const params = {animeId:771,enabledSources:'iqiyi,tencent',groupMinute:0,sourceMode:'most'};
  assert.equal((await large.context.getCommentsById({...params,commentId:10002})).count,2);
  const cached = JSON.parse(large.store.get(`${metadata.id}.cache.v1`));
  assert.ok(cached.some(entry=>JSON.parse(entry.key).at(-1)==='winner'));
  assert.ok(cached.some(entry=>JSON.parse(entry.key)[2]==='workSource'));
  assert.match((await large.context.getDetailById(params))[0].episodeTitle,/^【腾讯】/);
  assert.equal(large.requests.length,2,'Displaying the observed winner must not refetch an oversized episode');
  await large.context.clearDanmuCache();
  assert.equal((await large.context.getDetailById(params))[0].episodeTitle,'第1集');
}

// A consumer may retain the already downloaded episode by its public ID.
// Re-entering the same episode under another policy or after clearing must
// invalidate that consumer identity, not merely delete Widget.storage data.
{
  const episode = {id:10002,url:'iqiyi:e1$$$tencent:e1',title:'【iqiyi&tencent】 第1集'};
  const saved = {episodeNum:10002,episodeIds:[episode],animes:[{animeId:772,bangumiId:'772',animeTitle:'机智的医生生活 第二季',links:[episode]}]};
  const module = host(new Map([[stateKey,JSON.stringify(saved)]]), input => {
    const source = new URL(input).pathname.split('/').at(-1);
    return ok(Array.from({length:source==='tencent'?3:2},(_,i)=>dataComment(i+1,source+'-'+i)));
  },true,undefined,fixtureSources);
  const nativeCache = new Map();
  const params = {animeId:772,enabledSources:'iqiyi,tencent',groupMinute:0};
  const play = async sourceMode => {
    const [selected] = await module.context.getDetailById({...params,sourceMode});
    if (!nativeCache.has(String(selected.episodeId))) nativeCache.set(String(selected.episodeId),
      await module.context.getCommentsById({...params,sourceMode,commentId:selected.episodeId}));
    return {id:selected.episodeId,...nativeCache.get(String(selected.episodeId))};
  };
  const merged = await play('mergeAll');
  assert.equal(merged.count,5);
  const most = await play('most');
  assert.notEqual(most.id,merged.id,'Same episode in different modes must not share a player-cache identity');
  assert.equal(most.count,3);
  await module.context.clearDanmuCache();
  const cleared = await play('most');
  assert.notEqual(cleared.id,most.id,'Clearing must issue a new public episode identity on re-selection');
  assert.equal(cleared.count,3);
  const slow = deferred();
  const oldInstance = host(module.store,()=>slow.promise,true,undefined,fixtureSources);
  const incoming = oldInstance.context.getCommentsById({...params,sourceMode:'most',commentId:10002,refresh:true});
  await new Promise(resolve=>setImmediate(resolve));
  const clearer = host(module.store);
  await clearer.context.clearDanmuCache();
  slow.resolve(ok([dataComment(1,'迟到结果')]));
  await incoming;
  assert.ok(!JSON.parse(module.store.get(`${metadata.id}.cache.v1`)).some(e=>JSON.parse(e.key)[0]==='comments'),
    'An in-flight old callback must not restore comments after clearing');
}

// An old search finishing after a clear must not repopulate the search cache.
{
  const time = clock(), slow = deferred(), store = new Map();
  const old = host(store, input => input.includes('/search/') ? slow.promise : ok({}), time.api, undefined, fixtureSources);
  const incoming = old.context.searchDanmu({title:'清理中的搜索',enabledSources:'dandan'});
  await time.flush();
  assert.ok(old.requests.some(r => r.url.includes('/search/')));
  await host(store).context.clearDanmuCache();
  slow.resolve(ok([{}]));
  await incoming;
  assert.ok(!JSON.parse(store.get(`${metadata.id}.cache.v1`)).some(e=>JSON.parse(e.key)[0]==='search'),
    'An old in-flight search must not write back after clearing');
  const fresh = host(store,input => ok(input.includes('/search/') ? [{}] : {}), time.api, undefined, fixtureSources);
  await fresh.context.searchDanmu({title:'清理中的搜索',enabledSources:'dandan'});
  assert.ok(fresh.requests.some(r=>r.url.includes('/search/')));
}

// Clear search, payloads, prepared output and source summaries together.
// Episode routing IDs remain usable; clearing itself does not fetch anything.
{
  const timed = host(fixtureStore(), () => ok([dataComment(1,'缓存测试')]), true, undefined, fixtureSources);
  const params = {...three, commentId:10002};
  await timed.context.getCommentsById(params);
  const requestCount = timed.requests.length;
  const cacheKey = `${metadata.id}.cache.v1`;
  const entries = JSON.parse(timed.store.get(cacheKey));
  entries.push({key:JSON.stringify(['search','sentinel']),expires:Date.now()+60000,value:{test:true}});
  timed.store.set(cacheKey,JSON.stringify(entries));
  const state = timed.store.get(stateKey);
  const cleared = await timed.context.clearDanmuCache();
  assert.match(cleared[0].title,/已清理/);
  assert.match(cleared[0].description,/搜索结果、预加载弹幕、已下载弹幕和来源标签记录/);
  assert.equal(timed.requests.length,requestCount);
  assert.equal(timed.store.get(stateKey),state);
  assert.deepEqual(JSON.parse(timed.store.get(cacheKey)),[],'Search cache must also be removed');
  assert.deepEqual(JSON.parse(timed.store.get(`${metadata.id}.prepared.v1`)),[]);
  assert.ok(timed.traces.some(line => line.includes('[LogVar缓存]') && line.includes('"verified":true')));
  await timed.context.getCommentsById(params);
  assert.equal(timed.requests.length,requestCount+3);
  const broken = host(timed.store);
  broken.context.Widget.storage.set = async () => {throw new Error('storage unavailable')};
  await assert.rejects(() => broken.context.clearDanmuCache(),/storage unavailable/);
  const silent = host(timed.store);
  silent.context.Widget.storage.set = async () => {};
  await assert.rejects(() => silent.context.clearDanmuCache(),/校验|未生效/,'A silently ignored write must not report successful clearing');
}

// A title hit is insufficient: the 5s clock starts after its episode list exists.
{
  const time = clock(), late = deferred();
  const timed = host(new Map(), async input => {
    const url = new URL(input), source = url.pathname.split('/').at(-1);
    if (source === 'imgo') return late.promise;
    if (url.pathname.startsWith('/search/')) return ok([{}]);
    return new Promise(resolve => time.api.setTimeout(() => resolve(ok({})), source === 'dandan' ? 6000 : 20000));
  }, time.api, undefined, fixtureSources);
  let result;
  const task = timed.context.searchDanmu({ ...three, title: '窗口甲' }).then(value => { result = value; });
  await time.advance(5000); assert.equal(result, undefined);
  await time.advance(5999); assert.equal(result, undefined);
  await time.advance(1); await task;
  assert.ok(result.animes.some(a => a.animeId !== '__empty__'));
  const persisted = timed.store.get(stateKey);
  assert.ok(!JSON.parse(persisted).animes.some(a => a.source === 'tencent'));
  // A new callback owns a new core; late responses cannot change its state.
  await timed.context.searchDanmu({ title: '' });
  const current = timed.store.get(stateKey);
  late.resolve(ok([{}])); await time.advance(10000);
  assert.equal(timed.store.get(stateKey), current);
  assert.ok(!timed.requests.some(r => r.url.includes('/details/imgo')));
}

// Both strategies use only completed sources, retain later in-window data,
// and reuse pre-alignment cache without another request on a mode switch.
for (const sourceMode of ['mergeAll', 'most']) {
  const time = clock();
  const timed = host(fixtureStore(), async input => {
    const source = new URL(input).pathname.split('/').at(-1);
    if (source === 'imgo') return new Promise(() => {});
    const data = source === 'dandan' ? [dataComment(1, '甲')] : [dataComment(2, '乙'), dataComment(3, '丙'), dataComment(4, '丁')];
    return new Promise(resolve => time.api.setTimeout(() => resolve(ok(data)), source === 'dandan' ? 1000 : 10000));
  }, time.api, undefined, fixtureSources);
  let result;
  const task = timed.context.getCommentsById({ ...three, commentId: 10002, sourceMode }).then(value => { result = value; });
  await time.advance(10999); assert.equal(result, undefined);
  await time.advance(1); await task;
  assert.equal(result.count, sourceMode === 'most' ? 3 : 4);
  const count = timed.requests.length;
  const other = await timed.context.getCommentsById({ ...three, commentId: 10002, sourceMode: sourceMode === 'most' ? 'mergeAll' : 'most' });
  assert.equal(other.count, sourceMode === 'most' ? 4 : 3);
  assert.equal(timed.requests.length, count);
  await time.advance(600001);
  const expired = timed.context.getCommentsById({ ...three, commentId: 10002 });
  await time.advance(11000); await expired;
  assert.equal(timed.requests.length, count + 3, '10min cache must expire');
  const refresh = timed.context.getCommentsById({ ...three, commentId: 10002, cacheMode: 'refresh' });
  await time.advance(11000); await refresh;
  assert.equal(timed.requests.length, count + 6, 'manual refresh must bypass cache');
}

// Empty comments do not start a window; a host that never settles is bounded
// by the 15s per-request deadline, even when it ignores its timeout argument.
{
  const time = clock();
  const timed = host(fixtureStore(), async input => {
    const source = new URL(input).pathname.split('/').at(-1);
    if (source === 'dandan') return ok([]);
    if (source === 'imgo') return new Promise(() => {});
    return new Promise(resolve => time.api.setTimeout(() => resolve(ok([dataComment(1, '晚到有效')])), 12000));
  }, time.api, undefined, fixtureSources);
  let result;
  const task = timed.context.getCommentsById({ ...three, commentId: 10002 }).then(value => { result = value; });
  await time.advance(10000); assert.equal(result, undefined);
  await time.advance(4999); assert.equal(result, undefined);
  await time.advance(1); await task; assert.equal(result.count, 1);
}

// Retries/sequential calls share a 30s budget; each successive request gets
// only the remaining time. No usable first result means no grace window.
for (const stage of ['search', 'comments']) {
  const time = clock();
  const serial = `
    getSourceByKey('dandan').${stage === 'search' ? 'search' : 'getEpisodeDanmu'} = async () => {
      for (let i = 0; i < 4; i++) await httpGet('https://fixture.invalid/step/' + i);
      return [];
    };
  `;
  const timed = host(fixtureStore(), () => new Promise(resolve => time.api.setTimeout(() => resolve(ok([])), 12000)), time.api, undefined, fixtureSources + serial);
  let result;
  const task = (stage === 'search'
    ? timed.context.searchDanmu({ enabledSources: 'dandan', title: '阶段上限' })
    : timed.context.getCommentsById({ enabledSources: 'dandan', commentId: 10002 }))
    .then(value => { result = value; });
  await time.advance(29999); assert.equal(result, undefined);
  await time.advance(1); await task;
  assert.equal(stage === 'search' ? result.animes[0].animeId : result.count, stage === 'search' ? '__empty__' : 0);
  assert.equal(timed.requests.length, 3);
  assert.deepEqual(timed.requests.map(r => r.options.timeout), [15000, 15000, 6000]);
  await time.advance(30000); assert.equal(timed.requests.length, 3);
}

// Fast sources return immediately; search reuse and refresh retain valid IDs.
{
  const time = clock();
  const timed = host(new Map(), input => ok(new URL(input).pathname.startsWith('/search/') ? [{}] : {}), time.api, undefined, fixtureSources);
  const params = { enabledSources: 'dandan', title: '缓存作品' };
  const first = await timed.context.searchDanmu(params);
  assert.equal(time.now, 0);
  const count = timed.requests.length;
  assert.deepEqual(JSON.parse(JSON.stringify(await timed.context.searchDanmu(params))), JSON.parse(JSON.stringify(first)));
  assert.equal(timed.requests.length, count);
  const detail = await timed.context.getDetailById({ ...params, animeId: first.animes[0].animeId });
  assert.ok(detail.length > 0);
  await timed.context.searchDanmu({ ...params, cacheMode: 'refresh' });
  assert.equal(timed.requests.length, count + 2);
  await time.advance(1800001);
  await timed.context.searchDanmu(params);
  assert.equal(timed.requests.length, count + 4);
}

// Real segmented source loops must not return their first successful fragment
// after a later fragment failed. Android source files remain untouched.
for (const source of ['tencent', 'imgo', 'iqiyi', 'youku', 'bilibili']) {
  const segmentStore = new Map([[stateKey, JSON.stringify({ animes: [], episodeNum: 10002,
    episodeIds: [{ id: 10002, url: 'https://fixture.invalid/page', title: `【${source}】 第1集` }],
  })]]);
  const inject = `
    const instance = getSourceByKey('${source}');
    instance.getEpisodeDanmuSegments = async () => ({ segmentList: ['good', 'bad'].map(key => ({ url: 'https://fixture.invalid/' + key, data: {} })) });
    instance.formatComments = value => value;
    ${source === 'bilibili' ? "instance.getEpisodeSegmentDanmu = async segment => { if (segment.url.endsWith('bad')) throw new Error('fragment failed'); return [{ p: '1,1,16777215,[test]', m: 'fragment' }]; };" : ''}
  `;
  const segmented = host(segmentStore, async input => {
    if (input.endsWith('/page')) return ok('<title>fixture</title>');
    if (input.endsWith('/bad')) throw new Error('fragment failed');
    if (source === 'iqiyi') return ok(brotliCompressSync(Buffer.from('<root><content>fragment</content><showTime>1</showTime><color>ffffff</color></root>')).toString('base64'));
    if (source === 'tencent') return ok({ barrage_list: [dataComment(1, 'fragment')] });
    if (source === 'imgo') return ok({ data: { items: [dataComment(1, 'fragment')] } });
    return ok({ data: { result: JSON.stringify({ code: '0', data: { result: [dataComment(1, 'fragment')] } }) } });
  }, true, undefined, inject);
  const result = await segmented.context.getCommentsById({ enabledSources: source, commentId: 10002 });
  assert.equal(result.count, 0, source + ' must discard incomplete episodes');
}

// Concurrent duplicate GETs share one request; complete fast data has no delay.
{
  const time = clock();
  const inject = fixtureSources + `getSourceByKey('dandan').getEpisodeDanmu = async () => {
    const [a] = await Promise.all([httpGet('https://fixture.invalid/same'), httpGet('https://fixture.invalid/same')]); return a.data;
  };`;
  const timed = host(fixtureStore(), () => ok([dataComment(1, '去重请求')]), time.api, undefined, inject);
  const first = timed.context.getCommentsById({ enabledSources: 'dandan', commentId: 10002 });
  const second = timed.context.getCommentsById({ commentId: 10002, enabledSources: 'dandan' });
  assert.equal(first, second, 'identical pending callbacks must share a task');
  assert.equal((await first).count, 1);
  assert.equal(time.now, 0);
  assert.equal(timed.requests.length, 1);
}

// Metadata-first source dispatch observes the same five-second window.
{
  const time = clock();
  const timed = host(new Map(), async input => {
    if (input.includes('/imdb/')) return ok({ id: 'https://api.douban.com/movie/777' });
    if (input.includes('/movie/777')) return ok({ title: '资料匹配', year: '2026', is_tv: true,
      vendors: [{ uri: 'https://mgtv.com/b/123/456.html' }] });
    const source = new URL(input).pathname.split('/').at(-1);
    if (source !== 'imgo') return new Promise(() => {});
    return ok({});
  }, time.api, { get: async () => ({ imdb_id: 'tt12345' }) }, fixtureSources);
  let result;
  const task = timed.context.searchDanmu({ ...three, title: '资料匹配', tmdbId: 123, type: 'tv', season: 1 }).then(value => { result = value; });
  await time.advance(4999); assert.equal(result, undefined);
  await time.advance(1); await task;
  assert.ok(result.animes.some(a => a.animeId !== '__empty__'));
  assert.ok(!timed.requests.some(r => r.url.includes('/search/imgo')));
}

// Empty metadata matches fall back to the player's title without starting a
// second 30s budget or attempting new requests on a closed stage.
{
  const time = clock();
  const inject = fixtureSources + `
    const original = getSourceByKey('imgo').handleAnimes;
    getSourceByKey('imgo').handleAnimes = async (items, title, ...args) => {
      if (title === '空资料名') return;
      return original(items, title, ...args);
    };
  `;
  const timed = host(new Map(), async input => {
    if (input.includes('/imdb/')) return ok({ id: 'https://api.douban.com/movie/777' });
    if (input.includes('/movie/777')) return ok({ title: '空资料名', is_tv: true, vendors: [{ uri: 'https://mgtv.com/b/123/456.html' }] });
    const url = new URL(input);
    return ok(url.pathname.startsWith('/search/') ? [{}] : {});
  }, time.api, { get: async () => ({ imdb_id: 'tt12345' }) }, inject);
  const result = await timed.context.searchDanmu({ title: '原始剧名', tmdbId: 123, type: 'tv', season: 1, enabledSources: 'imgo' });
  assert.ok(result.animes.some(a => a.animeTitle.includes('原始剧名')));
  assert.equal(time.now, 0);
}

console.log(`${target} offline checks passed: 5s/10s windows, 15s requests, 30s stage budgets, late-result isolation, cache reuse/expiry/refresh, IQIYI decode, disabled Aiyifan, media matching, season/movie identities, source selection, cold starts and importer metadata.`);

if (process.argv.includes('--live')) {
  // Explicit native agents avoid environment/browser/system proxy settings.
  const [{ default: directFetch }, { Agent: HttpAgent }, { Agent: HttpsAgent }] = await Promise.all([
    import('node-fetch'), import('node:http'), import('node:https'),
  ]);
  const directHttp = new HttpAgent(), directHttps = new HttpsAgent();
  const live = host(new Map(), async (url, options = {}) => {
    const response = await directFetch(url, { headers: options.headers,
      agent: parsed => parsed.protocol === 'https:' ? directHttps : directHttp,
      signal: AbortSignal.timeout(options.timeout || 15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { status: response.status, headers: Object.fromEntries(response.headers),
      data: options.base64Data ? Buffer.from(await response.arrayBuffer()).toString('base64') : await response.text() };
  });
  const params = { enabledSources: 'dandan', title: 'FX战士久留美', sourceMode: 'most' };
  const result = await live.context.searchDanmu(params);
  assert.ok(result.animes.length, 'Live search returned no results');
  const list = await live.context.getDetailById({ ...params, animeId: result.animes[0].animeId });
  assert.ok(list.length, 'Live detail returned no episodes');
  const comments = await live.context.getCommentsById({ ...params, commentId: list[0].episodeId });
  assert.ok(comments.count > 0, 'Live episode returned no comments');
  directHttp.destroy(); directHttps.destroy();
  console.log(`Direct live bundled API check passed: ${result.animes.length} title(s), ${list.length} episode(s), first episode ${comments.count} comments. ${target} device import/playback remains unverified.`);
}
