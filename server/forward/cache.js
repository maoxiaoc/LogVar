// SPDX-License-Identifier: AGPL-3.0-only
import metadata from './metadata.js';

const KEY = `${metadata.id}.cache.v1`;
const EPOCH_KEY = `${metadata.id}.cache.epoch.v1`;
const PREPARED_KEY = `${metadata.id}.prepared.v1`;
const MAX_CHARS = 2000000;
let entries;
let prepared;
let epoch = '0';
export const cacheEpoch = () => epoch;
export async function beginCacheCallback() {
  entries = undefined;
  prepared = undefined;
  const next = String(await Widget.storage.get(EPOCH_KEY) || '0');
  const changed = next !== epoch;
  epoch = next;
  return changed;
}

async function loadPrepared() {
  if (prepared) return;
  const raw = await Widget.storage.get(PREPARED_KEY);
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {}
  prepared = Array.isArray(data) ? data.filter(p => p.epoch === epoch && p.expires > Date.now()) : [];
}

export async function findPrepared(keyOrToken) {
  await loadPrepared();
  const item = prepared.find(p => (p.key === keyOrToken || p.token === keyOrToken) && p.expires > Date.now());
  return item ? clone(item) : null;
}

export async function savePrepared(key, selection) {
  if (!Array.isArray(selection.comments) || !selection.comments.length) return null;
  if (String(await Widget.storage.get(EPOCH_KEY) || '0') !== epoch) throw new Error('弹幕缓存已清理，请重新搜索选集。');
  await loadPrepared();
  const item = { key, ...clone(selection), epoch, expires: Date.now() + 600000,
    token: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) };
  if (JSON.stringify(item).length > 8000000) throw new Error('当前集弹幕过大，无法保留预加载结果。');
  prepared = [...prepared.filter(p => p.key !== key), item].slice(-4);
  while (JSON.stringify(prepared).length > 8000000) prepared.shift();
  await Widget.storage.set(PREPARED_KEY, JSON.stringify(prepared));
  const stored = await Widget.storage.get(PREPARED_KEY);
  const checked = typeof stored === 'string' ? JSON.parse(stored) : stored;
  if (!Array.isArray(checked) || !checked.some(p => p.token === item.token)) throw new Error('预加载弹幕存储校验失败。');
  return item;
}

const clone = value => JSON.parse(JSON.stringify(value));
export const bypassCache = params => params.cacheMode === 'refresh' || params.refresh === true || params.forceRefresh === true;

async function load() {
  if (entries) return;
  try {
    const raw = await Widget.storage.get(KEY);
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    entries = Array.isArray(data) ? data.filter(e => e && typeof e.key === 'string' && e.expires > Date.now()
      && String(e.epoch || '0') === epoch) : [];
  } catch (_) { entries = []; }
}

export async function getCached(key, params) {
  if (bypassCache(params)) return null;
  await load();
  const item = entries.find(e => e.key === key && e.expires > Date.now());
  return item ? clone(item.value) : null;
}

export async function putCached(key, value, ttl) {
  if (String(await Widget.storage.get(EPOCH_KEY) || '0') !== epoch) return false;
  await load();
  const item = { key, expires: Date.now() + ttl, value: clone(value), epoch };
  if (JSON.stringify(item).length > MAX_CHARS) return false;
  entries = [...entries.filter(e => e.key !== key && e.expires > Date.now()), item].slice(-8);
  while (JSON.stringify(entries).length > MAX_CHARS) entries.shift();
  try { await Widget.storage.set(KEY, JSON.stringify(entries)); return true; }
  catch (_) { console.warn('[LogVar] 缓存保存失败，本次结果仍可使用。'); return false; }
}

export async function clearModuleCache() {
  await beginCacheCallback();
  await load();
  await loadPrepared();
  const removed = entries.length + prepared.length;
  // Invalidate old callbacks before deleting data. All entry types carry an
  // epoch, so an old search cannot restore valid results after this operation.
  const next = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  await Widget.storage.set(EPOCH_KEY, next);
  if (await Widget.storage.get(EPOCH_KEY) !== next) throw new Error('弹幕缓存刷新标记校验失败，存储写入未生效。');
  epoch = next;
  entries = [];
  // Surface storage failures: never report success if the cache wasn't cleared.
  await Widget.storage.set(KEY, JSON.stringify(entries));
  const raw = await Widget.storage.get(KEY);
  let saved;
  try { saved = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {}
  if (!Array.isArray(saved) || saved.length) throw new Error('模块缓存清理校验失败，存储写入未生效。');
  await Widget.storage.set(PREPARED_KEY, '[]');
  const checkedPrepared = await Widget.storage.get(PREPARED_KEY);
  if (JSON.stringify(typeof checkedPrepared === 'string' ? JSON.parse(checkedPrepared) : checkedPrepared) !== '[]')
    throw new Error('预加载弹幕清理校验失败。');
  prepared = [];
  console.log('[LogVar缓存] ' + JSON.stringify({action:'clear',removed,verified:true,
    cleared:['search','prepared','comments','sourceLabels'],epoch:next}));
  return { removed, verified: true };
}
