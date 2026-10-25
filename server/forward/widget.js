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
import { withStage, collectStage, widgetRequest, logTiming } from './stages.js';
import { getCached, putCached, clearModuleCache, beginCacheCallback, cacheEpoch, findPrepared, savePrepared } from './cache.js';
import { sha256 } from '../danmu_api/utils/codec-util.js';

const STATE_KEY = `${metadata.id}.state.v1`;
const EMPTY_ANIME_ID = '__empty__';
const DEFAULT_SOURCES = metadata.globalParams.find(p => p.name === 'enabledSources').value;
const ALIASES = { qq: 'tencent', qiyi: 'iqiyi', bilibili1: 'bilibili', mango: 'imgo' };
const DISPLAY_NAMES = { tencent: '腾讯', qq: '腾讯', renren: '人人', dandan: '弹弹', bilibili: 'B站', bilibili1: 'B站', qiyi: 'iqiyi', aiyifan: '爱壹帆' };
let loaded = false;
let previousConfig = '';
// The bundle also serializes host callbacks and creates a fresh core per call.
let pending = Promise.resolve();

export function displaySourceNames(title) {
  if (typeof title !== 'string') return title;
  const format = labels => labels.split(/[&＆]/).map(label =>
    Object.prototype.hasOwnProperty.call(DISPLAY_NAMES, label.trim()) ? DISPLAY_NAMES[label.trim()] : label).join('&');
  return title
    .replace(/(\bfrom\s+)([^\s]+)(\s*)$/, (_, prefix, labels, suffix) => prefix + format(labels) + suffix)
    .replace(/【([^】]+)】/g, (_, labels) => `【${format(labels)}】`);
}

// A series has no single winning source: each episode is compared separately.
// Until its raw comments are cached, most-mode episode labels stay blank.
export function displayModeTitle(title, mode = 'mergeAll', actualSource) {
  if (typeof title !== 'string') return title;
  const known = new Set([...Envs.MERGE_ALLOWED_SOURCES, ...Object.keys(DISPLAY_NAMES), ...Object.values(DISPLAY_NAMES)]);
  const label = text => {
    text = text.replace(/^合并：/, '').replace(/^取最多（候选：(.+)）$/, '$1');
    const sources = text.split(/[&＆]/).map(s => s.trim());
    if (!sources.length || sources.some(s => !known.has(s))) return null;
    if (actualSource) {
      const actual = actualSource.split('&');
      if (actual.every(s => known.has(s))) return actual.map(s => DISPLAY_NAMES[s] || s).join('&');
    }
    if (mode === 'most') return '';
    return sources.map(s => DISPLAY_NAMES[s] || s).join('&');
  };
  return title.replace(/(\bfrom\s+)([^\s]+)(\s*)$/, (match, prefix, sources, suffix) => {
    const value = label(sources);
    return value === null ? match : value ? prefix + value + suffix : suffix;
  }).replace(/【([^】]+)】/g, (match, sources) => {
    const value = label(sources);
    return value === null ? match : value ? `【${value}】` : '';
  }).trim();
}

