import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { brotliCompressSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
const target = process.argv.includes('--rex') ? 'rex' : 'forward';
const { default: metadata } = await import(`../${target}/metadata.js`);

const code = await readFile(new URL(`../dist/logvar-${target}-${metadata.version}.js`, import.meta.url), 'utf8');
const rawComment = (time, text) => ({ p: `${time},1,25,16777215,0,0,user,1`, m: text });
const dataComment = (time, text) => ({ p: `${time},1,16777215,[test]`, m: text });
const stateKey = `${metadata.id}.state.v1`;

function host(store = new Map(), respond = async () => { throw new Error('Unexpected HTTP call'); }, timers = true, tmdb) {
  const httpResponse = async (url, options, body) => {
    const response = await respond(url, options, body);
    if (target !== 'rex') return response;
    const { status, ...rest } = response;
    return { ...rest, statusCode: status };
  };
  const requests = [];
  const warnings = [];
  const context = vm.createContext({
    console: { log() {}, info() {}, warn(...args) { warnings.push(args.join(' ')); }, error(...args) { warnings.push(args.join(' ')); } },
    ...(timers ? { setTimeout, clearTimeout } : {}),
    Widget: {
      ...(tmdb ? { tmdb: { async get(path) {
        if (target === 'rex') {
          assert.ok(!path.startsWith('/'), 'Rex TMDB paths must be relative to /3/');
          return tmdb.get('/' + path);
        }
        return tmdb.get(path);
      } } } : {}),
      storage: { async get(key) { return store.get(key); }, async set(key, value) { store.set(key, value); } },
      http: {
        async get(url, options) { requests.push({ method: 'GET', url, options }); return httpResponse(url, options); },
        async post(url, body, options) { requests.push({ method: 'POST', url, body, options }); return httpResponse(url, options, body); },
      },
    },
  });
  new vm.Script(code).runInContext(context, { timeout: 10000 });
  return { context, api: context.LogvarForward, store, requests, warnings };
}

const h = host();
assert.ok(code.startsWith('var WidgetMetadata = '));
for (const module of metadata.modules) assert.equal(typeof h.context[module.functionName], 'function');
assert.deepEqual(JSON.parse(JSON.stringify(h.context.WidgetMetadata)), metadata);
assert.equal(metadata.id, `logvar.${target}.local`);
assert.equal(metadata.title, 'LogVar');
// Rex's native importer rejects metadata without this field (device A/B test).
assert.match(h.context.WidgetMetadata.requiredVersion ?? '', /^\d+\.\d+\.\d+$/, 'Importer requires requiredVersion');
assert.deepEqual(metadata.globalParams[0].enumOptions.map(option => option.value), ['mergeAll', 'most']);
assert.ok(!metadata.globalParams.some(param => /sourceOrder|platformOrder|otherServer|priority/i.test(param.name)));
assert.equal(h.api.normalizeConfig({ enabledSources: 'youku,bilibili,tencent' }).SOURCE_ORDER,
  h.api.normalizeConfig({ enabledSources: 'tencent,youku,bilibili' }).SOURCE_ORDER);
assert.throws(() => h.api.normalizeConfig({ enabledSources: 'unknown' }), /不支持/);
assert.throws(() => h.api.normalizeConfig({ sourceMode: 'priority' }), /不支持/);
assert.throws(() => h.api.normalizeConfig({ groupMinute: -1 }), /0～30/);
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
assert.equal((await partial.context.getCommentsById({ commentId: 10002, enabledSources: 'dandan' })).count, 2);
await assert.rejects(() => partial.context.getCommentsById({ commentId: 'bad' }), /ID/);
await assert.rejects(() => partial.context.getCommentsById({ commentId: 999 }), /失效/);

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
const commenting = host(lifecycleStore, lifecycleResponse, false);
const fullResult = await commenting.context.getCommentsById({ ...lifecycleParams, commentId: details[0].episodeId });
assert.equal(fullResult.count, 1);
assert.equal(fullResult.comments[0].m, '完整流程测试');

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

// Replay beta 11 Aiyifan through both real bundles, including cold starts.
assert.ok(h.api.normalizeConfig().SOURCE_ORDER.split(',').includes('aiyifan'));
for (const timers of [true, false]) {
  const aiyifanStore = new Map();
  let configCalls = 0, expired = false;
  const aiyifanResponse = async (input, options, body) => {
    const url = new URL(input);
    let data;
    if (url.pathname === '/api/home/config') {
      configCalls++;
      data = { list: { pConfig: { publicKey: 'fixture-public', privateKey: ['fixture-private'] } } };
    } else {
      if (url.hostname === 'api.tripdata.app') {
        assert.equal(options.headers['x-pub'], 'fixture-public');
        assert.equal(options.headers['x-sign'], createHash('md5').update(url.search.slice(1) + options.headers['x-timestamp'] + 'fixture-private').digest('hex'));
      }
      if (url.pathname === '/api/List/GetTitleGetData') {
        assert.equal(JSON.parse(body).SearchCriteria, '偷天父子兵');
        data = { list: [{ title: '偷天父子兵', mediaKey: 'fixture-media', mediaType: '电影', coverImgUrl: 'https://fixture.invalid/cover.jpg', episodes: [] }] };
      } else if (url.pathname === '/api/Video/VideoChooseGather') {
        assert.equal(JSON.parse(body).mediaKey, 'fixture-media');
        data = { list: [{ episodeKey: 'fixture-episode', uniqueID: 789, episodeId: 123, episodeTitle: '正片', videoType: 1 }] };
      } else if (url.pathname === '/api/Video/GetBarrages') {
        assert.equal(url.searchParams.get('videoId'), '789', 'Use uniqueID rather than episodeId');
        assert.equal(url.searchParams.get('mediaKey'), 'fixture-media');
        if (expired) { expired = false; return { status: 401, data: { ret: 401, msg: 'expired' } }; }
        data = { list: [{ second: 12, position: 1, color: '#ffffff', content: '爱壹帆测试弹幕', good: 2 }] };
      } else if (url.pathname === '/api/Video/VideoDetails') {
        data = { detailInfo: { uniqueID: 789, episodeId: 123, videoType: 1 } };
      } else if (url.pathname === '/v3/list/briefsearch') {
        // An unavailable optional year endpoint must not discard playable results.
        return { status: 403, data: { ret: 403, msg: 'region blocked' } };
      } else assert.fail('Unexpected Aiyifan request: ' + input);
    }
    return { status: 200, data: JSON.stringify({ ret: 200, data }) };
  };
  const params = { title: '偷天父子兵', enabledSources: 'aiyifan', groupMinute: 0 };
  const searching = host(aiyifanStore, aiyifanResponse, timers);
  const result = await searching.context.searchDanmu(params);
  assert.equal(result.animes.length, 1);
  assert.match(result.animes[0].animeTitle, /from 爱壹帆$/);
  const stored = JSON.parse(aiyifanStore.get(stateKey));
  assert.ok(stored.animes.some(item => item.animeTitle.endsWith('from aiyifan')), JSON.stringify(stored) + searching.warnings.join('\n'));
  assert.ok(stored.episodeIds.some(item => item.url.includes('videoId=789')));
  const detailing = host(aiyifanStore, aiyifanResponse, timers);
  const detail = await detailing.context.getDetailById({ ...params, animeId: result.animes[0].animeId });
  assert.match(detail[0].episodeTitle, /【爱壹帆】/);
  for (const sourceMode of ['mergeAll', 'most']) {
    expired = true;
    const before = configCalls;
    const commenting = host(aiyifanStore, aiyifanResponse, timers);
    const comments = await commenting.context.getCommentsById({ ...params, sourceMode, commentId: detail[0].episodeId });
    assert.equal(comments.count, 1);
    assert.equal(comments.comments[0].m, '爱壹帆测试弹幕');
    assert.equal(configCalls, before + 2, 'Cold start config plus refresh after expired signature');
  }
  // Old persisted links without videoId recover it through the detail endpoint.
  for (const episode of stored.episodeIds) episode.url = episode.url.replace(/&videoId=789/, '');
  aiyifanStore.set(stateKey, JSON.stringify(stored));
  const legacy = host(aiyifanStore, aiyifanResponse, timers);
  assert.equal((await legacy.context.getCommentsById({ ...params, commentId: detail[0].episodeId })).count, 1);
  assert.ok(legacy.requests.some(item => item.url.includes('/api/Video/VideoDetails')));
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
    const result = await iqiyi.context.getCommentsById({ commentId: 10002, enabledSources: 'iqiyi', sourceMode });
    assert.equal(result.count, 1, 'IQIYI must return comments when international decode is unavailable: ' + videoId);
    assert.equal(result.comments[0].m, '爱奇艺恢复弹幕');
  }
  assert.equal(internationalCalls, needsInternational ? 2 : 0);
}

// URL fallback must preserve encoded links and token values containing '='.
const urlHost = host();
assert.equal(vm.runInContext("new URL('../comment?p=a%3Db%3D#x', 'https://example.com/a/b').href", urlHost.context), 'https://example.com/comment?p=a%3Db%3D#x');
assert.equal(vm.runInContext("new URL('https://example.com/?q=a=b=').searchParams.get('q')", urlHost.context), 'a=b=');
console.log(`${target} offline checks passed: IQIYI local decode and international fallback, Aiyifan signed lifecycle, expired signature refresh, legacy links, timerless hosts, media-first matching, season/movie identities, title fallback, enabled sources, merged results, empty hint, metadata, both modes, valid counts, blocked words, ties, source failure, cold start, config changes and URL fallback.`);

if (process.argv.includes('--live')) {
  const live = host(new Map(), async (url, options = {}) => {
    const response = await fetch(url, { headers: options.headers, signal: AbortSignal.timeout(15000) });
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
  console.log(`Live bundled API check passed: ${result.animes.length} title(s), ${list.length} episode(s), first episode ${comments.count} comments. ${target} device import/playback remains unverified.`);
}
