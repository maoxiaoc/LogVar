// SPDX-License-Identifier: AGPL-3.0-only
import metadata from './metadata.js';
import { searchMedia } from './media-match.js';
export { mediaVendor } from './media-match.js';
import { Globals, globals } from '../danmu_api/configs/globals.js';
import { Envs } from '../danmu_api/configs/envs.js';
import { searchAnime, getBangumi } from '../danmu_api/apis/dandan-api.js';
import { findUrlById, findTitleById } from '../danmu_api/utils/cache-util.js';
import { getSourceByKey } from '../danmu_api/sources/registry.js';
import { extractEpisodeTitle } from '../danmu_api/utils/common-util.js';
import { convertToDanmakuJson } from '../danmu_api/utils/danmu-util.js';
import { MERGE_DELIMITER, alignSourceTimelines } from '../danmu_api/utils/merge-util.js';
import { stripLinkOffset, applyOffset } from '../danmu_api/utils/offset-util.js';

const STATE_KEY = `${metadata.id}.state.v1`;
const EMPTY_ANIME_ID = '__empty__';
const DEFAULT_SOURCES = metadata.globalParams.find(p => p.name === 'enabledSources').value;
const ALIASES = { qq: 'tencent', qiyi: 'iqiyi', bilibili1: 'bilibili', mango: 'imgo' };
const DISPLAY_NAMES = { tencent: '腾讯', qq: '腾讯', renren: '人人', dandan: '弹弹', bilibili: 'B站', bilibili1: 'B站', qiyi: 'iqiyi' };
let loaded = false;
let previousConfig = '';
// ponytail: serialize callbacks because the reused source core holds mutable global config.
// Separate per-call core instances only if the host needs parallel episode requests.
let pending = Promise.resolve();

export function displaySourceNames(title) {
  if (typeof title !== 'string') return title;
  const format = labels => labels.split(/[&＆]/).map(label =>
    Object.prototype.hasOwnProperty.call(DISPLAY_NAMES, label.trim()) ? DISPLAY_NAMES[label.trim()] : label).join('&');
  return title
    .replace(/(\bfrom\s+)([^\s]+)(\s*)$/, (_, prefix, labels, suffix) => prefix + format(labels) + suffix)
    .replace(/【([^】]+)】/g, (_, labels) => `【${format(labels)}】`);
}

export function normalizeConfig(params = {}) {
  const sources = [...new Set(String(params.enabledSources ?? DEFAULT_SOURCES)
    .split(/[,，\s]+/).filter(Boolean).map(key => ALIASES[key] || key))].sort();
  if (!sources.length || sources.some(key => !Envs.MERGE_ALLOWED_SOURCES.includes(key))) {
    throw new Error('启用来源为空或包含不支持的名称，请检查模块配置。');
  }
  const mode = params.sourceMode || 'mergeAll';
  if (!['mergeAll', 'most'].includes(mode)) throw new Error('不支持的弹幕处理方式。');
  const minutes = Number(params.groupMinute ?? 1);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 30) throw new Error('去重间隔应为 0～30 分钟。');
  return {
    SOURCE_ORDER: sources.join(','),
    MERGE_SOURCE_PAIRS: sources.length > 1 ? sources.join('&') : '',
    MAX_DANMU_SOURCE: String(mode === 'most'),
    PLATFORM_ORDER: '',
    BILIBILI_COOKIE: String(params.bilibiliCookie || ''),
    BLOCKED_WORDS: String(params.blockedWords || ''),
    GROUP_MINUTE: String(minutes),
    DANMU_LIMIT: '0',
    OTHER_SERVER: 'disabled',
    LOG_LEVEL: 'warn',
    USE_BANGUMI_DATA: 'false',
    REMEMBER_LAST_SELECT: 'false',
    MAX_ANIMES: '100',
  };
}

