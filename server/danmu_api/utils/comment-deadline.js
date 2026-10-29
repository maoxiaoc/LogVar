import { convertToDanmakuJson } from './danmu-util.js';

// Match the player's definition of a usable comment before starting its grace window.
export function hasVisibleComments(comments, source = '') {
  const normalized = (Array.isArray(comments) ? comments : []).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    let p = item.p, text = item.m;
    if (typeof p !== 'string') {
      const time = item.progress !== undefined ? Number(item.progress) / 1000 : Number(item.timepoint);
      if (!Number.isFinite(time)) return [];
      p = [time, item.mode ?? item.ct ?? 1, item.color ?? 16777215, source].join(',');
      text = item.content;
    }
    const stamp = p.split(',')[0];
    if (!stamp.trim() || !Number.isFinite(Number(stamp)) || Number(stamp) < 0 || typeof text !== 'string' || !text.trim()) return [];
    return [{ ...item, p, m: text }];
  });
  if (!normalized.length) return false;
  return convertToDanmakuJson(normalized, source).some(item => {
    const stamp = typeof item?.p === 'string' ? item.p.split(',')[0] : '';
    return stamp.trim() && Number.isFinite(Number(stamp)) && Number(stamp) >= 0 && typeof item.m === 'string' && item.m.trim();
  });
}

// Groups preserve same-source throttling; results are indexed by original source order.
export async function collectCommentGroups(groups, count, limit, {graceMs = 10000, totalMs = 30000, gapMs = 1000, isReady = hasVisibleComments} = {}) {
  const startedAt = Date.now(), values = Array.from({length: count}, () => []);
  let next = 0, completed = 0, ended = false, first = false, timer;
  return new Promise(resolve => {
    const finish = timeout => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      resolve({values, partial: timeout && completed < count});
    };
    timer = setTimeout(() => finish(true), totalMs);
    if (!count) return finish(false);
    const worker = async () => {
      while (!ended && next < groups.length) {
        const group = groups[next++];
        for (let i = 0; i < group.length && !ended; i++) {
          let result;
          try { result = await group[i].factory(); } catch { result = []; }
          if (ended) return;
          const data = Array.isArray(result) ? result : [];
          values[group[i].index] = data; completed++;
          let ready = false;
          if (!first && data.length) { try { ready = isReady(data); } catch { ready = false; } }
          if (ready) {
            first = true; clearTimeout(timer);
            timer = setTimeout(() => finish(true), Math.min(graceMs, Math.max(0, totalMs - (Date.now() - startedAt))));
          }
          if (completed === count) return finish(false);
          if (i + 1 < group.length && !ended) await new Promise(r => setTimeout(r, gapMs));
        }
      }
    };
    for (let i = 0; i < Math.min(limit, groups.length); i++) void worker();
  });
}

// The late operation is detached from the response and cannot mutate its result.
export async function fetchSingleComments(operation, {segment = false, totalMs = 30000} = {}) {
  const scope = { expired: false };
  if (segment || globalThis.__FORWARD_WIDGET__ === true) return operation(scope);
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { scope.expired = true; resolve([]); }, totalMs); });
  try { return await Promise.race([Promise.resolve().then(() => operation(scope)), timeout]); }
  finally { clearTimeout(timer); }
}