function publicId(id, kind, params, displayedSource = '', token = '') {
  const digest = Array.from(sha256(encodeURIComponent(JSON.stringify([metadata.version, normalizeConfig(params), displayedSource]))),
    byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
  return `lv2:${kind}:${encodeURIComponent(String(id))}:${digest}:${cacheEpoch()}${token ? ':' + token : ''}`;
}

function originalId(value, kind) {
  const text = String(value ?? '');
  if (!text.startsWith('lv2:')) return value;
  const parts = text.split(':');
  if (![5,6].includes(parts.length) || parts[1] !== kind || !/^[a-f0-9]{24}$/.test(parts[3]) || !/^[a-z0-9-]+$/.test(parts[4]) || (parts[5] && !/^[a-z0-9-]+$/.test(parts[5])))
    throw new Error('弹幕选择 ID 无效，请重新搜索选集。');
  return decodeURIComponent(parts[2]);
}

async function displaySearchResult(result, params) {
  const animes = [];
  for (const anime of result.animes || []) {
    const prepared = await prepareCurrentEpisode(anime.animeId, params);
    const source = prepared?.source || (params.sourceMode === 'most' ? await loadedWorkSource(anime.animeId, params) : null);
    animes.push({ ...anime,
      animeId: anime.animeId === EMPTY_ANIME_ID ? EMPTY_ANIME_ID : publicId(anime.animeId, 'anime', params, source || '', prepared?.token),
      animeTitle: displayModeTitle(anime.animeTitle, params.sourceMode, source),
    });
  }
  return { ...result, animes };
}

function requestedEpisode(params, anime) {
  if (params.commentId !== undefined) {
    const id = Number(originalId(params.commentId, 'episode'));
    return anime.links?.find(link => link.id === id);
  }
  let number = Number(params.episode ?? params.episodeNumber);
  if (!Number.isSafeInteger(number) || number < 1) {
    for (const value of [params.episode, params.episodeNumber, params.episodeName, params.title]) {
      const name = String(value || '');
      const match = name.match(/第\s*(\d+)\s*[集话話回]/) || name.match(/\bS\d+E(\d+)\b/i);
      if (match) { number = Number(match[1]); break; }
    }
  }
  return Number.isSafeInteger(number) && number > 0 ? anime.links?.[number - 1] : null;
}

function preparedKey(url, title, params) {
  return JSON.stringify([JSON.stringify(normalizeConfig(params)), url, title]);
}

async function prepareCurrentEpisode(animeId, params) {
  const anime = globals.animes.find(a => String(a.animeId) === String(originalId(animeId, 'anime')));
  if (!anime) return null;
  const token = String(animeId || params.animeId || '').split(':')[5];
  const selected = token ? await findPrepared(token) : null;
  const episode = requestedEpisode(params, anime) || (selected && anime.links?.find(link => link.id === selected.episodeId));
  if (!episode) {
    if (token) throw new Error('预加载选择已过期，请重新搜索当前集。');
    console.warn('[LogVar] 无法预先确定来源：播放器未提供可识别的当前集号，或当前作品没有该集。');
    return null;
  }
  const key = preparedKey(episode.url, episode.title, params);
  let prepared = await findPrepared(key);
  if (!prepared?.comments?.length) prepared = await savePrepared(key, {
    ...await loadComments(episode.url, episode.title, params, true), episodeId: episode.id,
  });
  return prepared;
}

async function preparedComments(commentId, params) {
  const token = String(commentId || '').split(':')[5];
  if (!token) return null;
  const packet = await findPrepared(token);
  const id = Number(originalId(commentId, 'episode'));
  if (!packet || packet.episodeId !== id || packet.key !== preparedKey(findUrlById(id), findTitleById(id), params))
    throw new Error('预加载弹幕已过期或处理设置已改变，请重新搜索选集。');
  // Older versions could persist an empty prefetch. Let playback retry instead
  // of treating that transient failure as a completed ten-minute result.
  return packet.comments?.length ? packet.comments : null;
}

function workSourceKey(id, params) {
  return JSON.stringify(['comments', configKey(params), 'workSource', String(id)]);
}

async function loadedWorkSource(id, params) {
  const anime = globals.animes.find(a => String(a.animeId) === String(id));
  if (!anime) return null;
  let episode;
  if (params.commentId !== undefined) {
    const episodeId = Number(originalId(params.commentId, 'episode'));
    episode = (anime.links || []).find(link => link.id === episodeId);
  } else if (Number.isSafeInteger(Number(params.episode)) && Number(params.episode) > 0) {
    episode = anime.links?.[Number(params.episode) - 1];
  }
  if (params.commentId !== undefined || Number(params.episode) > 0)
    return episode ? cachedEpisodeSource(episode.url, episode.title, params) : null;
  const last = await getCached(workSourceKey(id, params), params);
  return last?.count > 0 && anime.links?.some(link => link.url === last.url) ? last.source : null;
}

async function rememberLoadedSource(url, params, selection) {
  if (params.sourceMode !== 'most') return;
  for (const anime of globals.animes) {
    if (!anime.links?.some(link => link.url === url)) continue;
    await putCached(workSourceKey(anime.animeId, params), {
      url, source: selection.source, count: selection.comments.length,
    }, 10 * 60 * 1000);
  }
}

function bestCommentSource(results) {
  const processed = results.map(result => ({
    ...result,
    comments: cleanComments(convertToDanmakuJson(normalizeSourceComments(result.comments, result.source), result.source)),
  }));
  processed.sort((a, b) => b.comments.length - a.comments.length || a.source.localeCompare(b.source));
  return processed[0];
}

async function cachedEpisodeSource(url, title, params) {
  if (!url) return null;
  const parts = ['comments', configKey(params), url, title];
  const results = await getCached(JSON.stringify(parts), params);
  if (!Array.isArray(results)) {
    const summary = await getCached(JSON.stringify([...parts, 'winner']), params);
    return summary?.count > 0 ? summary.source : null;
  }
  // getCached returns a copy. Use the same alignment, filtering and tie-breaking
  // as actual output, without shifting the stored raw comments a second time.
  alignSourceTimelines(results.map(r => r.comments), results.map(r => r.source), results.map(r => r.id));
  const best = bestCommentSource(results);
  return best?.comments.length ? best.source : null;
}

async function cacheUnstoredWinner(key, results, cachedRaw) {
  if (cachedRaw || !results.some(r => r.comments.length)) return;
  // A large full episode may exceed the raw cache cap; its compact result can
  // still label the loaded episode accurately. Clearing comments removes both.
  const best = bestCommentSource(results);
  await putCached(JSON.stringify([...JSON.parse(key), 'winner']),
    { source: best?.source, count: best?.comments.length || 0 }, 10 * 60 * 1000);
}

export function normalizeConfig(params = {}) {
  const sources = [...new Set((String(params.enabledSources ?? '').trim() || DEFAULT_SOURCES)
    .split(/[,，\s]+/).filter(Boolean).map(key => ALIASES[key] || key).filter(key => key !== 'aiyifan'))].sort();
  if (!sources.length || sources.some(key => !Envs.MERGE_ALLOWED_SOURCES.includes(key))) {
    throw new Error('启用来源为空或包含不支持的名称，请检查模块配置。');
  }
  const mode = params.sourceMode || 'mergeAll';
  if (!['mergeAll', 'most'].includes(mode)) throw new Error('不支持的弹幕处理方式。');
  const minutes = Number(String(params.groupMinute ?? '').trim() || '1');
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

function state() {
  return { animes: globals.animes, episodeIds: globals.episodeIds, episodeNum: globals.episodeNum };
}

function restoreCachedState(saved) {
  if (!saved || !Array.isArray(saved.animes) || !Array.isArray(saved.episodeIds) || !Number.isSafeInteger(saved.episodeNum)) return false;
  const current = new Map(globals.episodeIds.map(e => [e.id, e]));
  if (saved.episodeIds.some(e => current.has(e.id) && current.get(e.id).url !== e.url)) return false;
  for (const episode of saved.episodeIds) current.set(episode.id, episode);
  globals.episodeIds = [...current.values()];
  const animes = new Map(globals.animes.map(a => [String(a.animeId), a]));
  for (const anime of saved.animes) animes.set(String(anime.animeId), anime);
  globals.animes = [...animes.values()].slice(-100);
  globals.episodeNum = Math.max(globals.episodeNum, saved.episodeNum);
  return true;
}

function keepReturnedState(before, animes) {
  // Sources may have committed some titles before their entire pipeline expired.
  // Persist only returned identities; unfinished/late titles cannot leak into cache.
  const ids = new Set(animes.map(a => String(a.animeId)));
  const accepted = globals.animes.filter(a => ids.has(String(a.animeId)));
  globals.animes = [...before.animes.filter(a => !ids.has(String(a.animeId))), ...accepted].slice(-100);
  const episodes = new Set([...before.episodeIds.map(e => e.id), ...accepted.flatMap(a => a.links || []).map(e => e.id)]);
  globals.episodeIds = globals.episodeIds.filter(e => episodes.has(e.id));
}

function configKey(params) {
  const { MAX_DANMU_SOURCE, ...config } = normalizeConfig(params);
  return JSON.stringify(config);
}

function run(params, operation) {
  const task = pending.then(async () => {
    if (await beginCacheCallback()) {
      globals.searchCache.clear();
      globals.commentCache.clear();
    }
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
    const key = JSON.stringify(['search', configKey(params), title, params.tmdbId, params.type, params.season]);
    const cached = await getCached(key, params);
    if (cached && restoreCachedState(cached.state)) return displaySearchResult(cached.result, params);
    const before = { animes: [...globals.animes], episodeIds: [...globals.episodeIds] };
    const result = await withStage('search', async () => {
      const matched = /^https?:\/\//i.test(title) ? null : await searchMedia(params);
      if (matched !== null) return { animes: matched };
      if (!title) return { animes: [] };
      // Routing argument only; no HTTP server is started.
      const query = `keyword=${encodeURIComponent(title)}${params.season ? `&season=${encodeURIComponent(params.season)}` : ''}`;
      return (await searchAnime(new URL(`https://logvar.invalid/api/v2/search/anime?${query}`))).json();
    }, { animes: [] });
    if (result.success === false) throw new Error(result.errorMessage || '弹幕搜索失败。');
    keepReturnedState(before, result.animes || []);
    const animes = (result.animes || []).map(anime => ({
      ...anime, animeTitle: displaySourceNames(anime.animeTitle),
    }));
    const response = { animes: animes.length || !title ? animes : [{ animeId: EMPTY_ANIME_ID, animeTitle: '😭 未匹配到资源' }] };
    if (animes.length) await putCached(key, { result: response, state: state() }, 30 * 60 * 1000);
    return displaySearchResult(response, params);
  });
}

export function getDetailById(params = {}) {
  if (params.animeId === EMPTY_ANIME_ID) return Promise.resolve(null);
  return run(params, async () => {
    if (params.animeId === undefined || params.animeId === null) return [];
    const result = await (await getBangumi(`https://logvar.invalid/api/v2/bangumi/${originalId(params.animeId, 'anime')}`)).json();
    if (!result.bangumi) throw new Error('分集信息已失效，请重新搜索弹幕。');
    const packet = await prepareCurrentEpisode(params.animeId, params);
    const episodes = [];
    for (const episode of result.bangumi.episodes || []) {
      const id = Number(episode.episodeId);
      const ready = packet?.episodeId === id ? packet : null;
      const source = ready ? ready.source : params.sourceMode === 'most'
        ? await cachedEpisodeSource(findUrlById(id), findTitleById(id), params) : null;
      episodes.push({ ...episode, episodeId: publicId(id, 'episode', params, source || '', ready?.token), episodeTitle: displayModeTitle(episode.episodeTitle, params.sourceMode, source) });
    }
    return episodes;
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

function selectCommentResult(sourceResults, mode) {
  // The exact same comparison is used to label a loaded episode on re-entry.
  if (mode === 'most') {
    const best = bestCommentSource(sourceResults);
    return { comments: best?.comments || [], source: best?.comments.length ? best.source : null };
  }
  sourceResults = sourceResults.map(result => ({ ...result, comments: normalizeSourceComments(result.comments, result.source) }));
  const combined = sourceResults.flatMap(result => result.comments.map(item => ({ ...item, _sourceLabel: result.source })));
  const sources = [...new Set(sourceResults.filter(result =>
    cleanComments(convertToDanmakuJson(result.comments, result.source)).length > 0).map(result => result.source))];
  return { comments: cleanComments(convertToDanmakuJson(combined, sourceResults.map(result => result.source).join('＆'))), source: sources.join('&') || null };
}

export function selectComments(sourceResults, mode) {
  return selectCommentResult(sourceResults, mode).comments;
}

export async function loadComments(url, title, params = {}, selectionOnly = false) {
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
  const key = JSON.stringify(['comments', configKey(params), url, title]);
  let results = await getCached(key, params);
  const fromCache = results !== null;
  if (!results) results = await withStage('comments', async () => {
    const tasks = unique.map(part => ({ key: part.source, startedAt: Date.now(), promise: (async () => {
    try {
      const instance = getSourceByKey(part.source);
      if (!instance) return { ...part, comments: [] };
      const rawId = part.id.startsWith(`${part.source}:`) ? part.id.slice(part.source.length + 1) : part.id;
      const meta = stripLinkOffset(rawId);
      let id = meta.cleanUrl;
      if (part.source === 'bilibili' && /^https?:\/\/b23\.tv\//i.test(id)) {
        const response = await widgetRequest(options => Widget.http.get(id, options), { allow_redirects: false });
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
      return { ...part, comments: [], failed: true };
    }
    })() }));
    const settled = await collectStage(tasks, (_, result) =>
      cleanComments(convertToDanmakuJson(result.comments, result.source)).length > 0);
    return settled.flatMap(item => item.status === 'fulfilled' ? [item.value] : []);
  }, []);
  if (fromCache) console.log('[LogVar耗时] ' + JSON.stringify({ phase: 'comments-cache', hit: true, sources: results.map(result => result.source) }));
  // Cache pre-alignment source data so each strategy operates on the same raw
  // batch, without aligning an already shifted cache entry for a second time.
  let cachedRaw = fromCache;
  if (!fromCache && results.some(result => result.comments.length)) cachedRaw = await putCached(key, results, 10 * 60 * 1000);
  const alignStarted = Date.now();
  alignSourceTimelines(results.map(result => result.comments), results.map(result => result.source), results.map(result => result.id));
  logTiming('align', alignStarted);
  await cacheUnstoredWinner(key, results, cachedRaw);
  const selectionStarted = Date.now();
  const selection = selectCommentResult(results, globals.maxDanmuSource ? 'most' : 'mergeAll');
  logTiming(globals.maxDanmuSource ? 'compare' : 'merge', selectionStarted, { count: selection.comments.length, source: selection.source });
  await rememberLoadedSource(url, params, selection);
  return selectionOnly ? selection : selection.comments;
}

export function getCommentsById(params = {}) {
  if ((params.commentId ?? params.animeId) === EMPTY_ANIME_ID) return Promise.resolve(null);
  return run(params, async () => {
    const id = Number(originalId(params.commentId, 'episode'));
    if (!Number.isSafeInteger(id)) throw new Error('弹幕分集 ID 无效，请重新选集。');
    const url = findUrlById(id);
    if (!url) throw new Error('分集缓存已失效，请重新搜索并选集。');
    const comments = await preparedComments(params.commentId, params) || await loadComments(url, findTitleById(id), params);
    return { count: comments.length, comments };
  });
}

export async function clearDanmuCache() {
  const result = await clearModuleCache();
  globals.searchCache.clear();
  globals.commentCache.clear();
  return [{ id: 'logvar-cache-cleared', type: 'url', title: '✅ 弹幕缓存已清理',
    description: `已校验删除 ${result.removed} 项缓存，已清理搜索结果、预加载弹幕、已下载弹幕和来源标签记录，并更新刷新标记。请重新搜索并选择该集。` }];
}
