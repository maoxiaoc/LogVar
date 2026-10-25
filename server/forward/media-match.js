// SPDX-License-Identifier: AGPL-3.0-only
import { globals } from '../danmu_api/configs/globals.js';
import { getDoubanInfoByImdbId, getDoubanDetail } from '../danmu_api/utils/douban-util.js';
import { getImdbepisodes } from '../danmu_api/utils/imdb-util.js';
import { getSourceMetaByKey } from '../danmu_api/sources/registry.js';
import { applyMergeLogic } from '../danmu_api/utils/merge-util.js';
import { storeAnimeIdsToMap } from '../danmu_api/utils/cache-util.js';
import { collectSearch, markSearchDetails, widgetRequest } from './stages.js';

function dataOf(response) {
  if (response?.status !== undefined && (response.status < 200 || response.status >= 300)) return null;
  const value = response?.data ?? response;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// Only extract platform identities; never follow arbitrary vendor URLs.
export function mediaVendor(vendor, type) {
  if (!vendor || vendor.is_ad || typeof vendor.uri !== 'string') return null;
  try {
    const url = new URL(vendor.uri);
    const host = url.hostname.toLowerCase();
    const at = domain => host === domain || host.endsWith(`.${domain}`);
    const query = name => url.searchParams.get(name);
    let source, id;
    if (at('qq.com')) {
      source = 'tencent';
      id = query('cid') || url.pathname.match(/\/(?:cover|detail)\/(?:[a-z]\/)?([a-zA-Z0-9]+)(?:\/|\.html|$)/)?.[1];
    } else if (at('iqiyi.com')) {
      source = 'iqiyi';
      id = query('tvid');
      if (id && type === 'movie') id = `movie_${id}`;
    } else if (at('youku.com')) {
      source = 'youku';
      id = query('showid') || url.pathname.match(/\/show_page\/id_([\w=]+)\.html/)?.[1];
    } else if (at('bilibili.com')) {
      source = 'bilibili';
      const season = query('season_id') || url.pathname.match(/\/(?:ss|season\/)(\d+)/)?.[1];
      if (season) id = `ss${season}`;
    } else if (at('mgtv.com')) {
      source = 'imgo';
      id = url.pathname.match(/\/b\/(\d+)\//)?.[1] || query('cid');
    }
    return source && id && /^[a-zA-Z0-9_=]+$/.test(id) ? { source, id } : null;
  } catch (_) {
    return null;
  }
}

export async function searchMedia(params) {
  const tmdbId = String(params.tmdbId ?? '');
  const type = params.type;
  if (!/^[1-9]\d*$/.test(tmdbId) || !['movie', 'tv'].includes(type) || typeof Widget.tmdb?.get !== 'function') return null;
  // Specials and invalid seasons must not silently resolve to season one.
  const season = type === 'tv' ? Number(params.season ?? 1) : null;
  if (type === 'tv' && (!Number.isSafeInteger(season) || season < 1)) return null;
  try {
    // Rex's adaptor requires a relative path; some Forward hosts expect '/'.
    // Try both within the same stage budget, without needing a player setting.
    let external;
    for (const prefix of ['', '/']) {
      try {
        external = dataOf(await widgetRequest(() => Widget.tmdb.get(`${prefix}${type}/${tmdbId}/external_ids`)));
        if (/^tt\d+$/.test(external?.imdb_id || '')) break;
      } catch (_) { /* Try the other host's path convention. */ }
    }
    let imdbId = external?.imdb_id;
    if (!/^tt\d+$/.test(imdbId || '')) {
      console.warn('[LogVar] 媒体资料身份不可用，回退标题搜索。');
      return null;
    }
    if (type === 'tv' && season > 1) {
      // IMDb identifies the series as a whole. Resolve the requested season's
      // first episode before asking Douban, as in the existing core TMDB source.
      const episodes = dataOf(await getImdbepisodes(imdbId, season));
      imdbId = episodes?.episodes?.find(ep => Number(ep.episodeNumber) === 1)?.id;
      if (!/^tt\d+$/.test(imdbId || '')) return null;
    }
    const info = dataOf(await getDoubanInfoByImdbId(imdbId));
    const doubanId = String(info?.id ?? '').match(/(?:^|\/)(\d+)\/?$/)?.[1];
    if (!doubanId) return null;
    const detail = dataOf(await getDoubanDetail(doubanId));
    if (!detail || typeof detail.title !== 'string' || !detail.title.trim() || !Array.isArray(detail.vendors)) return null;
    if (typeof detail.is_tv === 'boolean' && detail.is_tv !== (type === 'tv')) return null;
    const enabled = globals.sourceOrderArr;
    const vendors = [...new Map(detail.vendors.map(v => mediaVendor(v, type)).filter(v => v && enabled.includes(v.source))
      .map(v => [`${v.source}:${v.id}`, v])).values()];
    if (!vendors.length) return null;
    const tasks = enabled.map(source => {
      const startedAt = Date.now();
      const animes = [];
      const detailStore = markSearchDetails(new Map(), source);
      const promise = (async () => {
        const meta = getSourceMetaByKey(source);
        if (!meta) return;
        for (const vendor of vendors.filter(v => v.source === source)) {
          try {
            const seed = { provider: source, mediaId: vendor.id, title: detail.title,
              year: detail.year, type: type === 'movie' ? '电影' : '电视剧', imageUrl: detail.cover_url || info.image || '' };
            await meta.handleAdapter(meta.instance, [seed], detail.title, animes, detailStore, null);
          } catch (_) { /* Platform identity failure falls back to this source's title search. */ }
        }
        if (!animes.length) {
          const found = await meta.instance.search(detail.title);
          await meta.handleAdapter(meta.instance, found, detail.title, animes, detailStore, season);
        }
      })();
      return { key: source, startedAt, animes, detailStore, promise };
    });
    const settled = await collectSearch(tasks);
    const animes = [];
    const details = new Map();
    tasks.forEach((task, i) => {
      if (settled[i].status !== 'fulfilled') return;
      animes.push(...task.animes);
      for (const [key, value] of task.detailStore) details.set(key, value);
    });
    if (!animes.length) return null;
    await applyMergeLogic(animes, details);
    storeAnimeIdsToMap(animes, detail.title);
    return animes.map(({ links, ...anime }) => anime);
  } catch (_) {
    console.warn('[LogVar] 媒体资料匹配失败，回退标题搜索。');
    return null;
  }
}
