import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

for (const base of ['../server/danmu_api', '../app/src/main/assets/nodejs-project/danmu_api']) {
  test(base + ': Aiyifan App API', async t => {
    const { Globals } = await import(base + '/configs/globals.js');
    const { searchAnime, getBangumi, getComment } = await import(base + '/apis/dandan-api.js');
    const { getSourceByKey } = await import(base + '/sources/registry.js');
    const source = getSourceByKey('aiyifan');
    Globals.init({ SOURCE_ORDER: 'aiyifan', LOG_LEVEL: 'error', USE_BANGUMI_DATA: 'false' });
    const originalFetch = globalThis.fetch;
    let configCalls = 0, detailCalls = 0, rejectOnce = false;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      let data;
      if (url.pathname === '/api/home/config') {
        configCalls++;
        data = { list: { pConfig: { publicKey: 'fixture-public', privateKey: ['fixture-private'] } } };
      } else {
        const headers = new Headers(init.headers);
        if (url.hostname === 'api.tripdata.app') assert.equal(headers.get('x-pub'), 'fixture-public');
        const expected = createHash('md5').update(url.search.slice(1) + headers.get('x-timestamp') + 'fixture-private').digest('hex');
        if (url.hostname === 'api.tripdata.app') assert.equal(headers.get('x-sign'), expected);
        if (url.pathname === '/api/List/GetTitleGetData') {
          assert.equal(init.method, 'POST');
          assert.equal(JSON.parse(init.body).SearchCriteria, '偷天父子兵');
          data = { list: [{ title: '偷天父子兵', mediaKey: 'fixture-media', mediaType: '电影', coverImgUrl: 'https://fixture.invalid/cover.jpg', postTime: '2026-10-22', episodes: [] }] };
        } else if (url.pathname === '/api/Video/VideoChooseGather') {
          assert.equal(JSON.parse(init.body).mediaKey, 'fixture-media');
          data = { list: [{ episodeKey: 'fixture-episode', uniqueID: 789, episodeId: 123, episodeTitle: '正片', videoType: 1 }] };
        } else if (url.pathname === '/api/Video/VideoDetails') {
          detailCalls++;
          data = { detailInfo: { uniqueID: 789, episodeId: 123, videoType: 1 } };
        } else if (url.pathname === '/api/Video/GetBarrages') {
          assert.equal(url.searchParams.get('videoId'), '789', 'Use uniqueID, never the different episodeId');
          assert.equal(url.searchParams.get('mediaKey'), 'fixture-media');
          if (rejectOnce) { rejectOnce = false; return new Response(JSON.stringify({ ret: 401, msg: 'expired' })); }
          data = { list: [{ second: 12, position: 1, color: '#ffffff', content: '测试弹幕', good: 2 }] };
        } else if (url.pathname === '/v3/list/briefsearch') {
          data = { info: [{ result: [{ contxt: 'fixture-media', postTime: '2026-01-01' }] }] };
        } else assert.fail('Unexpected request: ' + url.pathname);
      }
      return new Response(JSON.stringify({ ret: 200, data }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      await t.test('search → bangumi → comments uses new App endpoints and uniqueID', async () => {
        const search = await (await searchAnime(new URL('http://localhost/api/v2/search/anime?keyword=' + encodeURIComponent('偷天父子兵')))).json();
        assert.equal(search.animes.length, 1);
        assert.equal(search.animes[0].source, 'aiyifan');
        const detail = await (await getBangumi('/api/v2/bangumi/' + search.animes[0].animeId)).json();
        assert.equal(detail.bangumi.episodes.length, 1);
        assert.match(detail.bangumi.episodes[0].url, /videoId=789/);
        const comments = await (await getComment('/api/v2/comment/' + detail.bangumi.episodes[0].episodeId, 'json', false, '127.0.0.1')).json();
        assert.equal(comments.count, 1);
        assert.equal(comments.comments[0].m, '测试弹幕');
        assert.equal(detailCalls, 0);
      });
      await t.test('old cached episode links recover uniqueID from detail', async () => {
        assert.equal((await source.getEpisodeDanmu('https://www.yfsp.tv/play/fixture-media?id=fixture-episode')).length, 1);
        assert.equal(detailCalls, 1);
      });
      await t.test('expired signing configuration refreshes once and retries', async () => {
        const before = configCalls;
        rejectOnce = true;
        assert.equal((await source.fetchBarrage('fixture-media', 789, 1)).length, 1);
        assert.equal(configCalls, before + 1);
      });
      await t.test('missing optional website year does not hide playable results', async () => {
        source.signingProvider.lookupYears = async () => new Map();
        const results = await source.search('偷天父子兵');
        assert.equal(results.length, 1);
        assert.equal(results[0].year, null);
      });
    } finally { globalThis.fetch = originalFetch; }
  });
}
