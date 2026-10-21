import test from 'node:test';
import assert from 'node:assert/strict';

// Replay the inconsistent upstream responses that hid FX战士久留美 in 9.0.0.
for (const base of ['../server/danmu_api', '../app/src/main/assets/nodejs-project/danmu_api']) {
  test(base + ': Dandan empty detail episodes', async (t) => {
    const { Globals } = await import(base + '/configs/globals.js');
    const { searchAnime, getBangumi, getComment } = await import(base + '/apis/dandan-api.js');
    const { getSourceByKey } = await import(base + '/sources/registry.js');
    const anime = { animeId: 19847, animeTitle: 'FX战士久留美', type: 'tvseries', startDate: '2026-10-01' };
    const episodes = [{ episodeId: 198470001, episodeTitle: '第1话 FX⋯是什么？' }];
    const originalFetch = globalThis.fetch;
    let detailEpisodes = [], fallbackAnimes = [], fallbackFails = false, fallbackCalls = 0;
    globalThis.fetch = async (input) => {
      const outer = new URL(input);
      assert.equal(outer.hostname, 'api.danmaku.weeblify.app');
      const url = new URL(outer.searchParams.get('path'), 'https://fixture.invalid');
      let data;
      if (url.pathname === '/v2/search/anime') data = { animes: [anime] };
      else if (url.pathname === '/v2/bangumi/19847') data = { bangumi: { ...anime, titles: [{ title: anime.animeTitle }], episodes: detailEpisodes } };
      else if (url.pathname === '/v2/search/episodes') {
        fallbackCalls++;
        assert.equal(url.searchParams.get('anime'), anime.animeTitle);
        if (fallbackFails) return new Response('{}', { status: 503 });
        data = { animes: fallbackAnimes };
      } else if (url.pathname === '/v2/comment/198470001') data = { comments: [{ cid: 1, p: '1,1,16777215,1', m: '测试弹幕' }] };
      else assert.fail('Unexpected request: ' + url.pathname);
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    };
    Globals.init({ SOURCE_ORDER: 'dandan', LOG_LEVEL: 'error', USE_BANGUMI_DATA: 'false' });
    try {
      await t.test('search → bangumi → first episode comments survives empty detail list', async () => {
        // A different series can precede the correct result. Titles alone are insufficient.
        fallbackAnimes = [{ animeId: 1673, episodes: [{ episodeId: 16730001 }] }, { ...anime, animeId: String(anime.animeId), episodes }];
        const search = await (await searchAnime(new URL('http://localhost/api/v2/search/anime?keyword=' + encodeURIComponent(anime.animeTitle)))).json();
        assert.equal(search.animes.length, 1, 'The playable series must remain in search results');
        const detail = await (await getBangumi('/api/v2/bangumi/' + search.animes[0].animeId)).json();
        assert.equal(detail.bangumi.episodes.length, 1);
        const comment = await (await getComment('/api/v2/comment/' + detail.bangumi.episodes[0].episodeId, 'json', false, '127.0.0.1')).json();
        assert.equal(comment.count, 1);
        assert.match(comment.comments[0].m, /测试弹幕/);
        assert.equal(fallbackCalls, 1);
      });
      await t.test('complete details do not trigger a fallback', async () => {
        detailEpisodes = episodes;
        fallbackCalls = 0;
        assert.deepEqual((await getSourceByKey('dandan').getEpisodes(19847)).episodes, episodes);
        assert.equal(fallbackCalls, 0);
      });
      await t.test('fallback never borrows episodes from another anime ID', async () => {
        detailEpisodes = [];
        fallbackAnimes = [{ ...anime, animeId: 1673, episodes }];
        assert.deepEqual((await getSourceByKey('dandan').getEpisodes(19847)).episodes, []);
      });
      await t.test('fallback failure preserves detail metadata', async () => {
        fallbackFails = true;
        const detail = await getSourceByKey('dandan').getEpisodes(19847);
        assert.deepEqual(detail.episodes, []);
        assert.deepEqual(detail.titles, [anime.animeTitle]);
        assert.equal(detail.type, 'tvseries');
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