async function restoreState() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await Widget.storage.get(STATE_KEY);
    if (!stored) return;
    const state = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!Array.isArray(state.animes) || !Array.isArray(state.episodeIds) || !Number.isSafeInteger(state.episodeNum)) return;
    globals.animes = state.animes;
    globals.episodeIds = state.episodeIds;
    globals.episodeNum = state.episodeNum;
  } catch (_) {
    console.warn('[LogVar] 忽略损坏的分集缓存，请重新搜索。');
  }
}

async function saveState() {
  try {
    await Widget.storage.set(STATE_KEY, JSON.stringify({
      animes: globals.animes,
      episodeIds: globals.episodeIds,
      episodeNum: globals.episodeNum,
    }));
  } catch (_) {
    console.warn('[LogVar] 无法保存分集缓存，脚本重载后需要重新搜索。');
  }
}

function run(params, operation) {
  const task = pending.then(async () => {
    const env = normalizeConfig(params);
    const config = JSON.stringify(env);
    Globals.init(env);
    globals.deployPlatform = 'forward';
    if (previousConfig !== config) {
      globals.searchCache.clear();
      globals.commentCache.clear();
      previousConfig = config;
    }
    await restoreState();
    const result = await operation();
    await saveState();
    return result;
  });
  pending = task.catch(() => {});
  return task;
}

export function searchDanmu(params = {}) {
  return run(params, async () => {
    const title = String(params.title || params.seriesName || '').trim();
    const matched = /^https?:\/\//i.test(title) ? null : await searchMedia(params);
    if (matched?.length) return { animes: matched.map(anime => ({ ...anime, animeTitle: displaySourceNames(anime.animeTitle) })) };
    if (!title) return { animes: [] };
    // This URL is an in-memory routing argument to the existing core. No HTTP
    // request is made to it and no local server is started.
    const query = `keyword=${encodeURIComponent(title)}${params.season ? `&season=${encodeURIComponent(params.season)}` : ''}`;
    const result = await (await searchAnime(new URL(`https://logvar.invalid/api/v2/search/anime?${query}`))).json();
    if (result.success === false) throw new Error(result.errorMessage || '弹幕搜索失败。');
    const animes = (result.animes || []).map(anime => ({
      ...anime, animeTitle: displaySourceNames(anime.animeTitle),
    }));
    return { animes: animes.length ? animes : [{ animeId: EMPTY_ANIME_ID, animeTitle: '😭 未匹配到资源' }] };
  });
}

export function getDetailById(params = {}) {
  if (params.animeId === EMPTY_ANIME_ID) return Promise.resolve(null);
  return run(params, async () => {
    if (params.animeId === undefined || params.animeId === null) return [];
    const result = await (await getBangumi(`https://logvar.invalid/api/v2/bangumi/${params.animeId}`)).json();
    if (!result.bangumi) throw new Error('分集信息已失效，请重新搜索弹幕。');
    return (result.bangumi.episodes || []).map(episode => ({
      ...episode, episodeTitle: displaySourceNames(episode.episodeTitle),
    }));
  });
}

export function cleanComments(comments) {
  const seen = new Set();
  return (Array.isArray(comments) ? comments : []).filter(item => {
    if (!item || typeof item.p !== 'string' || typeof item.m !== 'string' || !item.m.trim()) return false;
    const stamp = item.p.split(',')[0];
    if (!stamp.trim()) return false;
    const time = Number(stamp);
    if (!Number.isFinite(time) || time < 0) return false;
    const key = `${time.toFixed(2)}:${item.m.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(a.p.split(',')[0]) - Number(b.p.split(',')[0]));
}

export function normalizeSourceComments(comments, source) {
  return (Array.isArray(comments) ? comments : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    let p = item.p;
    let text = item.m;
    if (typeof p !== 'string') {
      const time = item.progress !== undefined ? Number(item.progress) / 1000 : Number(item.timepoint);
      if (!Number.isFinite(time)) return [];
      p = [time, item.mode ?? item.ct ?? 1, item.color ?? 16777215, `[${source}]`].join(',');
      text = item.content;
    }
    const stamp = p.split(',')[0];
    if (!stamp.trim() || !Number.isFinite(Number(stamp)) || Number(stamp) < 0 || typeof text !== 'string' || !text.trim()) return [];
    return [{ p, m: text, cid: item.cid, like: item.like, color_v2: item.color_v2,
      _sourceLabel: item._sourceLabel || source, realTimeSource: item.realTimeSource }];
  });
}

export function selectComments(sourceResults, mode) {
  sourceResults = sourceResults.map(result => ({ ...result, comments: normalizeSourceComments(result.comments, result.source) }));
  const processed = sourceResults.map(result => ({
    ...result, comments: cleanComments(convertToDanmakuJson(result.comments, result.source)),
  }));
  if (mode === 'most') {
    // Compare full-episode, filtered, deduplicated data. Lexical tie-breaking
    // makes equal counts independent of request completion or input order.
    processed.sort((a, b) => b.comments.length - a.comments.length || a.source.localeCompare(b.source));
    return processed[0]?.comments || [];
  }
  const combined = sourceResults.flatMap(result => result.comments.map(item => ({ ...item, _sourceLabel: result.source })));
  return cleanComments(convertToDanmakuJson(combined, sourceResults.map(result => result.source).join('＆')));
}

export async function loadComments(url, title) {
  const enabled = new Set(globals.sourceOrderArr);
  const parts = url.includes(MERGE_DELIMITER)
    ? url.split(MERGE_DELIMITER).map(part => {
      const colon = part.indexOf(':');
      return { source: part.slice(0, colon), id: part.slice(colon + 1) };
    })
    : [{ source: extractEpisodeTitle(title || ''), id: url }];
  const unique = [...new Map(parts.map(part => {
    part.source = ALIASES[part.source] || part.source;
    return [`${part.source}:${part.id}`, part];
  })).values()].filter(part => enabled.has(part.source));
  const results = await Promise.all(unique.map(async part => {
    try {
      const instance = getSourceByKey(part.source);
      if (!instance) return { ...part, comments: [] };
      const rawId = part.id.startsWith(`${part.source}:`) ? part.id.slice(part.source.length + 1) : part.id;
      const meta = stripLinkOffset(rawId);
      let id = meta.cleanUrl;
      if (part.source === 'bilibili' && /^https?:\/\/b23\.tv\//i.test(id)) {
        const response = await Widget.http.get(id, { allow_redirects: false, timeout: 15000 });
        const location = response.headers?.location || response.headers?.Location;
        if (location) id = new URL(location, id).toString();
      }
      const raw = await instance.getEpisodeDanmu(id, url.split(MERGE_DELIMITER));
      const valid = normalizeSourceComments(instance.formatComments(raw), part.source);
      const duration = valid.reduce((max, item) => Math.max(max, Number(item.p.split(',')[0])), 1);
      const comments = meta.offset ? applyOffset(valid, meta.offset, { usePercent: meta.percent, videoDuration: duration }) : valid;
      return { ...part, comments };
    } catch (_) {
      console.warn(`[LogVar] ${part.source} 获取失败，继续使用其他来源。`);
      return { ...part, comments: [] };
    }
  }));
  alignSourceTimelines(results.map(result => result.comments), results.map(result => result.source), results.map(result => result.id));
  return selectComments(results, globals.maxDanmuSource ? 'most' : 'mergeAll');
}

export function getCommentsById(params = {}) {
  if ((params.commentId ?? params.animeId) === EMPTY_ANIME_ID) return Promise.resolve(null);
  return run(params, async () => {
    const id = Number(params.commentId);
    if (!Number.isSafeInteger(id)) throw new Error('弹幕分集 ID 无效，请重新选集。');
    const url = findUrlById(id);
    if (!url) throw new Error('分集缓存已失效，请重新搜索并选集。');
    const comments = await loadComments(url, findTitleById(id));
    return { count: comments.length, comments };
  });
}
